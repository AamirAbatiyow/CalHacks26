use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

use crate::authority::{check_authorization, AuthzDecision};
use crate::confidence_gate::{determine_route, DecisionRoute, CONFIDENCE_AUTO_APPROVE_THRESHOLD};
use crate::kpis::sync_kpis;
use crate::ledger::{ledger_entry, post_credit};
use crate::{
    decision_record, pass, satellite, space_weather, station, DecisionOutcome, DecisionRecord,
    DecisionType,
};

/// NOAA G1 storms start at Kp 5.
const STORM_KP_THRESHOLD: f32 = 5.0;

/// Confidence alone decides: auto at or above the threshold, escalated below it.
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimGate {
    Auto,
    Escalated,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DataIntegrityStatus {
    Pass,
    Fail,
    Pending,
}

#[spacetimedb::table(accessor = claim, public)]
pub struct Claim {
    #[primary_key]
    pub id: String,
    pub customer_name: String,
    pub amount_claimed_cents: i64,
    pub pass_id: u64,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = claim_pass, public)]
pub struct ClaimPass {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub claim_id: String,
    pub station_lat: f64,
    pub station_lon: f64,
    pub station_name: String,
    pub satellite_norad_id: u32,
    pub satellite_tle1: String,
    pub satellite_tle2: String,
    pub contact_start_time: Timestamp,
    pub signal_lost_time: Timestamp,
    pub contact_end_time: Timestamp,
    pub max_elevation_deg: f64,
}

#[spacetimedb::table(accessor = claim_evidence, public)]
pub struct ClaimEvidence {
    #[primary_key]
    pub claim_id: String,
    pub data_integrity_status: DataIntegrityStatus,
    pub estimated_loss_cents: i64,
    pub missing_evidence_cents: i64,
}

#[spacetimedb::table(accessor = claim_decision, public)]
pub struct ClaimDecision {
    #[primary_key]
    pub claim_id: String,
    pub credit_amount_cents: i64,
    pub confidence_percent: i32,
    pub gate: ClaimGate,
    pub rule: String,
    pub policy_version: String,
    pub model_version: String,
    pub decided_at: Timestamp,
}

#[spacetimedb::table(accessor = claim_outcome, public)]
pub struct ClaimOutcome {
    #[primary_key]
    pub claim_id: String,
    pub credit_memo_sent: bool,
    pub ledger_posted: bool,
    pub completed_at: Option<Timestamp>,
}

#[spacetimedb::table(accessor = claim_weather, public)]
pub struct ClaimWeather {
    #[primary_key]
    pub claim_id: String,
    pub kp_index: f32,
    pub storm_active: bool,
}

/// SHAP contributions behind a claim's confidence score, in log-odds.
#[spacetimedb::table(accessor = claim_reason, public)]
pub struct ClaimReason {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub claim_id: String,
    pub feature: String,
    pub detail: String,
    pub shap_value: f32,
}

/// The confidence-gate condition that routed a decision, worded for the Claim page.
pub fn decision_rule(route: DecisionRoute) -> String {
    match route {
        DecisionRoute::AutoApprove => {
            format!("auto_approve: confidence >= {}%", CONFIDENCE_AUTO_APPROVE_THRESHOLD)
        }
        DecisionRoute::Escalated => {
            format!("escalate: confidence below {}%", CONFIDENCE_AUTO_APPROVE_THRESHOLD)
        }
    }
}

/// Ledger reference for the credit paid on a claim.
fn credit_reference(claim_id: &str) -> String {
    format!("CR-{}", claim_id)
}

/// Pays out a claim's credit: a ledger entry against the claimed pass plus the
/// matching audit record, then refreshes the KPIs. Idempotent per claim.
fn pay_claim_credit(ctx: &ReducerContext, decision: &ClaimDecision, outcome: DecisionOutcome) {
    let reference = credit_reference(&decision.claim_id);
    if ctx.db.ledger_entry().iter().any(|e| e.reference_id.as_deref() == Some(reference.as_str())) {
        return;
    }
    let pass = ctx
        .db
        .claim()
        .id()
        .find(decision.claim_id.clone())
        .and_then(|c| ctx.db.pass().id().find(c.pass_id));
    let pass_id = pass.as_ref().map(|p| p.id);
    let station_id = pass.map(|p| p.station_id);

    post_credit(
        ctx,
        pass_id,
        station_id.clone(),
        reference,
        format!("Credit issued for claim {}", decision.claim_id),
        decision.credit_amount_cents,
    );
    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: DecisionType::CreditIssued,
        outcome,
        pass_id,
        station_id,
        amount_cents: decision.credit_amount_cents,
        reason: format!(
            "{} credit for claim {} at {}% confidence",
            if outcome == DecisionOutcome::AutoApproved { "Auto-approved" } else { "Approved" },
            decision.claim_id,
            decision.confidence_percent
        ),
        policy_version: decision.policy_version.clone(),
        model_version: decision.model_version.clone(),
    });
    sync_kpis(ctx);
}

/// Credits the verified part of the model's loss estimate and routes it through
/// the confidence gate and the active Cedar policy, like `process_claim_decision`.
/// An auto-decided credit is paid straight to the ledger.
fn insert_decision(ctx: &ReducerContext, claim_id: String, confidence_percent: i32, model_version: String) {
    let Some(evidence) = ctx.db.claim_evidence().claim_id().find(claim_id.clone()) else {
        log::error!("No evidence for claim {}; seed_claim_evidence first", claim_id);
        return;
    };
    let credit_amount_cents = (evidence.estimated_loss_cents - evidence.missing_evidence_cents).max(0);
    let confidence = confidence_percent as i64;

    let mut route = determine_route(confidence);
    let authz_action = if route == DecisionRoute::AutoApprove { "auto_approve" } else { "recommend_approval" };
    let authz = check_authorization(ctx, "ai_analyst", authz_action, "Claim", &claim_id, credit_amount_cents, confidence);
    if route == DecisionRoute::AutoApprove && authz.decision != AuthzDecision::Allow {
        route = DecisionRoute::Escalated;
    }
    let policy_version = if authz.policy_version == "none" {
        crate::CURRENT_POLICY_VERSION.to_string()
    } else {
        authz.policy_version
    };

    let decision = ClaimDecision {
        claim_id,
        credit_amount_cents,
        confidence_percent,
        gate: match route {
            DecisionRoute::AutoApprove => ClaimGate::Auto,
            DecisionRoute::Escalated => ClaimGate::Escalated,
        },
        rule: decision_rule(route),
        policy_version,
        model_version,
        decided_at: ctx.timestamp,
    };
    if decision.gate == ClaimGate::Auto {
        pay_claim_credit(ctx, &decision, DecisionOutcome::AutoApproved);
    }
    ctx.db.claim_decision().insert(decision);
}

fn ledger_posted_for(ctx: &ReducerContext, claim_id: &str) -> bool {
    let reference = credit_reference(claim_id);
    ctx.db.ledger_entry().iter().any(|e| e.reference_id.as_deref() == Some(reference.as_str()))
}

/// Space weather for a claim is the `space_weather` reading nearest to signal loss.
fn insert_weather(ctx: &ReducerContext, claim_id: String) {
    let Some(pass) = ctx.db.claim_pass().claim_id().filter(&claim_id).next() else {
        log::error!("No pass for claim {}; seed_claim_pass first", claim_id);
        return;
    };
    let lost = pass.signal_lost_time.to_micros_since_unix_epoch();
    let kp_index = ctx
        .db
        .space_weather()
        .iter()
        .min_by_key(|w| (w.timestamp.to_micros_since_unix_epoch() - lost).abs())
        .map(|w| w.kp_index)
        .unwrap_or(0.0);
    ctx.db.claim_weather().insert(ClaimWeather {
        claim_id,
        kp_index,
        storm_active: kp_index >= STORM_KP_THRESHOLD,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim(
    ctx: &ReducerContext,
    id: String,
    customer_name: String,
    amount_claimed_cents: i64,
    pass_id: u64,
) {
    ctx.db.claim().insert(Claim {
        id,
        customer_name,
        amount_claimed_cents,
        pass_id,
        created_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_pass(
    ctx: &ReducerContext,
    id: u64,
    claim_id: String,
    station_lat: f64,
    station_lon: f64,
    station_name: String,
    satellite_norad_id: u32,
    satellite_tle1: String,
    satellite_tle2: String,
    contact_start_micros: i64,
    signal_lost_micros: i64,
    contact_end_micros: i64,
    max_elevation_deg: f64,
) {
    ctx.db.claim_pass().insert(ClaimPass {
        id,
        claim_id: claim_id.clone(),
        station_lat,
        station_lon,
        station_name,
        satellite_norad_id,
        satellite_tle1,
        satellite_tle2,
        contact_start_time: Timestamp::from_micros_since_unix_epoch(contact_start_micros),
        signal_lost_time: Timestamp::from_micros_since_unix_epoch(signal_lost_micros),
        contact_end_time: Timestamp::from_micros_since_unix_epoch(contact_end_micros),
        max_elevation_deg,
    });
    link_claim_to_pass(ctx, &claim_id, satellite_norad_id, contact_start_micros);
}

/// Points the claim at the billed `pass` row for the same satellite and contact
/// start, so its credit is posted against (and capped by) that pass's revenue.
fn link_claim_to_pass(ctx: &ReducerContext, claim_id: &str, norad_id: u32, contact_start_micros: i64) {
    let minute: i64 = 60 * 1_000_000;
    let billed = ctx
        .db
        .pass()
        .satellite_id()
        .filter(norad_id)
        .find(|p| (p.start_time.to_micros_since_unix_epoch() - contact_start_micros).abs() < minute);
    match (billed, ctx.db.claim().id().find(claim_id.to_string())) {
        (Some(pass), Some(claim)) => {
            ctx.db.claim().id().update(Claim { pass_id: pass.id, ..claim });
        }
        (None, _) => log::warn!("No billed pass for claim {}; credit will not reference a pass", claim_id),
        _ => {}
    }
}

#[spacetimedb::reducer]
pub fn seed_claim_evidence(
    ctx: &ReducerContext,
    claim_id: String,
    data_integrity_status: u8,
    estimated_loss_cents: i64,
    missing_evidence_cents: i64,
) {
    let status = match data_integrity_status {
        0 => DataIntegrityStatus::Pass,
        1 => DataIntegrityStatus::Fail,
        _ => DataIntegrityStatus::Pending,
    };
    ctx.db.claim_evidence().insert(ClaimEvidence {
        claim_id,
        data_integrity_status: status,
        estimated_loss_cents,
        missing_evidence_cents,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_decision(
    ctx: &ReducerContext,
    claim_id: String,
    confidence_percent: i32,
    model_version: String,
) {
    insert_decision(ctx, claim_id, confidence_percent, model_version);
}

#[spacetimedb::reducer]
pub fn seed_claim_reason(
    ctx: &ReducerContext,
    claim_id: String,
    feature: String,
    detail: String,
    shap_value: f32,
) {
    ctx.db.claim_reason().insert(ClaimReason {
        id: 0,
        claim_id,
        feature,
        detail,
        shap_value,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_outcome(
    ctx: &ReducerContext,
    claim_id: String,
    credit_memo_sent: bool,
    ledger_posted: bool,
) {
    let ledger_posted = ledger_posted || ledger_posted_for(ctx, &claim_id);
    ctx.db.claim_outcome().insert(ClaimOutcome {
        claim_id,
        credit_memo_sent,
        ledger_posted,
        completed_at: if credit_memo_sent && ledger_posted {
            Some(ctx.timestamp)
        } else {
            None
        },
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_weather(ctx: &ReducerContext, claim_id: String) {
    insert_weather(ctx, claim_id);
}

/// Fallback for seed.sh when no real pass can be computed: the same claim, built
/// from the seeded `station` and `satellite` rows during the fixture storm peak.
#[spacetimedb::reducer]
pub fn seed_demo_claim(ctx: &ReducerContext) {
    let claim_id = "CLM-10021".to_string();
    let pass_id: u64 = 10021;
    let minute: i64 = 60 * 1_000_000;
    let (Some(svalsat), Some(noaa20)) = (
        ctx.db.station().id().find("svalsat".to_string()),
        ctx.db.satellite().norad_id().find(43013),
    ) else {
        log::error!("Seed stations and satellites before seed_demo_claim");
        return;
    };

    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let contact_start = now_micros - 840 * minute;
    let signal_lost = contact_start + 5 * minute;
    let contact_end = contact_start + 12 * minute;

    ctx.db.claim().insert(Claim {
        id: claim_id.clone(),
        customer_name: "Northpoint Orbital".to_string(),
        amount_claimed_cents: 1_820_000,
        pass_id,
        created_at: ctx.timestamp,
    });

    ctx.db.claim_pass().insert(ClaimPass {
        id: pass_id,
        claim_id: claim_id.clone(),
        station_lat: svalsat.latitude,
        station_lon: svalsat.longitude,
        station_name: svalsat.name,
        satellite_norad_id: noaa20.norad_id,
        satellite_tle1: noaa20.tle_line1,
        satellite_tle2: noaa20.tle_line2,
        contact_start_time: Timestamp::from_micros_since_unix_epoch(contact_start),
        signal_lost_time: Timestamp::from_micros_since_unix_epoch(signal_lost),
        contact_end_time: Timestamp::from_micros_since_unix_epoch(contact_end),
        max_elevation_deg: 41.0,
    });

    ctx.db.claim_evidence().insert(ClaimEvidence {
        claim_id: claim_id.clone(),
        data_integrity_status: DataIntegrityStatus::Pass,
        estimated_loss_cents: 240_000,
        missing_evidence_cents: 125_000,
    });

    insert_weather(ctx, claim_id.clone());
    insert_decision(ctx, claim_id.clone(), 96, crate::CURRENT_MODEL_VERSION.to_string());

    ctx.db.claim_outcome().insert(ClaimOutcome {
        claim_id: claim_id.clone(),
        credit_memo_sent: false,
        ledger_posted: ledger_posted_for(ctx, &claim_id),
        completed_at: None,
    });

    let kp = ctx.db.claim_weather().claim_id().find(claim_id.clone()).map(|w| w.kp_index).unwrap_or(0.0);
    let reasons = [
        ("Downlink lost mid-contact", "7 of 12 min without telemetry".to_string(), 1.12),
        ("Geomagnetic storm at signal loss", format!("Kp {:.1}", kp), 0.64),
        ("Data integrity check", "passed".to_string(), 0.41),
        ("Max elevation", "41.0 deg".to_string(), 0.18),
        ("Unverified share of loss", "$1,250 of $2,400".to_string(), -0.37),
    ];
    for (feature, detail, shap_value) in reasons {
        ctx.db.claim_reason().insert(ClaimReason {
            id: 0,
            claim_id: claim_id.clone(),
            feature: feature.to_string(),
            detail,
            shap_value,
        });
    }

    log::info!("Demo claim CLM-10021 seeded");
}

#[spacetimedb::reducer]
pub fn update_claim_outcome(
    ctx: &ReducerContext,
    claim_id: String,
    credit_memo_sent: bool,
    ledger_posted: bool,
) {
    if let Some(outcome) = ctx.db.claim_outcome().claim_id().find(claim_id.clone()) {
        ctx.db.claim_outcome().claim_id().update(ClaimOutcome {
            credit_memo_sent,
            ledger_posted,
            completed_at: if credit_memo_sent && ledger_posted {
                Some(ctx.timestamp)
            } else {
                None
            },
            ..outcome
        });
    }
}

#[spacetimedb::reducer]
pub fn approve_claim_decision(ctx: &ReducerContext, claim_id: String) {
    if let Some(decision) = ctx.db.claim_decision().claim_id().find(claim_id.clone()) {
        if decision.gate == ClaimGate::Escalated {
            pay_claim_credit(ctx, &decision, DecisionOutcome::Approved);
            if let Some(outcome) = ctx.db.claim_outcome().claim_id().find(claim_id) {
                ctx.db.claim_outcome().claim_id().update(ClaimOutcome { ledger_posted: true, ..outcome });
            }
        }
    }
}

#[spacetimedb::reducer]
pub fn escalate_claim_decision(ctx: &ReducerContext, claim_id: String, reason: String) {
    if let Some(decision) = ctx.db.claim_decision().claim_id().find(claim_id.clone()) {
        ctx.db.claim_decision().claim_id().update(ClaimDecision {
            gate: ClaimGate::Escalated,
            decided_at: ctx.timestamp,
            ..decision
        });
        log::info!("Claim {} escalated: {}", claim_id, reason);
    }
}

#[cfg(test)]
mod tests {
    use super::decision_rule;
    use crate::confidence_gate::{determine_route, DecisionRoute};

    #[test]
    fn decision_rule_names_the_gate_condition() {
        let rule = |confidence| decision_rule(determine_route(confidence));
        assert_eq!(determine_route(96), DecisionRoute::AutoApprove);
        assert_eq!(rule(96), "auto_approve: confidence >= 95%");
        assert_eq!(rule(95), "auto_approve: confidence >= 95%");
        assert_eq!(rule(94), "escalate: confidence below 95%");
        assert_eq!(rule(70), "escalate: confidence below 95%");
    }
}
