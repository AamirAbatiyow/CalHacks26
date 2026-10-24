//! Tests for Ground Truth authority and confidence gate.
//!
//! These tests verify:
//! - Cedar policy evaluation correctness
//! - AI analyst cannot exceed authority (forbidden actions rejected)
//! - Confidence gate routing works correctly
//! - Human approvers can approve/deny escalated claims

#[cfg(test)]
mod authority_tests {
    use crate::authority::{evaluate_authorization, get_default_policy_text, AuthzDecision};

    const POLICY_VERSION: &str = "test-1.0.0";

    #[test]
    fn test_ai_analyst_auto_approve_under_cap() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_001",
            25000, // $250 - under $300 cap
            96,    // 96% confidence - above 95% threshold
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "AI analyst should be able to auto-approve claims under $300 with >=95% confidence"
        );
    }

    #[test]
    fn test_ai_analyst_forbidden_auto_approve_over_cap() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_002",
            50000, // $500 - over $300 cap
            98,    // High confidence
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Deny,
            "AI analyst should NOT be able to auto-approve claims over $300"
        );
    }

    #[test]
    fn test_ai_analyst_forbidden_edit_policy() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "edit_policy",
            "Policy",
            "policy_v1",
            0,
            100,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Deny,
            "AI analyst should NEVER be able to edit policies"
        );
    }

    #[test]
    fn test_ai_analyst_forbidden_low_confidence() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_003",
            15000, // Under cap
            90,    // Below 95% threshold
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Deny,
            "AI analyst should NOT auto-approve with confidence below 95%"
        );
    }

    #[test]
    fn test_ai_analyst_can_recommend() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "recommend_approval",
            "Claim",
            "claim_004",
            100000, // Large amount
            50,     // Low confidence
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "AI analyst should be able to recommend approval for any claim"
        );
    }

    #[test]
    fn test_ai_analyst_can_escalate() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "escalate",
            "Claim",
            "claim_005",
            50000,
            40,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "AI analyst should be able to escalate claims"
        );
    }

    #[test]
    fn test_human_approver_can_approve() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "human_approver",
            "approve",
            "Claim",
            "claim_006",
            500000, // Large amount
            60,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "Human approver should be able to approve any claim"
        );
    }

    #[test]
    fn test_human_approver_can_deny() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "human_approver",
            "deny",
            "Claim",
            "claim_007",
            100000,
            70,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "Human approver should be able to deny claims"
        );
    }

    #[test]
    fn test_human_approver_forbidden_edit_policy() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "human_approver",
            "edit_policy",
            "Policy",
            "policy_v2",
            0,
            100,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Deny,
            "Human approver should NOT be able to edit policies"
        );
    }

    #[test]
    fn test_system_admin_can_edit_policy() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "system_admin",
            "edit_policy",
            "Policy",
            "policy_v3",
            0,
            100,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "System admin should be able to edit policies"
        );
    }

    #[test]
    fn test_system_admin_full_authority() {
        let policy = get_default_policy_text();

        let actions = vec!["auto_approve", "approve", "deny", "escalate", "edit_policy"];
        for action in actions {
            let result = evaluate_authorization(
                policy,
                POLICY_VERSION,
                "system_admin",
                action,
                if action == "edit_policy" {
                    "Policy"
                } else {
                    "Claim"
                },
                "resource_001",
                1000000,
                100,
            );

            assert_eq!(
                result.decision,
                AuthzDecision::Allow,
                "System admin should have full authority for action: {}",
                action
            );
        }
    }

    #[test]
    fn test_unknown_actor_denied() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "unknown_actor",
            "approve",
            "Claim",
            "claim_008",
            10000,
            90,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Deny,
            "Unknown actors should be denied by default"
        );
    }
}

#[cfg(test)]
mod confidence_gate_tests {
    use crate::confidence_gate::{
        determine_route, DecisionRoute, CONFIDENCE_AUTO_APPROVE_THRESHOLD,
        CONFIDENCE_HUMAN_APPROVE_THRESHOLD, COST_FLOOR_AUTO_REVIEW_CENTS,
    };

    #[test]
    fn test_route_auto_approve_high_confidence_low_amount() {
        let route = determine_route(96, 20000); // 96% confidence, $200
        assert_eq!(
            route,
            DecisionRoute::AutoApprove,
            "High confidence + low amount should route to auto-approve"
        );
    }

    #[test]
    fn test_route_auto_approve_threshold_exactly_95() {
        let route = determine_route(95, 29999); // Exactly 95%, just under $300
        assert_eq!(
            route,
            DecisionRoute::AutoApprove,
            "Exactly 95% confidence with amount under $300 should auto-approve"
        );
    }

    #[test]
    fn test_route_human_approval_high_confidence_high_amount() {
        let route = determine_route(97, 50000); // 97% confidence, $500
        assert_eq!(
            route,
            DecisionRoute::HumanApproval,
            "High confidence + amount over $300 should require human approval"
        );
    }

    #[test]
    fn test_route_human_approval_medium_confidence() {
        let route = determine_route(85, 15000); // 85% confidence, $150
        assert_eq!(
            route,
            DecisionRoute::HumanApproval,
            "Medium confidence (80-95%) should require human approval"
        );
    }

    #[test]
    fn test_route_escalation_low_confidence() {
        let route = determine_route(79, 10000); // 79% confidence
        assert_eq!(
            route,
            DecisionRoute::Escalated,
            "Confidence below 80% should escalate"
        );
    }

    #[test]
    fn test_route_escalation_very_low_confidence() {
        let route = determine_route(40, 5000); // 40% confidence
        assert_eq!(
            route,
            DecisionRoute::Escalated,
            "Very low confidence should escalate"
        );
    }

    #[test]
    fn test_route_escalation_medium_confidence_high_amount() {
        let route = determine_route(85, 50000); // 85% confidence, $500
        assert_eq!(
            route,
            DecisionRoute::Escalated,
            "Medium confidence + high amount should escalate"
        );
    }

    #[test]
    fn test_route_boundary_80_percent() {
        let route_at_80 = determine_route(80, 20000);
        let route_below_80 = determine_route(79, 20000);

        assert_eq!(
            route_at_80,
            DecisionRoute::HumanApproval,
            "Exactly 80% confidence should require human approval"
        );
        assert_eq!(
            route_below_80,
            DecisionRoute::Escalated,
            "Below 80% confidence should escalate"
        );
    }

    #[test]
    fn test_route_boundary_300_dollars() {
        let route_under = determine_route(96, 29999);
        let route_at = determine_route(96, 30000);
        let route_over = determine_route(96, 30001);

        assert_eq!(
            route_under,
            DecisionRoute::AutoApprove,
            "Under $300 with high confidence should auto-approve"
        );
        assert_eq!(
            route_at,
            DecisionRoute::AutoApprove,
            "At exactly $300 with high confidence should auto-approve"
        );
        assert_eq!(
            route_over,
            DecisionRoute::HumanApproval,
            "Over $300 should require human approval even with high confidence"
        );
    }

    #[test]
    fn test_constants_match_spec() {
        assert_eq!(
            CONFIDENCE_AUTO_APPROVE_THRESHOLD, 95,
            "Auto-approve threshold should be 95%"
        );
        assert_eq!(
            CONFIDENCE_HUMAN_APPROVE_THRESHOLD, 80,
            "Human approval threshold should be 80%"
        );
        assert_eq!(
            COST_FLOOR_AUTO_REVIEW_CENTS, 30000,
            "Cost floor should be $300 (30000 cents)"
        );
    }
}

#[cfg(test)]
mod integration_tests {
    use crate::authority::{evaluate_authorization, get_default_policy_text, AuthzDecision};
    use crate::confidence_gate::determine_route;
    use crate::confidence_gate::DecisionRoute;

    #[test]
    fn test_end_to_end_ai_analyst_happy_path() {
        let policy = get_default_policy_text();

        let route = determine_route(98, 15000);
        assert_eq!(route, DecisionRoute::AutoApprove);

        let authz = evaluate_authorization(
            policy,
            "1.0.0",
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_e2e_001",
            15000,
            98,
        );
        assert_eq!(authz.decision, AuthzDecision::Allow);
    }

    #[test]
    fn test_end_to_end_ai_analyst_blocked_by_amount() {
        let policy = get_default_policy_text();

        let route = determine_route(98, 50000);
        assert_eq!(route, DecisionRoute::HumanApproval);

        let authz = evaluate_authorization(
            policy,
            "1.0.0",
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_e2e_002",
            50000,
            98,
        );
        assert_eq!(
            authz.decision,
            AuthzDecision::Deny,
            "Even with high confidence, AI cannot auto-approve over $300"
        );
    }

    #[test]
    fn test_end_to_end_ai_analyst_blocked_by_confidence() {
        let policy = get_default_policy_text();

        let route = determine_route(85, 15000);
        assert_eq!(route, DecisionRoute::HumanApproval);

        let authz = evaluate_authorization(
            policy,
            "1.0.0",
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_e2e_003",
            15000,
            85,
        );
        assert_eq!(
            authz.decision,
            AuthzDecision::Deny,
            "AI cannot auto-approve with confidence below 95%"
        );
    }

    #[test]
    fn test_end_to_end_escalation_flow() {
        let policy = get_default_policy_text();

        let route = determine_route(60, 25000);
        assert_eq!(route, DecisionRoute::Escalated);

        let ai_escalate = evaluate_authorization(
            policy,
            "1.0.0",
            "ai_analyst",
            "escalate",
            "Claim",
            "claim_e2e_004",
            25000,
            60,
        );
        assert_eq!(ai_escalate.decision, AuthzDecision::Allow);

        let human_approve = evaluate_authorization(
            policy,
            "1.0.0",
            "human_approver",
            "approve",
            "Claim",
            "claim_e2e_004",
            25000,
            60,
        );
        assert_eq!(human_approve.decision, AuthzDecision::Allow);
    }

    #[test]
    fn test_policy_version_tracking() {
        let policy = get_default_policy_text();
        let version = "test-v2.0.0";

        let result = evaluate_authorization(
            policy,
            version,
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_version_test",
            10000,
            96,
        );

        assert_eq!(
            result.policy_version, version,
            "Policy version should be tracked in authorization result"
        );
    }
}
