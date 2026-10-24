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
    fn test_ai_analyst_auto_approve_high_confidence() {
        let policy = get_default_policy_text();
        let result = evaluate_authorization(
            policy,
            POLICY_VERSION,
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_001",
            25000,
            96,
        );

        assert_eq!(
            result.decision,
            AuthzDecision::Allow,
            "AI analyst should be able to auto-approve claims with >=95% confidence"
        );
    }

    #[test]
    fn test_ai_analyst_auto_approve_has_no_dollar_cap() {
        let policy = get_default_policy_text();
        for amount in [30001, 50000, 2500001, 7500000, 1_000_000_000] {
            let result = evaluate_authorization(
                policy,
                POLICY_VERSION,
                "ai_analyst",
                "auto_approve",
                "Claim",
                "claim_002",
                amount,
                95,
            );

            assert_eq!(
                result.decision,
                AuthzDecision::Allow,
                "AI analyst at 95% confidence should auto-approve {} cents",
                amount
            );
        }
    }

    #[test]
    fn test_ai_analyst_forbidden_raise_own_limits() {
        let policy = get_default_policy_text();
        for (resource_type, resource_id) in [("Policy", "policy_v4"), ("Policy", "confidence_config")] {
            let result = evaluate_authorization(
                policy,
                POLICY_VERSION,
                "ai_analyst",
                "edit_policy",
                resource_type,
                resource_id,
                0,
                100,
            );

            assert_eq!(
                result.decision,
                AuthzDecision::Deny,
                "AI analyst must not be able to change its own authority via {}",
                resource_id
            );
        }
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
            15000,
            94, // Below 95% threshold
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
    use crate::confidence_gate::{determine_route, DecisionRoute, CONFIDENCE_AUTO_APPROVE_THRESHOLD};

    #[test]
    fn test_route_auto_approve_high_confidence() {
        assert_eq!(determine_route(96), DecisionRoute::AutoApprove);
        assert_eq!(determine_route(100), DecisionRoute::AutoApprove);
    }

    #[test]
    fn test_route_auto_approve_threshold_exactly_95() {
        assert_eq!(
            determine_route(95),
            DecisionRoute::AutoApprove,
            "Exactly 95% confidence should auto-approve"
        );
    }

    #[test]
    fn test_route_escalates_below_95() {
        assert_eq!(
            determine_route(94),
            DecisionRoute::Escalated,
            "Anything below 95% confidence should escalate to a human"
        );
        assert_eq!(determine_route(85), DecisionRoute::Escalated);
        assert_eq!(determine_route(79), DecisionRoute::Escalated);
        assert_eq!(determine_route(40), DecisionRoute::Escalated);
        assert_eq!(determine_route(0), DecisionRoute::Escalated);
    }

    #[test]
    fn test_constants_match_spec() {
        assert_eq!(
            CONFIDENCE_AUTO_APPROVE_THRESHOLD, 95,
            "Auto-approve threshold should be 95%"
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

        let route = determine_route(98);
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
    fn test_end_to_end_ai_analyst_large_claim_high_confidence() {
        let policy = get_default_policy_text();

        let route = determine_route(98);
        assert_eq!(route, DecisionRoute::AutoApprove);

        let authz = evaluate_authorization(
            policy,
            "1.0.0",
            "ai_analyst",
            "auto_approve",
            "Claim",
            "claim_e2e_002",
            4200000,
            98,
        );
        assert_eq!(
            authz.decision,
            AuthzDecision::Allow,
            "A $42K claim at 98% confidence is auto-approved; amount never gates"
        );
    }

    #[test]
    fn test_end_to_end_ai_analyst_blocked_by_confidence() {
        let policy = get_default_policy_text();

        let route = determine_route(85);
        assert_eq!(route, DecisionRoute::Escalated);

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

        let route = determine_route(60);
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
