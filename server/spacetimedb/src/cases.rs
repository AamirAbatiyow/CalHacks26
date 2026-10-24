//! Live claims: intake, evidence assembly, gating, and the human decision that
//! becomes a labeled example.

use serde::Deserialize;
use serde_json::json;
use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::approvals::{escalated_claim, EscalatedClaim, EscalatedClaimStatus};
use crate::authority::{check_authorization, AuthzDecision};
use crate::claim::{
    claim, claim_decision, claim_evidence, claim_outcome, claim_pass, claim_reason, claim_weather, Claim, ClaimDecision,
    ClaimEvidence, ClaimGate, ClaimOutcome, ClaimPass, ClaimReason, ClaimWeather, DataIntegrityStatus,
};
use crate::contracts::{customer_contract, dispute_message, extract_message_fields, station_maintenance, CustomerContract, DisputeMessage, StationMaintenance};
use crate::evidence::{assess, format_dollars, Assessment, Features, APPROVE, DENY, DECIDING_KEYS, PARTIAL};
use crate::learning::{active_policy_set, gate, insert_labeled, labeled_decision, learn_from_decision, learned_rule, parse_conditions, GateResult, LabeledDecision};
use crate::ledger::{ledger_entry, LedgerEntry, LedgerEntryType};
use crate::{decision_record, pass, satellite, space_weather, station, DecisionOutcome, DecisionRecord, DecisionType, FlareClass, Pass, PassStatus};

const MINUTE: i64 = 60 * 1_000_000;
const CLAIM_PASS_ID_OFFSET: u64 = 2_000_000_000;
const SIMILAR_NEIGHBOURS: usize = 25;

#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = claim_case, public)]
pub struct ClaimCase {
    #[primary_key]
    pub case_id: String,
    pub created_at: Timestamp,
    pub pass_id: u64,
    pub satellite_id: u32,
    pub satellite_name: String,
    pub station_id: String,
    pub station_name: String,
    pub customer_id: String,
    pub customer_name: String,
    pub claim_type: String,
    pub contact_start: Timestamp,
    pub signal_lost: Timestamp,
    pub contact_end: Timestamp,
    pub max_elevation_deg: f64,
    pub lost_pct: i64,
    pub kp: f32,
    pub flare: String,
    pub dst: i32,
    pub weather_band: String,
    pub maintenance: String,
    pub maintenance_id: Option<u64>,
    pub notice_hours: i64,
    pub integrity: String,
    pub pass_fee_cents: i64,
    pub claimed_cents: i64,
    pub contract_credit_cents: i64,
    pub msg_cites_weather: bool,
    pub msg_claims_full_loss: bool,
    pub msg_mentions_maintenance: bool,
    pub new_account: bool,
    pub recommended: String,
    pub outcome: String,
    pub credit_cents: i64,
    pub confidence: i64,
    /// auto | escalated | human
    pub gate: String,
    pub gate_note: String,
    pub policy_version: String,
    pub model_version: String,
    pub cited_rule: String,
    pub escalation_id: Option<u64>,
    pub decision_id: Option<u64>,
}

/// Model output the gate reads. System 1 may overwrite this row for a case.
#[spacetimedb::table(accessor = case_score, public)]
pub struct CaseScore {
    #[primary_key]
    pub case_id: String,
    pub ml_failure_prob: f32,
    pub confidence: i64,
    pub model_version: String,
    pub source: String,
}

#[spacetimedb::table(accessor = case_shap, public)]
pub struct CaseShap {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub case_id: String,
    pub feature: String,
    pub detail: String,
    pub value: f32,
}

/// Cedar rules evaluated for a case: `fired`, or a learned rule that `not_matched`.
#[spacetimedb::table(accessor = case_rule, public)]
pub struct CaseRule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub case_id: String,
    pub rule_id: String,
    pub policy_version: String,
    pub action: String,
    pub status: String,
    pub detail: String,
}

#[spacetimedb::table(accessor = case_conflict, public)]
pub struct CaseConflict {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub case_id: String,
    pub sources: String,
    pub detail: String,
    pub penalty: i64,
}

#[spacetimedb::table(accessor = case_similar, public)]
pub struct CaseSimilar {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub case_id: String,
    pub decision_id: u64,
    pub similarity: f32,
    pub rank: u32,
}

#[spacetimedb::table(accessor = case_option, public)]
pub struct CaseOption {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub case_id: String,
    pub label: String,
    pub outcome: String,
    pub credit_cents: i64,
    /// Effect on revenue (negative: credit paid).
    pub revenue_impact_cents: i64,
    /// How many of the nearest past decisions chose this outcome.
    pub similar_support: u32,
    pub similar_total: u32,
    pub recommended: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct IncomingClaim {
    pub case_id: String,
    pub customer_id: String,
    /// clear | near | excluded, relative to the customer's contract
    pub weather: String,
    pub lost_pct: i64,
    pub claimed_pct_of_fee: i64,
    pub integrity: String,
    pub maintenance: String,
    #[serde(default)]
    pub notice_hours: i64,
    pub channel: String,
    pub author: String,
    pub message: String,
}

pub fn fixture_incoming() -> Vec<IncomingClaim> {
    serde_json::from_str(include_str!("../../fixtures/incoming_claims.json")).expect("incoming_claims.json")
}

fn micros(t: Timestamp) -> i64 {
    t.to_micros_since_unix_epoch()
}

fn signal_lost_micros(pass: &Pass, lost_pct: i64) -> i64 {
    let start = micros(pass.start_time);
    let duration = micros(pass.end_time) - start;
    start + (duration * (100 - lost_pct.clamp(0, 100)) / 100).max(MINUTE)
}

struct Weather {
    kp: f32,
    flare: FlareClass,
    dst: i32,
}

fn weather_at(ctx: &ReducerContext, at: i64) -> Weather {
    ctx.db
        .space_weather()
        .iter()
        .min_by_key(|w| (micros(w.timestamp) - at).abs())
        .map(|w| Weather { kp: w.kp_index, flare: w.flare_class, dst: w.dst_index })
        .unwrap_or(Weather { kp: 0.0, flare: FlareClass::None, dst: 0 })
}

fn band_for(kp: f32, contract: &CustomerContract) -> &'static str {
    if kp >= contract.kp_exclusion {
        "excluded"
    } else if kp >= contract.kp_exclusion - 1.0 {
        "near"
    } else {
        "clear"
    }
}

fn used_passes(ctx: &ReducerContext) -> Vec<u64> {
    ctx.db.claim_case().iter().map(|c| c.pass_id).collect()
}

/// Completed passes in the last two days, oldest first.
fn recent_passes(ctx: &ReducerContext) -> Vec<Pass> {
    let now = micros(ctx.timestamp);
    let mut passes: Vec<Pass> = ctx
        .db
        .pass()
        .iter()
        .filter(|p| micros(p.end_time) < now && micros(p.start_time) > now - 48 * 60 * MINUTE)
        .filter(|p| matches!(p.status, PassStatus::Ok | PassStatus::Dropped))
        .collect();
    passes.sort_by_key(|p| (p.start_time, p.id));
    passes
}

fn pick_pass(ctx: &ReducerContext, candidates: &[Pass], used: &[u64], contract: &CustomerContract, weather: &str, lost_pct: i64) -> Option<Pass> {
    let want_dropped = lost_pct >= 90;
    let fits = |p: &&Pass| {
        !used.contains(&p.id) && band_for(weather_at(ctx, signal_lost_micros(p, lost_pct)).kp, contract) == weather
    };
    candidates
        .iter()
        .filter(fits)
        .find(|p| (p.status == PassStatus::Dropped) == want_dropped)
        .or_else(|| candidates.iter().find(fits))
        .cloned()
}

fn similarity(a: &Features, b: &Features) -> f32 {
    let weight = |k: &str| match k {
        "weather_band" | "maintenance" => 3.0,
        "claim_type" | "lost_band" | "integrity" | "claim_vs_contract" | "elevation_band" => 2.0,
        "msg_cites_weather" => 0.5,
        _ => 1.0,
    };
    let mut d = 0.0f32;
    for k in DECIDING_KEYS {
        if a.value(k) != b.value(k) {
            d += weight(k);
        }
    }
    d += ((a.kp - a.kp_exclusion) - (b.kp - b.kp_exclusion)).abs() * 0.5;
    d += (a.lost_pct - b.lost_pct).abs() as f32 / 50.0;
    1.0 / (1.0 + d)
}

fn nearest(ctx: &ReducerContext, f: &Features, k: usize) -> Vec<(LabeledDecision, f32)> {
    let mut scored: Vec<(LabeledDecision, f32)> = ctx.db.labeled_decision().iter().map(|d| {
        let s = similarity(f, &d.features());
        (d, s)
    }).collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.id.cmp(&a.0.id)));
    scored.truncate(k);
    scored
}

struct Intake<'a> {
    case_id: String,
    contract: &'a CustomerContract,
    pass: Pass,
    lost_pct: i64,
    claimed_cents: i64,
    integrity: String,
    maintenance: String,
    notice_hours: i64,
    channel: String,
    author: String,
    message: String,
}

fn flare_name(f: FlareClass) -> &'static str {
    match f {
        FlareClass::None => "none",
        FlareClass::C => "C",
        FlareClass::M => "M",
        FlareClass::X => "X",
    }
}

/// Assembles evidence for a claim, gates it through the active Cedar policy and
/// either decides it or queues it for a human with the full evidence packet.
fn analyze(ctx: &ReducerContext, intake: Intake) -> ClaimCase {
    let pass = &intake.pass;
    let lost_at = signal_lost_micros(pass, intake.lost_pct);
    let weather = weather_at(ctx, lost_at);
    let station = ctx.db.station().id().find(&pass.station_id);
    let sat = ctx.db.satellite().norad_id().find(pass.satellite_id);

    let maintenance_id = if intake.maintenance != "none" {
        let lead = if intake.maintenance == "unplanned" { 0 } else { intake.notice_hours };
        let row = ctx.db.station_maintenance().insert(StationMaintenance {
            id: 0,
            station_id: pass.station_id.clone(),
            start_time: Timestamp::from_micros_since_unix_epoch(micros(pass.start_time) - 20 * MINUTE),
            end_time: Timestamp::from_micros_since_unix_epoch(micros(pass.end_time) + 40 * MINUTE),
            kind: if intake.maintenance == "unplanned" { "unplanned" } else { "planned" }.to_string(),
            notice_hours: lead,
            description: if intake.maintenance == "unplanned" {
                "Unplanned outage: antenna drive fault".to_string()
            } else {
                format!("Planned feed upgrade, customer notice {}h ahead", lead)
            },
        });
        Some(row.id)
    } else {
        None
    };

    let fields = extract_message_fields(&intake.message);
    let f = Features::new(
        intake.contract,
        &pass.station_id,
        pass.revenue_cents,
        intake.claimed_cents,
        intake.lost_pct,
        pass.max_elevation_deg,
        weather.kp,
        &intake.maintenance,
        intake.notice_hours,
        &intake.integrity,
        fields,
    );
    let a = assess(&f);
    let (policy_version, policies) = active_policy_set(ctx);
    let g = gate(&policies, &f, &a);

    ctx.db.dispute_message().insert(DisputeMessage {
        id: 0,
        case_id: intake.case_id.clone(),
        received_at: Timestamp::from_micros_since_unix_epoch(micros(pass.end_time) + 50 * MINUTE),
        channel: intake.channel,
        author: intake.author,
        body: intake.message,
    });
    record_evidence(ctx, &intake.case_id, &f, &a, &g, &policy_version);

    let cited_rule = g.precedent.clone().or_else(|| g.fired.iter().find(|r| r.action == "auto_approve").map(|r| r.policy.clone())).unwrap_or_default();
    let mut case = ClaimCase {
        case_id: intake.case_id.clone(),
        created_at: ctx.timestamp,
        pass_id: pass.id,
        satellite_id: pass.satellite_id,
        satellite_name: sat.as_ref().map(|s| s.name.clone()).unwrap_or_default(),
        station_id: pass.station_id.clone(),
        station_name: station.as_ref().map(|s| s.name.clone()).unwrap_or_else(|| pass.station_id.clone()),
        customer_id: intake.contract.customer_id.clone(),
        customer_name: intake.contract.name.clone(),
        claim_type: f.claim_type.clone(),
        contact_start: pass.start_time,
        signal_lost: Timestamp::from_micros_since_unix_epoch(lost_at),
        contact_end: pass.end_time,
        max_elevation_deg: pass.max_elevation_deg,
        lost_pct: f.lost_pct,
        kp: weather.kp,
        flare: flare_name(weather.flare).to_string(),
        dst: weather.dst,
        weather_band: f.weather_band().to_string(),
        maintenance: f.maintenance.clone(),
        maintenance_id,
        notice_hours: f.notice_hours,
        integrity: f.integrity.clone(),
        pass_fee_cents: f.pass_fee_cents,
        claimed_cents: f.claimed_cents,
        contract_credit_cents: f.contract_credit_cents(),
        msg_cites_weather: fields.cites_weather,
        msg_claims_full_loss: fields.claims_full_loss,
        msg_mentions_maintenance: fields.mentions_maintenance,
        new_account: f.new_account,
        recommended: g.outcome.clone(),
        outcome: if g.auto { g.outcome.clone() } else { String::new() },
        credit_cents: g.credit_cents,
        confidence: g.confidence,
        gate: if g.auto { "auto" } else { "escalated" }.to_string(),
        gate_note: g.note.clone(),
        policy_version: policy_version.clone(),
        model_version: a.model_version.clone(),
        cited_rule: cited_rule.clone(),
        escalation_id: None,
        decision_id: None,
    };

    let reason = if g.auto {
        format!(
            "[Ground Truth] {} {} at {}% under policy {} ({})",
            case.case_id,
            g.outcome,
            g.confidence,
            policy_version,
            if cited_rule.is_empty() { "confidence gate".to_string() } else { cited_rule.clone() }
        )
    } else {
        format!("[Ground Truth] {} escalated at {}%: {}", case.case_id, g.confidence, g.note)
    };
    let (decision_type, outcome) = match (g.auto, g.outcome.as_str()) {
        (true, DENY) => (DecisionType::DisputeResolved, DecisionOutcome::Denied),
        (true, _) => (DecisionType::CreditIssued, DecisionOutcome::AutoApproved),
        (false, _) => (DecisionType::DisputeCreated, DecisionOutcome::Escalated),
    };
    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type,
        outcome,
        pass_id: Some(pass.id),
        station_id: Some(pass.station_id.clone()),
        amount_cents: if g.auto && g.outcome == DENY { f.claimed_cents } else { g.credit_cents },
        reason,
        policy_version: policy_version.clone(),
        model_version: a.model_version.clone(),
    });

    if g.auto && g.credit_cents > 0 {
        ctx.db.ledger_entry().insert(LedgerEntry {
            id: 0,
            created_at: ctx.timestamp,
            entry_type: LedgerEntryType::Credit,
            description: format!("Credit issued for {} ({})", case.case_id, case.customer_name),
            reference_id: Some(format!("CR-{}", case.case_id)),
            amount_cents: -g.credit_cents,
            dispute_id: None,
            pass_id: Some(pass.id),
            station_id: Some(pass.station_id.clone()),
        });
    }
    if !g.auto {
        let row = ctx.db.escalated_claim().insert(EscalatedClaim {
            id: 0,
            customer_name: case.customer_name.clone(),
            amount_claimed_cents: f.claimed_cents,
            proposed_amount_cents: g.credit_cents,
            confidence_pct: g.confidence.clamp(0, 100) as u8,
            escalation_reason: format!(
                "Confidence {}% below 95% auto-approval threshold. {}",
                g.confidence,
                a.conflicts.iter().map(|c| c.detail.clone()).collect::<Vec<_>>().join(". ")
            ),
            status: EscalatedClaimStatus::Pending,
            policy_version: policy_version.clone(),
            model_version: a.model_version.clone(),
            created_at: ctx.timestamp,
        });
        case.escalation_id = Some(row.id);
    }

    write_claim_page(ctx, &case, &f, &a, sat.as_ref().map(|s| (s.tle_line1.clone(), s.tle_line2.clone())), station.as_ref().map(|s| (s.latitude, s.longitude)));
    ctx.db.claim_case().insert(case.clone());
    crate::kpis::sync_kpis(ctx);
    case
}

fn record_evidence(ctx: &ReducerContext, case_id: &str, f: &Features, a: &Assessment, g: &GateResult, policy_version: &str) {
    ctx.db.case_score().insert(CaseScore {
        case_id: case_id.to_string(),
        ml_failure_prob: a.failure_prob as f32,
        confidence: a.confidence,
        model_version: a.model_version.clone(),
        source: "proxy".to_string(),
    });
    for s in &a.shap {
        ctx.db.case_shap().insert(CaseShap { id: 0, case_id: case_id.to_string(), feature: s.feature.clone(), detail: s.detail.clone(), value: s.value });
    }
    for c in &a.conflicts {
        ctx.db.case_conflict().insert(CaseConflict { id: 0, case_id: case_id.to_string(), sources: c.sources.clone(), detail: c.detail.clone(), penalty: c.penalty });
    }
    for r in &g.fired {
        ctx.db.case_rule().insert(CaseRule {
            id: 0,
            case_id: case_id.to_string(),
            rule_id: r.policy.clone(),
            policy_version: policy_version.to_string(),
            action: r.action.clone(),
            status: "fired".to_string(),
            detail: if r.action == "auto_approve" {
                format!("permit auto_approve: confidence {}% >= 95%", g.confidence)
            } else {
                format!("precedent sets outcome {} at {}%", r.outcome, g.confidence)
            },
        });
    }
    if !g.auto {
        ctx.db.case_rule().insert(CaseRule {
            id: 0,
            case_id: case_id.to_string(),
            rule_id: "auto-decide-95".to_string(),
            policy_version: policy_version.to_string(),
            action: "auto_approve".to_string(),
            status: "not_matched".to_string(),
            detail: format!("requires confidence >= 95%; this claim is {}%", g.confidence),
        });
    }
    for rule in ctx.db.learned_rule().policy_version_id().filter(&policy_version.to_string()) {
        if g.fired.iter().any(|r| r.policy == rule.rule_id) {
            continue;
        }
        let failed = parse_conditions(&rule.conditions)
            .into_iter()
            .find(|(k, v)| f.value(k).as_deref() != Some(v.as_str()))
            .map(|(k, v)| format!("needs {} = {}, claim has {}", k, v, f.value(&k).unwrap_or_default()))
            .unwrap_or_default();
        ctx.db.case_rule().insert(CaseRule {
            id: 0,
            case_id: case_id.to_string(),
            rule_id: rule.rule_id.clone(),
            policy_version: policy_version.to_string(),
            action: "apply_precedent".to_string(),
            status: "not_matched".to_string(),
            detail: failed,
        });
    }

    let neighbours = nearest(ctx, f, SIMILAR_NEIGHBOURS);
    for (rank, (d, s)) in neighbours.iter().take(6).enumerate() {
        ctx.db.case_similar().insert(CaseSimilar { id: 0, case_id: case_id.to_string(), decision_id: d.id, similarity: *s, rank: rank as u32 });
    }
    let support = |outcome: &str| neighbours.iter().filter(|(d, _)| d.outcome == outcome).count() as u32;
    let total = neighbours.len() as u32;
    let contract_credit = f.contract_credit_cents().min(f.claimed_cents);
    let pro_rata = f.pass_fee_cents * f.lost_pct / 100;
    let mut options: Vec<(String, &str, i64)> = vec![(format!("Credit per contract formula"), APPROVE, contract_credit)];
    if f.claimed_cents > contract_credit {
        options.push(("Pay as claimed".to_string(), APPROVE, f.claimed_cents));
    }
    if pro_rata > 0 && pro_rata < contract_credit {
        options.push(("Pro rata for minutes lost".to_string(), PARTIAL, pro_rata));
    }
    if f.claimed_cents > contract_credit && contract_credit > 0 {
        options[0] = ("Credit per contract formula".to_string(), PARTIAL, contract_credit);
    }
    options.push(("Deny under contract exclusions".to_string(), DENY, 0));
    for (label, outcome, credit) in options {
        ctx.db.case_option().insert(CaseOption {
            id: 0,
            case_id: case_id.to_string(),
            label,
            outcome: outcome.to_string(),
            credit_cents: credit,
            revenue_impact_cents: -credit,
            similar_support: support(outcome),
            similar_total: total,
            recommended: outcome == g.outcome && credit == g.credit_cents,
        });
    }
}

fn write_claim_page(ctx: &ReducerContext, case: &ClaimCase, f: &Features, a: &Assessment, tle: Option<(String, String)>, latlon: Option<(f64, f64)>) {
    let (lat, lon) = latlon.unwrap_or((0.0, 0.0));
    let (tle1, tle2) = tle.unwrap_or_default();
    ctx.db.claim().insert(Claim {
        id: case.case_id.clone(),
        customer_name: case.customer_name.clone(),
        amount_claimed_cents: case.claimed_cents,
        pass_id: case.pass_id,
        created_at: ctx.timestamp,
    });
    ctx.db.claim_pass().insert(ClaimPass {
        id: CLAIM_PASS_ID_OFFSET + case.pass_id,
        claim_id: case.case_id.clone(),
        station_lat: lat,
        station_lon: lon,
        station_name: case.station_name.clone(),
        satellite_norad_id: case.satellite_id,
        satellite_tle1: tle1,
        satellite_tle2: tle2,
        contact_start_time: case.contact_start,
        signal_lost_time: case.signal_lost,
        contact_end_time: case.contact_end,
        max_elevation_deg: case.max_elevation_deg,
    });
    ctx.db.claim_evidence().insert(ClaimEvidence {
        claim_id: case.case_id.clone(),
        data_integrity_status: match f.integrity.as_str() {
            "pass" => DataIntegrityStatus::Pass,
            "fail" => DataIntegrityStatus::Fail,
            _ => DataIntegrityStatus::Pending,
        },
        estimated_loss_cents: f.contract_credit_cents(),
        missing_evidence_cents: 0,
    });
    ctx.db.claim_weather().insert(ClaimWeather { claim_id: case.case_id.clone(), kp_index: case.kp, storm_active: case.kp >= 5.0 });
    ctx.db.claim_decision().insert(ClaimDecision {
        claim_id: case.case_id.clone(),
        credit_amount_cents: case.credit_cents,
        confidence_percent: case.confidence as i32,
        gate: if case.gate == "auto" { ClaimGate::Auto } else { ClaimGate::Escalated },
        rule: if case.gate == "auto" {
            format!("{} {}: {}", case.policy_version, case.cited_rule, case.outcome)
        } else {
            format!("escalate: {}", case.gate_note)
        },
        policy_version: case.policy_version.clone(),
        model_version: case.model_version.clone(),
        decided_at: ctx.timestamp,
    });
    for s in &a.shap {
        ctx.db.claim_reason().insert(ClaimReason { id: 0, claim_id: case.case_id.clone(), feature: s.feature.clone(), detail: s.detail.clone(), shap_value: s.value });
    }
    let auto_credit = case.gate == "auto" && case.credit_cents > 0;
    ctx.db.claim_outcome().insert(ClaimOutcome {
        claim_id: case.case_id.clone(),
        credit_memo_sent: auto_credit,
        ledger_posted: auto_credit,
        completed_at: if auto_credit { Some(ctx.timestamp) } else { None },
    });
}

#[spacetimedb::reducer]
pub fn seed_incoming_claims(ctx: &ReducerContext) {
    let candidates = recent_passes(ctx);
    for spec in fixture_incoming() {
        if ctx.db.claim_case().case_id().find(&spec.case_id).is_some() {
            continue;
        }
        let Some(contract) = ctx.db.customer_contract().customer_id().find(&spec.customer_id) else {
            log::error!("No contract for {}; run seed_contracts first", spec.customer_id);
            continue;
        };
        let used = used_passes(ctx);
        let Some(pass) = pick_pass(ctx, &candidates, &used, &contract, &spec.weather, spec.lost_pct) else {
            log::warn!("No unused pass with {} weather for {}", spec.weather, spec.case_id);
            continue;
        };
        let claimed = (pass.revenue_cents * spec.claimed_pct_of_fee / 100 / 100) * 100;
        analyze(ctx, Intake {
            case_id: spec.case_id,
            contract: &contract,
            pass,
            lost_pct: spec.lost_pct,
            claimed_cents: claimed,
            integrity: spec.integrity,
            maintenance: spec.maintenance,
            notice_hours: spec.notice_hours,
            channel: spec.channel,
            author: spec.author,
            message: spec.message,
        });
    }
}

fn next_case_id(ctx: &ReducerContext) -> String {
    let max = ctx
        .db
        .claim_case()
        .iter()
        .filter_map(|c| c.case_id.strip_prefix("CLM-").and_then(|n| n.parse::<u64>().ok()))
        .max()
        .unwrap_or(20000);
    format!("CLM-{}", max + 1)
}

/// Files a new claim on an unused pass whose evidence matches the source case on
/// every deciding feature except customer and station: the held-out test of a
/// learned policy.
#[spacetimedb::reducer]
pub fn submit_similar_claim(ctx: &ReducerContext, source_case_id: String) -> Result<(), String> {
    let source = ctx.db.claim_case().case_id().find(&source_case_id).ok_or("unknown case")?;
    let source_message = ctx.db.dispute_message().case_id().filter(&source_case_id).next();
    let source_contract = ctx.db.customer_contract().customer_id().find(&source.customer_id).ok_or("unknown contract")?;
    let source_features = Features::new(&source_contract, &source.station_id, source.pass_fee_cents, source.claimed_cents, source.lost_pct, source.max_elevation_deg, source.kp, &source.maintenance, source.notice_hours, &source.integrity, extract_message_fields(source_message.as_ref().map(|m| m.body.as_str()).unwrap_or("")));
    let keys = ["claim_type", "weather_band", "maintenance", "integrity", "lost_band", "claim_vs_contract", "elevation_band", "account"];

    let candidates = recent_passes(ctx);
    let used = used_passes(ctx);
    let mut contracts: Vec<CustomerContract> = ctx.db.customer_contract().iter().collect();
    contracts.sort_by_key(|c| (c.customer_id == source.customer_id, c.customer_id.clone()));
    let claimed_share = source.claimed_cents as f64 / source.pass_fee_cents.max(1) as f64;
    let body = source_message.as_ref().map(|m| m.body.clone()).unwrap_or_default();
    for contract in &contracts {
        for pass in candidates.iter().filter(|p| !used.contains(&p.id) && p.station_id != source.station_id) {
            let kp = weather_at(ctx, signal_lost_micros(pass, source.lost_pct)).kp;
            let claimed = ((pass.revenue_cents as f64 * claimed_share) / 100.0).round() as i64 * 100;
            let f = Features::new(contract, &pass.station_id, pass.revenue_cents, claimed, source.lost_pct, pass.max_elevation_deg, kp, &source.maintenance, source.notice_hours, &source.integrity, extract_message_fields(&body));
            if keys.iter().all(|k| f.value(k) == source_features.value(k)) {
                let case_id = next_case_id(ctx);
                analyze(ctx, Intake {
                    case_id,
                    contract,
                    pass: pass.clone(),
                    lost_pct: source.lost_pct,
                    claimed_cents: claimed,
                    integrity: source.integrity.clone(),
                    maintenance: source.maintenance.clone(),
                    notice_hours: source.notice_hours,
                    channel: "email".to_string(),
                    author: format!("{} operations", contract.name),
                    message: body.clone(),
                });
                return Ok(());
            }
        }
    }
    Err(format!("No unused pass matches {}'s deciding features", source_case_id))
}

fn case_snapshot(ctx: &ReducerContext, case: &ClaimCase, contract: &CustomerContract) -> String {
    let id = case.case_id.clone();
    let station_history: Vec<LabeledDecision> = ctx.db.labeled_decision().station_id().filter(&case.station_id).collect();
    let approved = station_history.iter().filter(|d| d.outcome != DENY).count();
    let maintenance: Vec<_> = ctx
        .db
        .station_maintenance()
        .station_id()
        .filter(&case.station_id)
        .map(|m| json!({"kind": m.kind, "start_micros": micros(m.start_time), "end_micros": micros(m.end_time), "notice_hours": m.notice_hours, "description": m.description}))
        .collect();
    let message = ctx.db.dispute_message().case_id().filter(&id).next();
    let score = ctx.db.case_score().case_id().find(&id);
    json!({
        "case_id": id,
        "claim_type": case.claim_type,
        "telemetry": {
            "pass_id": case.pass_id, "satellite": case.satellite_name, "station": case.station_name,
            "contact_start_micros": micros(case.contact_start), "signal_lost_micros": micros(case.signal_lost), "contact_end_micros": micros(case.contact_end),
            "max_elevation_deg": case.max_elevation_deg, "lost_pct": case.lost_pct, "integrity": case.integrity,
        },
        "space_weather": {"kp": case.kp, "flare": case.flare, "dst": case.dst, "kp_exclusion": contract.kp_exclusion, "band": case.weather_band},
        "station": {
            "id": case.station_id, "maintenance": case.maintenance, "notice_hours": case.notice_hours, "maintenance_log": maintenance,
            "history_decisions": station_history.len(), "history_credited": approved,
        },
        "contract": contract,
        "message": {
            "channel": message.as_ref().map(|m| m.channel.clone()), "author": message.as_ref().map(|m| m.author.clone()), "body": message.as_ref().map(|m| m.body.clone()),
            "extracted": {"cites_weather": case.msg_cites_weather, "claims_full_loss": case.msg_claims_full_loss, "mentions_maintenance": case.msg_mentions_maintenance},
        },
        "ml": {
            "failure_prob": score.as_ref().map(|s| s.ml_failure_prob), "confidence": score.as_ref().map(|s| s.confidence), "model_version": score.as_ref().map(|s| s.model_version.clone()),
            "shap": ctx.db.case_shap().case_id().filter(&id).map(|s| json!({"feature": s.feature, "detail": s.detail, "value": s.value})).collect::<Vec<_>>(),
        },
        "rules": ctx.db.case_rule().case_id().filter(&id).map(|r| json!({"rule": r.rule_id, "policy_version": r.policy_version, "action": r.action, "status": r.status, "detail": r.detail})).collect::<Vec<_>>(),
        "conflicts": ctx.db.case_conflict().case_id().filter(&id).map(|c| json!({"sources": c.sources, "detail": c.detail, "penalty": c.penalty})).collect::<Vec<_>>(),
        "similar_decision_ids": ctx.db.case_similar().case_id().filter(&id).map(|s| s.decision_id).collect::<Vec<_>>(),
        "options": ctx.db.case_option().case_id().filter(&id).map(|o| json!({"label": o.label, "outcome": o.outcome, "credit_cents": o.credit_cents})).collect::<Vec<_>>(),
        "money": {"pass_fee_cents": case.pass_fee_cents, "claimed_cents": case.claimed_cents, "contract_credit_cents": case.contract_credit_cents},
        "gate": {"confidence": case.confidence, "recommended": case.recommended, "note": case.gate_note, "policy_version": case.policy_version},
    })
    .to_string()
}

/// A reviewer's decision on an escalated case. Settles the Approvals item, stores
/// a complete labeled decision, and asks the miner whether a policy now follows.
#[spacetimedb::reducer]
pub fn decide_case(
    ctx: &ReducerContext,
    case_id: String,
    outcome: String,
    credit_cents: i64,
    reason_code: String,
    reason_text: String,
    decisive: Vec<String>,
    reviewer: String,
) -> Result<(), String> {
    if ![APPROVE, PARTIAL, DENY].contains(&outcome.as_str()) {
        return Err(format!("unknown outcome {}", outcome));
    }
    let case = ctx.db.claim_case().case_id().find(&case_id).ok_or("unknown case")?;
    if case.gate != "escalated" {
        return Err(format!("{} is not awaiting a human decision", case_id));
    }
    let contract = ctx.db.customer_contract().customer_id().find(&case.customer_id).ok_or("unknown contract")?;
    let credit = if outcome == DENY { 0 } else { credit_cents.clamp(0, case.pass_fee_cents.max(case.claimed_cents)) };
    let action = if outcome == DENY { "deny" } else { "approve" };
    let authz = check_authorization(ctx, "human_approver", action, "Claim", &case_id, credit, case.confidence);
    if authz.decision != AuthzDecision::Allow {
        return Err(format!("human_approver may not {}: {}", action, authz.reason));
    }

    if let Some(esc_id) = case.escalation_id {
        let esc = ctx.db.escalated_claim().id().find(esc_id);
        match (outcome.as_str(), esc) {
            (DENY, Some(_)) => crate::approvals::deny_escalated_claim(ctx, esc_id, case.policy_version.clone(), case.model_version.clone()),
            (_, Some(e)) if e.proposed_amount_cents == credit => crate::approvals::approve_escalated_claim(ctx, esc_id, case.policy_version.clone(), case.model_version.clone()),
            (_, Some(_)) => crate::approvals::edit_escalated_claim(ctx, esc_id, credit, case.policy_version.clone(), case.model_version.clone()),
            _ => {}
        }
    }

    let evidence_json = case_snapshot(ctx, &case, &contract);
    let decisive: Vec<String> = decisive.into_iter().filter(|k| DECIDING_KEYS.contains(&k.as_str())).collect();
    let score = ctx.db.case_score().case_id().find(&case_id);
    let decision_id = insert_labeled(ctx, LabeledDecision {
        id: 0,
        source: "live".to_string(),
        case_id: case_id.clone(),
        decided_at: ctx.timestamp,
        reviewer,
        claim_type: case.claim_type.clone(),
        customer_id: case.customer_id.clone(),
        customer_name: case.customer_name.clone(),
        tier: contract.tier.clone(),
        station_id: case.station_id.clone(),
        pass_fee_cents: case.pass_fee_cents,
        claimed_cents: case.claimed_cents,
        contract_credit_cents: case.contract_credit_cents,
        lost_pct: case.lost_pct,
        max_elevation_deg: case.max_elevation_deg,
        kp: case.kp,
        kp_exclusion: contract.kp_exclusion,
        maintenance: case.maintenance.clone(),
        notice_hours: case.notice_hours,
        required_notice_hours: contract.maintenance_notice_hours,
        integrity: case.integrity.clone(),
        msg_cites_weather: case.msg_cites_weather,
        msg_claims_full_loss: case.msg_claims_full_loss,
        msg_mentions_maintenance: case.msg_mentions_maintenance,
        new_account: case.new_account,
        full_credit_lost_pct: contract.full_credit_lost_pct,
        min_elevation_deg: contract.min_elevation_deg,
        ai_recommended: case.recommended.clone(),
        ai_confidence: case.confidence,
        ml_failure_prob: score.as_ref().map(|s| s.ml_failure_prob).unwrap_or(0.0),
        escalated: true,
        outcome: outcome.clone(),
        credit_cents: credit,
        reason_code,
        reason_text,
        decisive,
        policy_version: case.policy_version.clone(),
        model_version: case.model_version.clone(),
    }, evidence_json);

    if let Some(d) = ctx.db.claim_decision().claim_id().find(&case_id) {
        ctx.db.claim_decision().claim_id().update(ClaimDecision {
            credit_amount_cents: credit,
            rule: format!("human: {} {}", outcome, format_dollars(credit)),
            decided_at: ctx.timestamp,
            ..d
        });
    }
    ctx.db.claim_case().case_id().update(ClaimCase {
        outcome: outcome.clone(),
        credit_cents: credit,
        gate: "human".to_string(),
        decision_id: Some(decision_id),
        ..case
    });
    learn_from_decision(ctx, decision_id, &case_id);
    Ok(())
}
