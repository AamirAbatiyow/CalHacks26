//! Settles the generated contract pass history the way an operator's billing desk
//! would: dropped passes are credited, recovered from a backup capture or denied,
//! and a share of completed passes is disputed. Every amount is a share of the
//! revenue of the pass it settles, and every auto/human split comes from the
//! confidence gate. The rates are seed assumptions passed in from
//! `fixtures/contracts.json`.

use std::collections::HashSet;

use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

use crate::confidence_gate::{determine_route, DecisionRoute, CONFIDENCE_AUTO_APPROVE_THRESHOLD};
use crate::kpis::sync_kpis;
use crate::ledger::{ledger_entry, LedgerEntry, LedgerEntryType};
use crate::{decision_record, pass, DecisionOutcome, DecisionRecord, DecisionType, Pass, PassStatus};

#[derive(SpacetimeType, Clone, Debug)]
pub struct SettlementAssumptions {
    /// Satellites whose passes are settled here (the contracted fleet).
    pub norad_ids: Vec<u32>,
    /// Claims on passes that ended more recently than this are still open.
    pub settlement_lag_hours: i64,
    /// Of settled dropped passes: share credited in full, share recovered from a
    /// backup capture; the rest is denied (customer-side fault).
    pub dropped_credit_pct: u64,
    pub dropped_recovered_pct: u64,
    /// Completed passes the customer disputes, per thousand.
    pub dispute_per_mille: u64,
    /// Of settled disputes, share credited; the rest is denied.
    pub dispute_credit_pct: u64,
    /// A credited dispute pays between these shares of the pass revenue.
    pub dispute_credit_min_pct: u64,
    pub dispute_credit_max_pct: u64,
    /// Share of settled claims the model decides at or above the auto threshold.
    pub auto_decided_pct: u64,
}

/// Stable per-pass draw in 0..1_000_000 so the same pass always settles the same way.
fn draw(pass_id: u64, salt: u64) -> u64 {
    let mut z = pass_id.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ salt;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    (z ^ (z >> 31)) % 1_000_000
}

fn pct(pass_id: u64, salt: u64) -> u64 {
    draw(pass_id, salt) % 100
}

/// Model confidence for a settled claim: `auto_decided_pct` of claims land at or
/// above the auto threshold, the rest between 60% and just below it.
fn confidence(pass_id: u64, a: &SettlementAssumptions) -> i64 {
    let t = CONFIDENCE_AUTO_APPROVE_THRESHOLD as u64;
    let c = if pct(pass_id, 11) < a.auto_decided_pct {
        t + draw(pass_id, 12) % (100 - t + 1)
    } else {
        60 + draw(pass_id, 13) % (t - 60)
    };
    c as i64
}

fn gated(confidence: i64) -> (DecisionOutcome, &'static str) {
    match determine_route(confidence) {
        DecisionRoute::AutoApprove => (DecisionOutcome::AutoApproved, "auto-approved"),
        DecisionRoute::Escalated => (DecisionOutcome::Approved, "approved after human review"),
    }
}

pub fn settle_contract_passes(ctx: &ReducerContext, a: &SettlementAssumptions) {
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let hour: i64 = 3_600_000_000;
    let lag_start = now - a.settlement_lag_hours * hour;
    let fleet: HashSet<u32> = a.norad_ids.iter().copied().collect();
    let decided: HashSet<u64> = ctx.db.decision_record().iter().filter_map(|d| d.pass_id).collect();

    let at = |pass: &Pass, salt: u64| {
        let after_hours = 1 + (draw(pass.id, salt) % 48) as i64;
        Timestamp::from_micros_since_unix_epoch((pass.end_time.to_micros_since_unix_epoch() + after_hours * hour).min(now))
    };
    let decide = |pass: &Pass, when: Timestamp, decision_type, outcome, amount_cents: i64, reason: String| {
        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: when,
            decision_type,
            outcome,
            pass_id: Some(pass.id),
            station_id: Some(pass.station_id.clone()),
            amount_cents,
            reason,
            policy_version: crate::CURRENT_POLICY_VERSION.to_string(),
            model_version: crate::CURRENT_MODEL_VERSION.to_string(),
        });
    };
    let post = |pass: &Pass, when: Timestamp, entry_type, description: String, reference: String, amount_cents: i64| {
        ctx.db.ledger_entry().insert(LedgerEntry {
            id: 0,
            created_at: when,
            entry_type,
            description,
            reference_id: Some(reference),
            amount_cents,
            dispute_id: None,
            pass_id: Some(pass.id),
            station_id: Some(pass.station_id.clone()),
        });
    };

    let passes: Vec<Pass> = ctx
        .db
        .pass()
        .iter()
        .filter(|p| fleet.contains(&p.satellite_id) && !decided.contains(&p.id))
        .filter(|p| p.end_time.to_micros_since_unix_epoch() < now)
        .collect();

    for pass in &passes {
        let settled = pass.end_time.to_micros_since_unix_epoch() < lag_start;
        let revenue = pass.revenue_cents;
        match pass.status {
            PassStatus::Dropped if settled => {
                let roll = pct(pass.id, 1);
                let when = at(pass, 2);
                if roll < a.dropped_credit_pct {
                    let c = confidence(pass.id, a);
                    let (outcome, how) = gated(c);
                    decide(pass, when, DecisionType::CreditIssued, outcome, revenue,
                        format!("Pass dropped with no downlink; full SLA credit {} at {}% confidence", how, c));
                    post(pass, when, LedgerEntryType::Credit, format!("Credit issued for Pass #{}", pass.id),
                        format!("CR-2026-{}", pass.id), -revenue);
                } else if roll < a.dropped_credit_pct + a.dropped_recovered_pct {
                    decide(pass, when, DecisionType::PassRecovered, DecisionOutcome::Approved, revenue,
                        "Backup ground station captured pass data".to_string());
                    post(pass, when, LedgerEntryType::Recovery,
                        format!("Recovered revenue from backup capture of Pass #{}", pass.id),
                        format!("REC-2026-{}", pass.id), revenue);
                } else {
                    decide(pass, when, DecisionType::CreditIssued, DecisionOutcome::Denied, revenue,
                        "SLA credit claimed but the drop was a customer-side configuration fault; denied".to_string());
                }
            }
            PassStatus::Ok if draw(pass.id, 3) % 1000 < a.dispute_per_mille => {
                let when = at(pass, 4);
                if !settled {
                    decide(pass, when, DecisionType::DisputeCreated, DecisionOutcome::Pending, revenue,
                        "Customer reported incomplete data transfer".to_string());
                } else if pct(pass.id, 5) < a.dispute_credit_pct {
                    let span = a.dispute_credit_max_pct.saturating_sub(a.dispute_credit_min_pct) + 1;
                    let share = a.dispute_credit_min_pct + draw(pass.id, 6) % span;
                    let amount = revenue * share as i64 / 100;
                    let c = confidence(pass.id, a);
                    let (outcome, how) = gated(c);
                    decide(pass, when, DecisionType::DisputeResolved, outcome, amount,
                        format!("Degraded link; {}% of the pass credited, {} at {}% confidence", share, how, c));
                    post(pass, when, LedgerEntryType::Credit, format!("Credit issued for Pass #{}", pass.id),
                        format!("CR-2026-{}", pass.id), -amount);
                } else {
                    decide(pass, when, DecisionType::DisputeResolved, DecisionOutcome::Denied, revenue,
                        "Full refund claimed but telemetry confirms complete downlink; denied".to_string());
                }
            }
            _ => {}
        }
    }
    sync_kpis(ctx);
}

/// Re-running only settles passes that have no decision yet.
#[spacetimedb::reducer]
pub fn settle_pass_history(ctx: &ReducerContext, assumptions: SettlementAssumptions) {
    settle_contract_passes(ctx, &assumptions);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assumptions() -> SettlementAssumptions {
        let doc: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/contracts.json")).unwrap();
        let s = &doc["settlement"];
        let n = |k: &str| s[k].as_u64().unwrap();
        SettlementAssumptions {
            norad_ids: vec![],
            settlement_lag_hours: n("settlement_lag_hours") as i64,
            dropped_credit_pct: n("dropped_credit_pct"),
            dropped_recovered_pct: n("dropped_recovered_pct"),
            dispute_per_mille: n("dispute_per_mille"),
            dispute_credit_pct: n("dispute_credit_pct"),
            dispute_credit_min_pct: n("dispute_credit_min_pct"),
            dispute_credit_max_pct: n("dispute_credit_max_pct"),
            auto_decided_pct: n("auto_decided_pct"),
        }
    }

    #[test]
    fn confidence_split_matches_the_assumption_and_the_gate() {
        let a = assumptions();
        let n = 20_000u64;
        let auto = (1..=n).filter(|id| determine_route(confidence(*id, &a)) == DecisionRoute::AutoApprove).count() as u64;
        let share = auto * 100 / n;
        assert!(share.abs_diff(a.auto_decided_pct) <= 2, "auto share {}% vs {}%", share, a.auto_decided_pct);
        assert!((1..=n).all(|id| (60..=100).contains(&confidence(id, &a))));
    }

    #[test]
    fn dispute_rate_matches_the_assumption() {
        let a = assumptions();
        let n = 100_000u64;
        let disputed = (1..=n).filter(|id| draw(*id, 3) % 1000 < a.dispute_per_mille).count() as u64;
        assert!((disputed * 1000 / n).abs_diff(a.dispute_per_mille) <= 2);
    }
}
