//! Financial KPIs shown on Overview and Finance. Every figure in the `kpi` row is
//! derived from other tables by `sync_kpis`; nothing is stored by hand.

use std::collections::{HashMap, HashSet};

use spacetimedb::{ReducerContext, Table};

use crate::approvals::{escalated_claim, EscalatedClaim, EscalatedClaimStatus};
use crate::ledger::{ledger_entry, LedgerEntry, LedgerEntryType};
use crate::sla::{dispute, Dispute, DisputeStatus};
use crate::{decision_record, kpi, pass, DecisionOutcome, DecisionRecord, Kpi, Pass, PassStatus};

/// Cost of a human analyst reviewing one claim (the Finance cost-per-claim chart).
pub const HUMAN_REVIEW_COST_CENTS: i64 = 30000;
/// Cost of Ground Truth deciding one claim.
pub const AI_REVIEW_COST_CENTS: i64 = 1500;
/// "Billed this month" is a trailing 30-day window ending now.
pub const BILLING_WINDOW_MICROS: i64 = 30 * 24 * 60 * 60 * 1_000_000;

pub const KPI_ID: &str = "main";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct KpiFigures {
    /// Revenue of every pass that started in the billing window (dropped passes are billed too).
    pub billed_cents: i64,
    /// Billed revenue that may still have to be credited back: unsettled dropped
    /// passes plus open disputes, each capped at the revenue of its pass.
    pub at_risk_cents: i64,
    /// Credits paid out, from the ledger.
    pub credits_paid_cents: i64,
    /// Revenue recovered, from the ledger.
    pub recovered_cents: i64,
    /// Money kept that would otherwise have leaked: recoveries, denied claims,
    /// and the part of human-reviewed escalations that was not paid.
    pub leakage_avoided_cents: i64,
    /// Human review cost not spent because Ground Truth auto-approved the claim.
    pub review_cost_saved_cents: i64,
}

pub fn compute_kpis(
    now_micros: i64,
    passes: &[Pass],
    ledger: &[LedgerEntry],
    decisions: &[DecisionRecord],
    disputes: &[Dispute],
    escalations: &[EscalatedClaim],
) -> KpiFigures {
    let mut f = KpiFigures::default();
    let revenue: HashMap<u64, i64> = passes.iter().map(|p| (p.id, p.revenue_cents)).collect();
    let cap = |pass_id: Option<u64>, amount: i64| match pass_id.and_then(|id| revenue.get(&id)) {
        Some(&rev) => amount.min(rev),
        None => amount,
    };

    let window_start = now_micros - BILLING_WINDOW_MICROS;
    for p in passes {
        let start = p.start_time.to_micros_since_unix_epoch();
        if p.status != PassStatus::Scheduled && start >= window_start && start <= now_micros {
            f.billed_cents += p.revenue_cents;
        }
    }

    let mut settled: HashSet<u64> = HashSet::new();
    for e in ledger {
        match e.entry_type {
            LedgerEntryType::Credit => f.credits_paid_cents -= e.amount_cents,
            LedgerEntryType::Recovery => f.recovered_cents += e.amount_cents,
            LedgerEntryType::Invoice => {}
        }
        if e.entry_type != LedgerEntryType::Invoice {
            settled.extend(e.pass_id);
        }
    }
    for d in decisions {
        if matches!(d.outcome, DecisionOutcome::Approved | DecisionOutcome::AutoApproved | DecisionOutcome::Denied) {
            settled.extend(d.pass_id);
        }
    }

    let mut exposure: HashMap<u64, i64> = HashMap::new();
    let mut expose = |pass_id: u64, amount: i64| {
        if !settled.contains(&pass_id) {
            let slot = exposure.entry(pass_id).or_insert(0);
            *slot = (*slot).max(cap(Some(pass_id), amount));
        }
    };
    for p in passes.iter().filter(|p| p.status == PassStatus::Dropped) {
        expose(p.id, p.revenue_cents);
    }
    for d in decisions.iter().filter(|d| d.outcome == DecisionOutcome::Pending) {
        if let Some(pass_id) = d.pass_id {
            expose(pass_id, d.amount_cents);
        }
    }
    for d in disputes {
        if matches!(d.status, DisputeStatus::Filed | DisputeStatus::UnderReview | DisputeStatus::Escalated) {
            expose(d.pass_id, d.claim_amount_cents);
        }
    }
    f.at_risk_cents = exposure.values().sum();

    let denied: i64 = decisions
        .iter()
        .filter(|d| d.outcome == DecisionOutcome::Denied)
        .map(|d| cap(d.pass_id, d.amount_cents))
        .sum::<i64>()
        + disputes
            .iter()
            .filter(|d| d.status == DisputeStatus::Denied)
            .map(|d| cap(Some(d.pass_id), d.claim_amount_cents))
            .sum::<i64>();
    let escalation_savings: i64 = escalations
        .iter()
        .map(|c| match c.status {
            EscalatedClaimStatus::Denied => c.amount_claimed_cents,
            EscalatedClaimStatus::Approved | EscalatedClaimStatus::Edited => {
                (c.amount_claimed_cents - c.proposed_amount_cents).max(0)
            }
            EscalatedClaimStatus::Pending => 0,
        })
        .sum();
    f.leakage_avoided_cents = f.recovered_cents + denied + escalation_savings;

    let auto_approved = decisions.iter().filter(|d| d.outcome == DecisionOutcome::AutoApproved).count() as i64;
    f.review_cost_saved_cents = auto_approved * (HUMAN_REVIEW_COST_CENTS - AI_REVIEW_COST_CENTS);

    f
}

/// Recomputes the `kpi` row from the tables it summarizes. Writes only on change.
pub fn sync_kpis(ctx: &ReducerContext) {
    let passes: Vec<Pass> = ctx.db.pass().iter().collect();
    let ledger: Vec<LedgerEntry> = ctx.db.ledger_entry().iter().collect();
    let decisions: Vec<DecisionRecord> = ctx.db.decision_record().iter().collect();
    let disputes: Vec<Dispute> = ctx.db.dispute().iter().collect();
    let escalations: Vec<EscalatedClaim> = ctx.db.escalated_claim().iter().collect();
    let f = compute_kpis(
        ctx.timestamp.to_micros_since_unix_epoch(),
        &passes,
        &ledger,
        &decisions,
        &disputes,
        &escalations,
    );

    let row = Kpi {
        id: KPI_ID.to_string(),
        billed_this_month_cents: f.billed_cents,
        revenue_at_risk_cents: f.at_risk_cents,
        credits_paid_cents: f.credits_paid_cents,
        recovered_cents: f.recovered_cents,
        leakage_avoided_cents: f.leakage_avoided_cents,
        review_cost_saved_cents: f.review_cost_saved_cents,
    };
    match ctx.db.kpi().id().find(KPI_ID.to_string()) {
        Some(existing) if existing == row => {}
        Some(_) => {
            ctx.db.kpi().id().update(row);
        }
        None => {
            ctx.db.kpi().insert(row);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::EscalatedClaimStatus;
    use crate::sla::SlaTier;
    use crate::DecisionType;
    use spacetimedb::Timestamp;

    const NOW: i64 = 1_800_000_000_000_000;
    const HOUR: i64 = 60 * 60 * 1_000_000;

    fn pass(id: u64, status: PassStatus, start: i64, revenue: i64) -> Pass {
        Pass {
            id,
            satellite_id: 1,
            station_id: "svalsat".into(),
            start_time: Timestamp::from_micros_since_unix_epoch(start),
            end_time: Timestamp::from_micros_since_unix_epoch(start + HOUR / 4),
            status,
            max_elevation_deg: 45.0,
            revenue_cents: revenue,
        }
    }

    fn ledger(entry_type: LedgerEntryType, pass_id: Option<u64>, amount: i64) -> LedgerEntry {
        LedgerEntry {
            id: 0,
            created_at: Timestamp::from_micros_since_unix_epoch(NOW),
            entry_type,
            description: String::new(),
            reference_id: None,
            amount_cents: amount,
            dispute_id: None,
            pass_id,
            station_id: None,
        }
    }

    fn decision(outcome: DecisionOutcome, pass_id: Option<u64>, amount: i64) -> DecisionRecord {
        DecisionRecord {
            id: 0,
            created_at: Timestamp::from_micros_since_unix_epoch(NOW),
            decision_type: DecisionType::CreditIssued,
            outcome,
            pass_id,
            station_id: None,
            amount_cents: amount,
            reason: String::new(),
            policy_version: "v4".into(),
            model_version: "v2".into(),
        }
    }

    fn dispute(pass_id: u64, status: DisputeStatus, claim: i64) -> Dispute {
        Dispute {
            id: 0,
            pass_id,
            station_id: "svalsat".into(),
            filed_at: Timestamp::from_micros_since_unix_epoch(NOW),
            deadline_at: Timestamp::from_micros_since_unix_epoch(NOW + 24 * HOUR),
            status,
            sla_tier: SlaTier::Standard,
            claim_amount_cents: claim,
            credit_amount_cents: 0,
            reason: String::new(),
            resolution_notes: String::new(),
            resolved_at: None,
        }
    }

    fn escalation(status: EscalatedClaimStatus, claimed: i64, proposed: i64) -> EscalatedClaim {
        EscalatedClaim {
            id: 0,
            customer_name: "Acme".into(),
            amount_claimed_cents: claimed,
            proposed_amount_cents: proposed,
            confidence_pct: 80,
            escalation_reason: String::new(),
            status,
            policy_version: "v4".into(),
            model_version: "v2".into(),
            created_at: Timestamp::from_micros_since_unix_epoch(NOW),
        }
    }

    #[test]
    fn billed_counts_started_passes_in_the_window() {
        let passes = [
            pass(1, PassStatus::Ok, NOW - HOUR, 500_000),
            pass(2, PassStatus::Dropped, NOW - 2 * HOUR, 400_000),
            pass(3, PassStatus::Active, NOW - HOUR / 8, 300_000),
            pass(4, PassStatus::Scheduled, NOW + HOUR, 900_000),
            pass(5, PassStatus::Ok, NOW - BILLING_WINDOW_MICROS - HOUR, 700_000),
        ];
        let f = compute_kpis(NOW, &passes, &[], &[], &[], &[]);
        assert_eq!(f.billed_cents, 1_200_000);
    }

    #[test]
    fn credits_and_recoveries_come_from_the_ledger() {
        let ledger = [
            ledger(LedgerEntryType::Credit, Some(1), -120_000),
            ledger(LedgerEntryType::Credit, None, -30_000),
            ledger(LedgerEntryType::Recovery, Some(2), 400_000),
            ledger(LedgerEntryType::Invoice, None, 9_000_000),
        ];
        let f = compute_kpis(NOW, &[], &ledger, &[], &[], &[]);
        assert_eq!(f.credits_paid_cents, 150_000);
        assert_eq!(f.recovered_cents, 400_000);
    }

    #[test]
    fn at_risk_is_unsettled_exposure_capped_at_pass_revenue() {
        let passes = [
            pass(1, PassStatus::Dropped, NOW - 3 * HOUR, 490_000),
            pass(2, PassStatus::Dropped, NOW - 2 * HOUR, 460_000),
            pass(3, PassStatus::Dropped, NOW - HOUR, 430_000),
            pass(4, PassStatus::Ok, NOW - HOUR, 530_000),
            pass(5, PassStatus::Ok, NOW - HOUR, 200_000),
        ];
        let ledger = [
            ledger(LedgerEntryType::Credit, Some(1), -490_000),
            ledger(LedgerEntryType::Recovery, Some(2), 460_000),
        ];
        let decisions = [decision(DecisionOutcome::Pending, Some(4), 9_999_999)];
        let disputes = [
            dispute(5, DisputeStatus::Filed, 50_000),
            dispute(3, DisputeStatus::UnderReview, 100_000),
        ];
        let f = compute_kpis(NOW, &passes, &ledger, &decisions, &disputes, &[]);
        assert_eq!(f.at_risk_cents, 430_000 + 530_000 + 50_000);
    }

    #[test]
    fn leakage_avoided_and_review_cost_saved() {
        let passes = [pass(1, PassStatus::Ok, NOW - HOUR, 570_000), pass(2, PassStatus::Ok, NOW - HOUR, 300_000)];
        let ledger = [ledger(LedgerEntryType::Recovery, None, 460_000)];
        let decisions = [
            decision(DecisionOutcome::Denied, Some(1), 15_600_000),
            decision(DecisionOutcome::AutoApproved, Some(2), 15_000),
            decision(DecisionOutcome::AutoApproved, None, 10_000),
            decision(DecisionOutcome::Approved, None, 100_000),
        ];
        let disputes = [dispute(2, DisputeStatus::Denied, 80_000)];
        let escalations = [
            escalation(EscalatedClaimStatus::Pending, 4_200_000, 4_200_000),
            escalation(EscalatedClaimStatus::Edited, 3_800_000, 3_200_000),
            escalation(EscalatedClaimStatus::Denied, 2_800_000, 2_800_000),
        ];
        let f = compute_kpis(NOW, &passes, &ledger, &decisions, &disputes, &escalations);
        assert_eq!(f.leakage_avoided_cents, 460_000 + 570_000 + 80_000 + 600_000 + 2_800_000);
        assert_eq!(f.review_cost_saved_cents, 2 * (HUMAN_REVIEW_COST_CENTS - AI_REVIEW_COST_CENTS));
    }
}
