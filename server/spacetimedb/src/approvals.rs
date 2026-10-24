use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

use crate::confidence_gate::{determine_route, DecisionRoute};
use crate::{decision_record, DecisionOutcome, DecisionRecord, DecisionType};

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscalatedClaimStatus {
    Pending,
    Approved,
    Denied,
    Edited,
}

/// Human review queue behind the Approvals page. Only claims the confidence
/// gate routes to `Escalated` are ever stored here.
#[derive(Clone)]
#[spacetimedb::table(accessor = escalated_claim, public)]
pub struct EscalatedClaim {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub customer_name: String,
    pub amount_claimed_cents: i64,
    pub proposed_amount_cents: i64,
    pub confidence_pct: u8,
    pub escalation_reason: String,
    pub status: EscalatedClaimStatus,
    pub policy_version: String,
    pub model_version: String,
    pub created_at: Timestamp,
}

pub fn is_escalated(confidence_pct: u8, amount_cents: i64) -> bool {
    determine_route(confidence_pct as i64, amount_cents) == DecisionRoute::Escalated
}

#[spacetimedb::reducer]
pub fn seed_escalated_claim(
    ctx: &ReducerContext,
    customer_name: String,
    amount_claimed_cents: i64,
    proposed_amount_cents: i64,
    confidence_pct: u8,
    escalation_reason: String,
    policy_version: String,
    model_version: String,
) {
    if !is_escalated(confidence_pct, amount_claimed_cents) {
        log::warn!(
            "Skipping claim for {}: {}% on {} cents is not escalated by the confidence gate",
            customer_name,
            confidence_pct,
            amount_claimed_cents
        );
        return;
    }
    ctx.db.escalated_claim().insert(EscalatedClaim {
        id: 0,
        customer_name,
        amount_claimed_cents,
        proposed_amount_cents,
        confidence_pct,
        escalation_reason,
        status: EscalatedClaimStatus::Pending,
        policy_version,
        model_version,
        created_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn approve_escalated_claim(
    ctx: &ReducerContext,
    claim_id: u64,
    policy_version: String,
    model_version: String,
) {
    if let Some(claim) = ctx.db.escalated_claim().id().find(claim_id) {
        ctx.db.escalated_claim().id().update(EscalatedClaim {
            status: EscalatedClaimStatus::Approved,
            ..claim.clone()
        });
        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: ctx.timestamp,
            decision_type: DecisionType::CreditIssued,
            outcome: DecisionOutcome::Approved,
            pass_id: None,
            station_id: None,
            amount_cents: claim.proposed_amount_cents,
            reason: format!("Approved escalated claim for {}", claim.customer_name),
            policy_version,
            model_version,
        });
    }
}

#[spacetimedb::reducer]
pub fn deny_escalated_claim(
    ctx: &ReducerContext,
    claim_id: u64,
    policy_version: String,
    model_version: String,
) {
    if let Some(claim) = ctx.db.escalated_claim().id().find(claim_id) {
        ctx.db.escalated_claim().id().update(EscalatedClaim {
            status: EscalatedClaimStatus::Denied,
            ..claim.clone()
        });
        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: ctx.timestamp,
            decision_type: DecisionType::DisputeResolved,
            outcome: DecisionOutcome::Denied,
            pass_id: None,
            station_id: None,
            amount_cents: 0,
            reason: format!("Denied escalated claim for {}", claim.customer_name),
            policy_version,
            model_version,
        });
    }
}

#[spacetimedb::reducer]
pub fn edit_escalated_claim(
    ctx: &ReducerContext,
    claim_id: u64,
    new_amount_cents: i64,
    policy_version: String,
    model_version: String,
) {
    if let Some(claim) = ctx.db.escalated_claim().id().find(claim_id) {
        ctx.db.escalated_claim().id().update(EscalatedClaim {
            status: EscalatedClaimStatus::Edited,
            proposed_amount_cents: new_amount_cents,
            ..claim.clone()
        });
        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: ctx.timestamp,
            decision_type: DecisionType::CreditIssued,
            outcome: DecisionOutcome::Approved,
            pass_id: None,
            station_id: None,
            amount_cents: new_amount_cents,
            reason: format!(
                "Edited and approved claim for {} (adjusted to {} cents)",
                claim.customer_name, new_amount_cents
            ),
            policy_version,
            model_version,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::is_escalated;

    #[test]
    fn approvals_fixtures_are_all_escalated() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/claims.json")).unwrap();
        for claim in fixtures.as_array().unwrap() {
            let confidence = claim["confidence_pct"].as_u64().unwrap() as u8;
            let amount = claim["amount_claimed_cents"].as_i64().unwrap();
            assert!(
                is_escalated(confidence, amount),
                "{} would not be escalated",
                claim["customer_name"]
            );
        }
    }

    #[test]
    fn auto_and_human_approval_claims_are_not_escalated() {
        assert!(!is_escalated(96, 11_500));
        assert!(!is_escalated(97, 4_200_000));
        assert!(!is_escalated(90, 20_000));
        assert!(is_escalated(79, 10_000));
        assert!(is_escalated(94, 30_001));
    }
}
