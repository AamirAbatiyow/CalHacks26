use std::collections::HashSet;

use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

use crate::authority::active_policy_version;
use crate::confidence_gate::{determine_route, DecisionRoute};
use crate::kpis::sync_kpis;
use crate::ledger::post_credit;
use crate::{decision_record, pass, space_weather, DecisionOutcome, DecisionRecord, DecisionType, Pass, PassStatus};

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscalatedClaimStatus {
    Pending,
    Approved,
    Denied,
    Edited,
}

/// Human review queue behind the Approvals page. Only claims the confidence
/// gate routes to `Escalated` (below 95% confidence) are ever stored here.
/// Each claim covers real billed passes and is sized from their revenue.
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
    pub pass_ids: Vec<u64>,
}

pub fn is_escalated(confidence_pct: u8) -> bool {
    determine_route(confidence_pct as i64) == DecisionRoute::Escalated
}

/// Which of the customer's open passes a claim covers.
fn selects(selection: &str, pass: &Pass, storms: &[(i64, i64)]) -> bool {
    let start = pass.start_time.to_micros_since_unix_epoch();
    let in_storm = storms.iter().any(|(a, b)| start >= *a && start <= *b);
    match selection {
        "dropped" => pass.status == PassStatus::Dropped,
        "storm" => in_storm,
        "storm_dropped" => in_storm && pass.status == PassStatus::Dropped,
        _ => true,
    }
}

/// Seeds an escalated claim over the customer's most recent open passes: passes
/// of `norad_ids` that ended within `lookback_hours`, have no decision yet and
/// are not in another claim. The claimed and proposed amounts are
/// `claimed_pct` / `proposed_pct` of those passes' billed revenue.
#[spacetimedb::reducer]
pub fn seed_escalated_claim(
    ctx: &ReducerContext,
    customer_name: String,
    norad_ids: Vec<u32>,
    selection: String,
    pass_count: u32,
    lookback_hours: i64,
    claimed_pct: u8,
    proposed_pct: u8,
    confidence_pct: u8,
    escalation_reason: String,
    policy_version: String,
    model_version: String,
) {
    if !is_escalated(confidence_pct) {
        log::warn!(
            "Skipping claim for {}: {}% confidence is auto-approved, not escalated",
            customer_name,
            confidence_pct
        );
        return;
    }
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let hour: i64 = 3_600_000_000;
    let storms: Vec<(i64, i64)> = ctx
        .db
        .space_weather()
        .iter()
        .filter(|w| w.kp_index >= 5.0)
        .map(|w| {
            let t = w.timestamp.to_micros_since_unix_epoch();
            (t - hour / 2, t + hour / 2)
        })
        .collect();
    let decided: HashSet<u64> = ctx.db.decision_record().iter().filter_map(|d| d.pass_id).collect();
    let claimed: HashSet<u64> = ctx.db.escalated_claim().iter().flat_map(|c| c.pass_ids).collect();
    let mut open: Vec<Pass> = ctx
        .db
        .pass()
        .iter()
        .filter(|p| norad_ids.contains(&p.satellite_id))
        .filter(|p| {
            let end = p.end_time.to_micros_since_unix_epoch();
            end < now && end >= now - lookback_hours * hour
        })
        .filter(|p| matches!(p.status, PassStatus::Ok | PassStatus::Dropped))
        .filter(|p| !decided.contains(&p.id) && !claimed.contains(&p.id))
        .filter(|p| selects(&selection, p, &storms))
        .collect();
    open.sort_by_key(|p| std::cmp::Reverse(p.start_time));
    open.truncate(pass_count as usize);
    if open.is_empty() {
        log::warn!("No open passes for {}; claim not seeded", customer_name);
        return;
    }
    let revenue: i64 = open.iter().map(|p| p.revenue_cents).sum();
    ctx.db.escalated_claim().insert(EscalatedClaim {
        id: 0,
        customer_name,
        amount_claimed_cents: revenue * claimed_pct as i64 / 100,
        proposed_amount_cents: revenue * proposed_pct as i64 / 100,
        confidence_pct,
        escalation_reason,
        status: EscalatedClaimStatus::Pending,
        policy_version,
        model_version,
        created_at: ctx.timestamp,
        pass_ids: open.iter().map(|p| p.id).collect(),
    });
    sync_kpis(ctx);
}

/// Splits `amount_cents` across a claim's passes in proportion to their revenue,
/// the last pass taking the rounding remainder.
pub fn split_by_revenue(amount_cents: i64, revenues: &[i64]) -> Vec<i64> {
    let total: i64 = revenues.iter().sum();
    if total <= 0 || revenues.is_empty() {
        return vec![0; revenues.len()];
    }
    let mut shares: Vec<i64> = revenues.iter().map(|r| amount_cents * r / total).collect();
    let paid: i64 = shares.iter().sum();
    if let Some(last) = shares.last_mut() {
        *last += amount_cents - paid;
    }
    shares
}

/// Records a human decision on every pass of an escalated claim and, when money
/// moves, a ledger credit against each pass.
fn settle_claim(
    ctx: &ReducerContext,
    claim: &EscalatedClaim,
    amount_cents: i64,
    outcome: DecisionOutcome,
    reason: String,
    policy_version: String,
    model_version: String,
) {
    let passes: Vec<Option<Pass>> = claim.pass_ids.iter().map(|id| ctx.db.pass().id().find(*id)).collect();
    let revenues: Vec<i64> = passes.iter().map(|p| p.as_ref().map_or(0, |p| p.revenue_cents)).collect();
    let shares = split_by_revenue(amount_cents, &revenues);
    let policy_version = active_policy_version(ctx).unwrap_or(policy_version);
    for ((pass_id, pass), share) in claim.pass_ids.iter().zip(passes).zip(shares) {
        let station_id = pass.map(|p| p.station_id);
        let paid = if outcome == DecisionOutcome::Denied { 0 } else { share };
        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: ctx.timestamp,
            decision_type: if outcome == DecisionOutcome::Denied { DecisionType::DisputeResolved } else { DecisionType::CreditIssued },
            outcome,
            pass_id: Some(*pass_id),
            station_id: station_id.clone(),
            amount_cents: paid,
            reason: reason.clone(),
            policy_version: policy_version.clone(),
            model_version: model_version.clone(),
        });
        post_credit(
            ctx,
            Some(*pass_id),
            station_id,
            format!("CR-ESC-{}-{}", claim.id, pass_id),
            format!("Credit issued for escalated claim from {} (Pass #{})", claim.customer_name, pass_id),
            paid,
        );
    }
    sync_kpis(ctx);
}

fn pending(ctx: &ReducerContext, claim_id: u64) -> Option<EscalatedClaim> {
    ctx.db.escalated_claim().id().find(claim_id).filter(|c| c.status == EscalatedClaimStatus::Pending)
}

#[spacetimedb::reducer]
pub fn approve_escalated_claim(
    ctx: &ReducerContext,
    claim_id: u64,
    policy_version: String,
    model_version: String,
) {
    if let Some(claim) = pending(ctx, claim_id) {
        ctx.db.escalated_claim().id().update(EscalatedClaim {
            status: EscalatedClaimStatus::Approved,
            ..claim.clone()
        });
        let reason = format!("Approved escalated claim for {}", claim.customer_name);
        settle_claim(ctx, &claim, claim.proposed_amount_cents, DecisionOutcome::Approved, reason, policy_version, model_version);
    }
}

#[spacetimedb::reducer]
pub fn deny_escalated_claim(
    ctx: &ReducerContext,
    claim_id: u64,
    policy_version: String,
    model_version: String,
) {
    if let Some(claim) = pending(ctx, claim_id) {
        ctx.db.escalated_claim().id().update(EscalatedClaim {
            status: EscalatedClaimStatus::Denied,
            ..claim.clone()
        });
        let reason = format!("Denied escalated claim for {}", claim.customer_name);
        settle_claim(ctx, &claim, 0, DecisionOutcome::Denied, reason, policy_version, model_version);
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
    if let Some(claim) = pending(ctx, claim_id) {
        ctx.db.escalated_claim().id().update(EscalatedClaim {
            status: EscalatedClaimStatus::Edited,
            proposed_amount_cents: new_amount_cents,
            ..claim.clone()
        });
        let reason = format!(
            "Edited and approved claim for {} (adjusted to ${:.2})",
            claim.customer_name,
            new_amount_cents as f64 / 100.0
        );
        settle_claim(ctx, &claim, new_amount_cents, DecisionOutcome::Approved, reason, policy_version, model_version);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_escalated, split_by_revenue};

    fn fixtures() -> Vec<serde_json::Value> {
        let parsed: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/claims.json")).unwrap();
        parsed.as_array().unwrap().clone()
    }

    #[test]
    fn approvals_fixtures_are_all_escalated() {
        for claim in fixtures() {
            let confidence = claim["confidence_pct"].as_u64().unwrap() as u8;
            assert!(
                is_escalated(confidence),
                "{} would not be escalated",
                claim["customer_name"]
            );
        }
    }

    #[test]
    fn approvals_fixture_reasons_cite_confidence_not_amount() {
        for claim in fixtures() {
            let confidence = claim["confidence_pct"].as_u64().unwrap();
            let reason = claim["escalation_reason"].as_str().unwrap();
            assert!(
                reason.starts_with(&format!("Confidence {}% below 95%", confidence)),
                "{} reason does not cite its confidence: {}",
                claim["customer_name"],
                reason
            );
            assert!(
                !reason.contains('$') && !reason.contains("limit"),
                "{} reason cites a dollar figure or limit: {}",
                claim["customer_name"],
                reason
            );
        }
    }

    #[test]
    fn approvals_badge_count_matches_fixtures() {
        let pending = fixtures()
            .iter()
            .filter(|c| is_escalated(c["confidence_pct"].as_u64().unwrap() as u8))
            .count();
        assert_eq!(pending, 6);
    }

    #[test]
    fn approvals_fixtures_name_a_contract_and_stay_within_pass_revenue() {
        let contracts: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/contracts.json")).unwrap();
        let customers: Vec<&str> = contracts["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["customer"].as_str().unwrap())
            .collect();
        for claim in fixtures() {
            let name = claim["customer_name"].as_str().unwrap();
            assert!(customers.contains(&name), "{} has no contract", name);
            let claimed = claim["claimed_pct"].as_u64().unwrap();
            let proposed = claim["proposed_pct"].as_u64().unwrap();
            assert!(claimed <= 100 && proposed <= claimed, "{} claims more than its passes billed", name);
            assert!(claim["pass_count"].as_u64().unwrap() > 0);
        }
    }

    #[test]
    fn split_by_revenue_pays_exactly_the_amount() {
        assert_eq!(split_by_revenue(1000, &[100, 300]), vec![250, 750]);
        assert_eq!(split_by_revenue(1001, &[1, 1, 1]), vec![333, 333, 335]);
        assert_eq!(split_by_revenue(500, &[]), Vec::<i64>::new());
        assert_eq!(split_by_revenue(500, &[0, 0]), vec![0, 0]);
    }

    #[test]
    fn only_confidence_decides_escalation() {
        assert!(!is_escalated(95));
        assert!(!is_escalated(96));
        assert!(!is_escalated(100));
        assert!(is_escalated(94));
        assert!(is_escalated(80));
        assert!(is_escalated(45));
    }
}
