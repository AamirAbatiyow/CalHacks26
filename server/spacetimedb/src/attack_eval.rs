//! Break It through the decision path. An attack the fraud screen does not stop
//! is decided the way a real claim is: features from the evidence tables, System 1,
//! then the Cedar policy. Every attack is decided twice, under an earlier policy and
//! model ("before") and under the active ones ("after"), and both results are stored
//! with the evidence, fired rules and System 1 terms the detail card shows.

use cedar_policy::PolicySet;
use serde_json::{json, Value};
use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::attack_run::{
    attack_fixture, attack_run, attack_run_session, dollars, plan_claim, AttackFixture, AttackResult, AttackRun, AttackRunSession, AttackType,
    ClaimPlan, Flag, PassFacts,
};
use crate::authority::{cedar_policy_store, check_authorization, AuthzDecision};
use crate::contracts::{customer_contract, extract_message_fields, maintenance_log, CustomerContract};
use crate::decision::{build_snapshot, contract_term, ensure_telemetry, model_version, nearest_weather, station_maintenance, ClaimType, ModelStatus};
use crate::decision_logic::{system1_features, system1_predict};
use crate::decision::pass_telemetry;
use crate::evidence::{assess, assess_with_model, recommend, Features, Shap, APPROVE, DECIDING_KEYS, DENY, PARTIAL};
use crate::learning::{active_policy_set, gate, insert_labeled, learn_from_decision, parse_policies, policy_proposal, AuditDecision, GateResult};
use crate::{pass, space_weather, PassStatus};

pub const BEFORE: &str = "before";
pub const AFTER: &str = "after";
pub const CAUGHT: &str = "caught";
pub const ESCALATED: &str = "escalated";
pub const MISSED: &str = "missed";

const DEFAULT_CUSTOMER: &str = "nexus";

#[spacetimedb::table(accessor = attack_eval, public)]
#[derive(Clone)]
pub struct AttackEval {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub session_id: u64,
    /// before | after
    pub label: String,
    pub fixture_id: u64,
    pub attack_type: AttackType,
    /// The log row this decision produced; only "after" rows have one.
    pub attack_run_id: Option<u64>,
    pub description: String,
    pub tried: String,
    pub policy_version: String,
    pub model_version: String,
    pub pass_id: u64,
    pub station_id: String,
    pub customer: String,
    pub claimed_cents: i64,
    pub reason: String,
    /// screen | role_check | policy
    pub decided_by: String,
    /// caught | escalated | missed
    pub outcome: String,
    /// approve | partial | deny | blocked | held
    pub decision: String,
    pub paid_cents: i64,
    /// What the evidence says is owed: zero for duplicates, forged stations and passes that never ran.
    pub supported_cents: i64,
    pub protected_cents: i64,
    pub bad_cents: i64,
    pub confidence: i64,
    pub s1_p_approve: Option<f64>,
    pub evidence_json: String,
    pub screen_json: String,
    pub rules_json: String,
    pub s1_json: String,
    pub why: String,
    /// "" until a human decides it (human) or a promoted policy re-decides it (cleared).
    pub review: String,
    /// Policy version that cleared it, or the audit case id of the human decision.
    pub review_ref: String,
    pub created_at: Timestamp,
}

/// One promotion re-deciding the attacks that were waiting for a human.
#[spacetimedb::table(accessor = attack_clearance, public)]
pub struct AttackClearance {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub session_id: u64,
    pub version_id: String,
    /// Audit case of the human decision the version was learned from, if any.
    pub trigger_case_id: String,
    pub held_before: u32,
    pub cleared: u32,
    pub still_held: u32,
    pub paid_cents: i64,
    pub protected_cents: i64,
    pub bad_cents: i64,
    pub created_at: Timestamp,
}

pub const CLUSTER: &str = "storm-overclaim";
const CLUSTER_SIZE: usize = 24;
const CLUSTER_PER_STATION: usize = 3;

pub struct Model {
    pub version: String,
    pub weights: Vec<f64>,
    pub names: Vec<String>,
}

pub struct Config {
    pub label: &'static str,
    pub policy_version: String,
    pub policies: PolicySet,
    pub model: Option<Model>,
}

impl Config {
    pub fn model_version(&self) -> String {
        self.model.as_ref().map(|m| m.version.clone()).unwrap_or_else(|| crate::evidence::PROXY_MODEL_VERSION.to_string())
    }
}

fn load_model(row: &crate::decision::ModelVersion) -> Option<Model> {
    Some(Model {
        version: format!("s1-v{}", row.version),
        weights: serde_json::from_str(&row.weights_json).ok()?,
        names: serde_json::from_str(&row.feature_names_json).ok()?,
    })
}

/// "before" is the policy the first learned version was built on, with the first
/// System 1 model; "after" is the active policy and model.
pub fn configs(ctx: &ReducerContext) -> (Config, Config) {
    let (after_version, after_policies) = active_policy_set(ctx);
    let mut proposals: Vec<_> = ctx.db.policy_proposal().iter().filter(|p| p.origin != "threshold_change").collect();
    proposals.sort_by_key(|p| p.created_at);
    let before_version = proposals.first().map(|p| p.base_version_id.clone()).unwrap_or_else(|| after_version.clone());
    let before_policies = ctx
        .db
        .cedar_policy_store()
        .version()
        .find(before_version.clone())
        .and_then(|p| parse_policies(&p.policy_text).ok())
        .unwrap_or_else(|| after_policies.clone());

    let mut models: Vec<_> = ctx.db.model_version().iter().filter(|m| m.status != ModelStatus::Rejected).collect();
    models.sort_by_key(|m| m.version);
    let before_model = models.first().and_then(load_model);
    let after_model = models.iter().find(|m| m.status == ModelStatus::Active).and_then(load_model);

    (
        Config { label: BEFORE, policy_version: before_version, policies: before_policies, model: before_model },
        Config { label: AFTER, policy_version: after_version, policies: after_policies, model: after_model },
    )
}

pub fn tried(attack_type: AttackType) -> &'static str {
    match attack_type {
        AttackType::InflatedClaim => "Inflate the amount above what the pass is worth",
        AttackType::DuplicateClaim => "Get paid twice for the same pass",
        AttackType::ForgedStationLog => "Claim a pass under a station or log that does not match the record",
        AttackType::InsiderRaisesOwnLimit => "Raise its own authority before claiming",
        AttackType::SpaceWeatherExcuse => "Blame space weather for a loss the record does not show",
        AttackType::ContractOutsideSla => "Claim a pass the contract does not cover",
        AttackType::MessyData => "Slip malformed text past the parser",
        AttackType::ModelStress => "Confuse the model with adversarial text on an inflated claim",
        AttackType::Recovery => "Keep a payout that should be clawed back on re-audit",
        AttackType::PromptInjection => "Instruct System 2 to approve",
    }
}

/// Everything about an attack that does not depend on the policy or model.
pub struct ClaimAttack<'a> {
    pub fixture: &'a AttackFixture,
    pub plan: &'a ClaimPlan,
    pub pass: Option<&'a PassFacts>,
    pub flags: &'a [Flag],
    pub on_target: &'a [Flag],
}

fn blank(ctx: &ReducerContext, session_id: u64, cfg: &Config, fixture: &AttackFixture) -> AttackEval {
    AttackEval {
        id: 0,
        session_id,
        label: cfg.label.to_string(),
        fixture_id: fixture.id,
        attack_type: fixture.attack_type,
        attack_run_id: None,
        description: fixture.description.clone(),
        tried: tried(fixture.attack_type).to_string(),
        policy_version: cfg.policy_version.clone(),
        model_version: cfg.model_version(),
        pass_id: 0,
        station_id: String::new(),
        customer: String::new(),
        claimed_cents: fixture.amount_cents,
        reason: String::new(),
        decided_by: String::new(),
        outcome: String::new(),
        decision: String::new(),
        paid_cents: 0,
        supported_cents: 0,
        protected_cents: 0,
        bad_cents: 0,
        confidence: 0,
        s1_p_approve: None,
        evidence_json: "{}".to_string(),
        screen_json: "[]".to_string(),
        rules_json: "{}".to_string(),
        s1_json: "{}".to_string(),
        why: String::new(),
        review: String::new(),
        review_ref: String::new(),
        created_at: ctx.timestamp,
    }
}

pub fn insider(ctx: &ReducerContext, session_id: u64, cfg: &Config, fixture: &AttackFixture, blocked: Option<&str>, role: &str) -> AttackEval {
    let mut row = blank(ctx, session_id, cfg, fixture);
    row.decided_by = "role_check".to_string();
    row.customer = role.to_string();
    row.screen_json = json!([{ "check": "Privilege", "detail": blocked.unwrap_or("allowed for this role"), "on_target": blocked.is_some() }]).to_string();
    match blocked {
        Some(reason) => {
            row.outcome = CAUGHT.to_string();
            row.decision = "blocked".to_string();
            row.protected_cents = fixture.amount_cents;
            row.why = format!("The role check refused it: {}. Role checks do not depend on the policy or model version.", reason);
        }
        None => {
            row.outcome = MISSED.to_string();
            row.decision = "approve".to_string();
            row.paid_cents = fixture.amount_cents;
            row.bad_cents = fixture.amount_cents;
            row.why = format!("A {} may change this setting, so the change went through. Role checks do not depend on the policy or model version.", role);
        }
    }
    row
}

fn contract(ctx: &ReducerContext, params: &str) -> Option<CustomerContract> {
    let id = crate::attack_run::extract_param(params, "customer").unwrap_or_else(|| DEFAULT_CUSTOMER.to_string());
    ctx.db.customer_contract().customer_id().find(&id).or_else(|| ctx.db.customer_contract().iter().next())
}

/// Features of an attack claim from the evidence tables, plus what the evidence says is owed.
fn evidence(ctx: &ReducerContext, contract: &CustomerContract, p: &crate::Pass, atk: &ClaimAttack) -> (Features, i64, Vec<String>, Value) {
    let telemetry = ensure_telemetry(ctx, p);
    let start = p.start_time.to_micros_since_unix_epoch();
    let end = p.end_time.to_micros_since_unix_epoch();
    let lost_at = start + telemetry.signal_lost_offset_s.map(|s| s as i64 * 1_000_000).unwrap_or((end - start) / 2);
    let weather = nearest_weather(ctx, lost_at);
    let kp = weather.as_ref().map(|w| w.kp_index).unwrap_or(0.0);
    let maint = ctx.db.maintenance_log().station_id().filter(&p.station_id).find(|m| {
        m.start_time.to_micros_since_unix_epoch() < end && m.end_time.to_micros_since_unix_epoch() > start
    });
    let station_maint = ctx.db.station_maintenance().station_id().filter(&p.station_id).find(|m| {
        m.start_time.to_micros_since_unix_epoch() < end && m.end_time.to_micros_since_unix_epoch() > start
    });
    let (maintenance, notice) = match (&maint, &station_maint) {
        (Some(m), _) if m.kind == "unplanned" => ("unplanned", 0),
        (Some(m), _) if m.notice_hours < contract.maintenance_notice_hours => ("short_notice", m.notice_hours),
        (Some(m), _) => ("notified", m.notice_hours),
        (None, Some(_)) => ("notified", contract.maintenance_notice_hours),
        (None, None) => ("none", 0),
    };
    let f = Features::new(
        contract,
        &atk.plan.station_id,
        p.revenue_cents,
        atk.plan.amount_cents,
        telemetry.loss_pct as i64,
        p.max_elevation_deg,
        kp,
        maintenance,
        notice,
        "pass",
        extract_message_fields(atk.plan.reason),
    );

    let mut not_owed = Vec::new();
    if let Some(after) = atk.plan.duplicate_after_micros {
        not_owed.push(format!("the same pass was already claimed {}h earlier{}", after / 3_600_000_000, if atk.plan.duplicate_from_other_owner { " from a second account" } else { "" }));
    }
    if atk.plan.station_id != p.station_id {
        not_owed.push(format!("pass {} ran at {}, not {}", p.id, p.station_id, atk.plan.station_id));
    }
    if !matches!(p.status, PassStatus::Ok | PassStatus::Dropped) {
        not_owed.push(format!("pass {} had not finished ({:?})", p.id, p.status));
    }
    let owed = if not_owed.is_empty() { f.credit_for(recommend(&f)) } else { 0 };
    let evidence = json!({
        "pass": {
            "id": p.id, "station_id": p.station_id, "satellite_id": p.satellite_id, "status": format!("{:?}", p.status),
            "start_micros": start, "end_micros": end, "max_elevation_deg": p.max_elevation_deg, "revenue_cents": p.revenue_cents,
        },
        "telemetry": { "loss_pct": telemetry.loss_pct, "received_mb": telemetry.received_mb, "expected_mb": telemetry.expected_mb, "signal_lost_offset_s": telemetry.signal_lost_offset_s, "source": telemetry.source },
        "weather": { "kp": kp, "at_micros": weather.as_ref().map(|w| w.timestamp.to_micros_since_unix_epoch()), "flare": weather.as_ref().map(|w| format!("{:?}", w.flare_class)) },
        "maintenance": { "state": maintenance, "notice_hours": notice, "log": maint.as_ref().map(|m| m.description.clone()).or_else(|| station_maint.as_ref().map(|m| m.note.clone())) },
        "contract": { "customer_id": contract.customer_id, "name": contract.name, "tier": contract.tier, "kp_exclusion": contract.kp_exclusion, "full_credit_lost_pct": contract.full_credit_lost_pct, "min_elevation_deg": contract.min_elevation_deg, "credit_cents": f.contract_credit_cents() },
        "features": f.deciding().into_iter().map(|(k, v)| json!({ "key": k, "value": v })).collect::<Vec<_>>(),
        "owed_cents": owed,
        "not_owed": not_owed,
    });
    (f, owed, not_owed, evidence)
}

fn system1(ctx: &ReducerContext, model: &Model, p: &crate::Pass, contract: &CustomerContract, claimed: i64) -> Option<(f64, Vec<Shap>, Value)> {
    let term = ctx.db.contract_term().customer().find(&contract.name).or_else(|| ctx.db.contract_term().iter().next())?;
    let claim_type = if p.status == PassStatus::Dropped { ClaimType::DroppedPass } else { ClaimType::DegradedLink };
    let (snapshot, _) = build_snapshot(ctx, p, "attack", claim_type, &term, claimed);
    let x = system1_features(&snapshot, &model.names);
    let p_approve = system1_predict(&model.weights, &x);
    let mut terms: Vec<(String, f64, f64)> = model.names.iter().zip(&x).zip(&model.weights).map(|((n, v), w)| (n.clone(), *v, w * v)).collect();
    terms.sort_by(|a, b| b.2.abs().total_cmp(&a.2.abs()));
    let shap = terms.iter().filter(|t| t.2.abs() >= 0.01 && t.0 != "bias").take(8).map(|(n, v, c)| Shap { feature: n.clone(), detail: format!("x = {:.2}", v), value: *c as f32 }).collect();
    let detail = json!({
        "model_version": model.version,
        "p_approve": p_approve,
        "terms": terms.iter().take(10).map(|(n, v, c)| json!({ "feature": n, "x": v, "contribution": c })).collect::<Vec<_>>(),
    });
    Some((p_approve, shap, detail))
}

fn rules_json(cfg: &Config, g: &GateResult) -> String {
    json!({
        "policy_version": cfg.policy_version,
        "fired": g.fired.iter().map(|r| json!({ "policy": r.policy, "action": r.action, "outcome": r.outcome })).collect::<Vec<_>>(),
        "precedent": g.precedent,
        "auto": g.auto,
        "confidence": g.confidence,
        "note": g.note,
    })
    .to_string()
}

pub fn claim(ctx: &ReducerContext, session_id: u64, cfg: &Config, atk: &ClaimAttack) -> AttackEval {
    let mut row = blank(ctx, session_id, cfg, atk.fixture);
    row.pass_id = atk.plan.pass_id;
    row.station_id = atk.plan.station_id.clone();
    row.claimed_cents = atk.plan.amount_cents;
    row.reason = atk.plan.reason.to_string();
    row.screen_json = Value::Array(
        atk.flags
            .iter()
            .map(|f| json!({ "check": format!("{:?}", f.check), "detail": f.detail, "on_target": atk.on_target.iter().any(|t| t.check == f.check) }))
            .collect(),
    )
    .to_string();

    if !atk.on_target.is_empty() {
        row.decided_by = "screen".to_string();
        row.outcome = CAUGHT.to_string();
        row.decision = "blocked".to_string();
        row.protected_cents = atk.plan.amount_cents;
        row.why = format!(
            "The fraud screen {} it before any model or policy ran: {}.",
            if atk.plan.audit { "flagged the approved claim on re-audit and recovered" } else { "blocked" },
            atk.on_target.iter().map(|f| f.detail.as_str()).collect::<Vec<_>>().join("; ")
        );
        return row;
    }

    decide(ctx, cfg, row, atk)
}

/// The decision path an attack takes once the screen lets it through.
fn decide(ctx: &ReducerContext, cfg: &Config, mut row: AttackEval, atk: &ClaimAttack) -> AttackEval {
    let Some(p) = atk.pass.and_then(|facts| ctx.db.pass().id().find(facts.id)) else {
        row.decided_by = "screen".to_string();
        row.outcome = MISSED.to_string();
        row.decision = "approve".to_string();
        row.paid_cents = atk.plan.amount_cents;
        row.bad_cents = atk.plan.amount_cents;
        row.why = "No pass record to decide it against, and the screen did not flag it.".to_string();
        return row;
    };
    let Some(contract) = contract(ctx, &atk.fixture.attack_params) else {
        row.decided_by = "policy".to_string();
        row.outcome = ESCALATED.to_string();
        row.decision = "held".to_string();
        row.why = "No customer contract is seeded, so it went to a human.".to_string();
        return row;
    };
    row.customer = contract.name.clone();
    let (f, owed, not_owed, evidence) = evidence(ctx, &contract, &p, atk);
    row.supported_cents = owed;
    row.evidence_json = evidence.to_string();

    let assessment = match cfg.model.as_ref().and_then(|m| system1(ctx, m, &p, &contract, atk.plan.amount_cents)) {
        Some((p_approve, shap, detail)) => {
            row.s1_p_approve = Some(p_approve);
            row.s1_json = detail.to_string();
            assess_with_model(&f, p_approve, &cfg.model_version(), shap)
        }
        None => {
            let a = assess(&f);
            row.s1_json = json!({ "model_version": a.model_version, "p_approve": a.failure_prob, "proxy": true,
                "terms": a.shap.iter().map(|s| json!({ "feature": s.feature, "x": s.detail, "contribution": s.value })).collect::<Vec<_>>() }).to_string();
            row.s1_p_approve = Some(a.failure_prob);
            a
        }
    };
    let g = gate(&cfg.policies, &f, &assessment);
    row.decided_by = "policy".to_string();
    row.confidence = g.confidence;
    row.rules_json = rules_json(cfg, &g);
    let by = g.precedent.clone().map(|r| format!("learned rule {}", r)).unwrap_or_else(|| "System 1 and the contract formula".to_string());
    let conflicts: Vec<String> = assessment.conflicts.iter().map(|c| format!("{} (-{})", c.detail, c.penalty)).collect();

    if !g.auto {
        row.outcome = ESCALATED.to_string();
        row.decision = "held".to_string();
        row.why = format!(
            "Confidence {}% is below 95% under {}, so nothing was paid and the claim waits for a human approver.{}",
            g.confidence,
            cfg.policy_version,
            if conflicts.is_empty() { String::new() } else { format!(" Conflicts: {}.", conflicts.join("; ")) }
        );
        return row;
    }
    row.decision = g.outcome.clone();
    row.paid_cents = if g.outcome == DENY { 0 } else { g.credit_cents };
    if row.paid_cents <= owed {
        row.outcome = CAUGHT.to_string();
        row.protected_cents = atk.plan.amount_cents - row.paid_cents;
        row.why = format!(
            "{} auto-decided {} at {}% confidence under {}: paid {} of the {} claimed, which the evidence supports{}.",
            capitalize(&by),
            g.outcome,
            g.confidence,
            cfg.policy_version,
            dollars(row.paid_cents),
            dollars(atk.plan.amount_cents),
            if owed > row.paid_cents { format!(" (up to {})", dollars(owed)) } else { String::new() }
        );
    } else {
        row.outcome = MISSED.to_string();
        row.bad_cents = row.paid_cents - owed;
        row.why = format!(
            "{} auto-decided {} at {}% confidence under {} and paid {}, but {} is owed: {}.",
            capitalize(&by),
            g.outcome,
            g.confidence,
            cfg.policy_version,
            dollars(row.paid_cents),
            dollars(owed),
            if not_owed.is_empty() { "the evidence supports less".to_string() } else { not_owed.join("; ") }
        );
    }
    row
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

pub fn clear(ctx: &ReducerContext) {
    for row in ctx.db.attack_eval().iter() {
        ctx.db.attack_eval().id().delete(row.id);
    }
    for row in ctx.db.attack_clearance().iter() {
        ctx.db.attack_clearance().id().delete(row.id);
    }
}

// ------------------------------------------------------------ live learning cluster

/// Storm-overclaim attacks: completed passes that lost 10-24% of the contact while
/// Kp sat just under the contract's storm exclusion, each claiming the full fee and
/// blaming the storm. The screen passes them (the storm was real) and the confidence
/// gate holds them for a human, so one human decision on the pattern decides all.
pub fn cluster_fixtures(ctx: &ReducerContext, used: &[u64]) -> Vec<AttackFixture> {
    let Some(contract) = ctx.db.customer_contract().customer_id().find(&DEFAULT_CUSTOMER.to_string()) else { return Vec::new() };
    let mut weather: Vec<(i64, f32)> = ctx.db.space_weather().iter().map(|w| (w.timestamp.to_micros_since_unix_epoch(), w.kp_index)).collect();
    weather.sort_by_key(|w| w.0);
    if weather.is_empty() {
        return Vec::new();
    }
    let kp_at = |t: i64| -> f32 {
        let i = weather.partition_point(|w| w.0 < t);
        let near = [i.checked_sub(1), Some(i)].into_iter().flatten().filter_map(|j| weather.get(j)).min_by_key(|w| (w.0 - t).abs());
        near.map(|w| w.1).unwrap_or(0.0)
    };
    let maintained: Vec<(String, i64, i64)> = ctx
        .db
        .maintenance_log()
        .iter()
        .map(|m| (m.station_id, m.start_time.to_micros_since_unix_epoch(), m.end_time.to_micros_since_unix_epoch()))
        .chain(ctx.db.station_maintenance().iter().map(|m| (m.station_id, m.start_time.to_micros_since_unix_epoch(), m.end_time.to_micros_since_unix_epoch())))
        .collect();
    let lo = contract.kp_exclusion - 1.0;
    let mut picks: Vec<(u64, String, i64, u32, f32)> = Vec::new();
    let mut candidates: Vec<crate::Pass> = ctx
        .db
        .pass()
        .iter()
        .filter(|p| p.status == PassStatus::Ok && p.max_elevation_deg >= contract.min_elevation_deg && !used.contains(&p.id))
        .collect();
    candidates.sort_by_key(|p| p.id);
    for p in candidates {
        let start = p.start_time.to_micros_since_unix_epoch();
        let end = p.end_time.to_micros_since_unix_epoch();
        let t = ctx.db.pass_telemetry().pass_id().find(p.id).map(|t| (t.loss_pct, t.signal_lost_offset_s)).unwrap_or_else(|| {
            let d = crate::decision_logic::derive_telemetry(p.id, false, true, (end - start) / 1_000_000);
            (d.loss_pct, d.signal_lost_offset_s)
        });
        if !(10..25).contains(&t.0) {
            continue;
        }
        let lost_at = start + t.1.map(|s| s as i64 * 1_000_000).unwrap_or((end - start) / 2);
        let kp = kp_at(lost_at);
        if kp < lo || kp >= contract.kp_exclusion {
            continue;
        }
        if maintained.iter().any(|(st, a, b)| *st == p.station_id && *a < end && *b > start) {
            continue;
        }
        if picks.iter().filter(|x| x.1 == p.station_id).count() >= CLUSTER_PER_STATION {
            continue;
        }
        picks.push((p.id, p.station_id.clone(), p.revenue_cents, t.0, kp));
        if picks.len() == CLUSTER_SIZE {
            break;
        }
    }
    picks
        .into_iter()
        .map(|(id, station, fee, lost, kp)| AttackFixture {
            id: 0,
            attack_type: AttackType::SpaceWeatherExcuse,
            amount_cents: fee,
            description: format!("Full fee claimed for a {} pass that lost {}%, blaming a Kp {:.1} storm under the exclusion", station, lost, kp),
            attack_params: format!("pass_id={},customer={},reason=storm_full,cluster={}", id, DEFAULT_CUSTOMER, CLUSTER),
        })
        .collect()
}

fn latest_session(ctx: &ReducerContext) -> Option<u64> {
    ctx.db.attack_run_session().iter().map(|s| s.id).max()
}

/// Rebuilds an attack's claim from its fixture for a second decision. Only attacks
/// that passed the screen are re-decided, so no flag is on target.
fn rebuild(ctx: &ReducerContext, row: &AttackEval) -> Option<(AttackFixture, ClaimPlan, Option<PassFacts>)> {
    let fixture = ctx.db.attack_fixture().id().find(row.fixture_id)?;
    let passes: Vec<PassFacts> = ctx
        .db
        .pass()
        .iter()
        .map(|p| PassFacts { id: p.id, satellite_id: p.satellite_id, station_id: p.station_id, start_micros: p.start_time.to_micros_since_unix_epoch(), end_micros: p.end_time.to_micros_since_unix_epoch(), revenue_cents: p.revenue_cents })
        .collect();
    let plan = plan_claim(fixture.amount_cents, &fixture.attack_params, &passes).ok()?;
    let pass = passes.into_iter().find(|p| p.id == plan.pass_id);
    Some((fixture, plan, pass))
}

/// Moves an "after" row's effect on its log row and run totals to its new outcome.
fn retally(ctx: &ReducerContext, old: &AttackEval, new: &AttackEval, note: &str) {
    let Some(session) = ctx.db.attack_run_session().id().find(old.session_id) else { return };
    let count = |o: &str, k: &str| (o == k) as u32;
    ctx.db.attack_run_session().id().update(AttackRunSession {
        caught: session.caught + count(&new.outcome, CAUGHT) - count(&old.outcome, CAUGHT),
        missed: session.missed + count(&new.outcome, MISSED) - count(&old.outcome, MISSED),
        dollars_protected_cents: session.dollars_protected_cents + new.protected_cents - old.protected_cents,
        bad_payouts_cents: session.bad_payouts_cents + new.bad_cents - old.bad_cents,
        ..session
    });
    if let Some(run) = old.attack_run_id.and_then(|id| ctx.db.attack_run().id().find(id)) {
        let result = match new.outcome.as_str() {
            CAUGHT => AttackResult::Caught,
            MISSED => AttackResult::Missed,
            _ => AttackResult::Pending,
        };
        ctx.db.attack_run().id().update(AttackRun { result, log_message: format!("{}: {} - {}", crate::attack_run::attack_type_name(new.attack_type), note, new.why), ..run });
    }
}

/// A human approver decides one held attack. Stored as a labeled audit decision with
/// the evidence the reviewer saw, then mined exactly like an Approvals decision.
#[spacetimedb::reducer]
pub fn decide_attack(
    ctx: &ReducerContext,
    eval_id: u64,
    outcome: String,
    credit_cents: i64,
    reason_text: String,
    decisive: Vec<String>,
    reviewer: String,
) -> Result<(), String> {
    if ![APPROVE, PARTIAL, DENY].contains(&outcome.as_str()) {
        return Err(format!("unknown outcome {}", outcome));
    }
    let row = ctx.db.attack_eval().id().find(eval_id).ok_or("unknown attack")?;
    if row.label != AFTER || row.outcome != ESCALATED || !row.review.is_empty() {
        return Err("this attack is not waiting for a human decision".to_string());
    }
    let (fixture, plan, pass) = rebuild(ctx, &row).ok_or("the attack's pass is no longer seeded")?;
    let p = pass.as_ref().and_then(|f| ctx.db.pass().id().find(f.id)).ok_or("the attack's pass is no longer seeded")?;
    let contract = contract(ctx, &fixture.attack_params).ok_or("no customer contract")?;
    let atk = ClaimAttack { fixture: &fixture, plan: &plan, pass: pass.as_ref(), flags: &[], on_target: &[] };
    let (f, owed, _, evidence_json) = evidence(ctx, &contract, &p, &atk);
    let credit = if outcome == DENY { 0 } else { credit_cents.clamp(0, plan.amount_cents) };
    let case_id = format!("ATK-{}", eval_id);
    let action = if outcome == DENY { "deny" } else { "approve" };
    let authz = check_authorization(ctx, "human_approver", action, "Claim", &case_id, credit, row.confidence);
    if authz.decision != AuthzDecision::Allow {
        return Err(format!("human_approver may not {}: {}", action, authz.reason));
    }
    let decisive: Vec<String> = decisive.into_iter().filter(|k| DECIDING_KEYS.contains(&k.as_str())).collect();
    let decision_id = insert_labeled(ctx, AuditDecision {
        id: 0,
        source: "live".to_string(),
        case_id: case_id.clone(),
        decided_at: ctx.timestamp,
        reviewer: reviewer.clone(),
        claim_type: f.claim_type.clone(),
        customer_id: f.customer_id.clone(),
        customer_name: contract.name.clone(),
        tier: f.tier.clone(),
        station_id: f.station_id.clone(),
        pass_fee_cents: f.pass_fee_cents,
        claimed_cents: f.claimed_cents,
        contract_credit_cents: f.contract_credit_cents(),
        lost_pct: f.lost_pct,
        max_elevation_deg: f.max_elevation_deg,
        kp: f.kp,
        kp_exclusion: f.kp_exclusion,
        maintenance: f.maintenance.clone(),
        notice_hours: f.notice_hours,
        required_notice_hours: f.required_notice_hours,
        integrity: f.integrity.clone(),
        msg_cites_weather: f.msg.cites_weather,
        msg_claims_full_loss: f.msg.claims_full_loss,
        msg_mentions_maintenance: f.msg.mentions_maintenance,
        new_account: f.new_account,
        full_credit_lost_pct: f.full_credit_lost_pct,
        min_elevation_deg: f.min_elevation_deg,
        ai_recommended: recommend(&f).to_string(),
        ai_confidence: row.confidence,
        ml_failure_prob: row.s1_p_approve.unwrap_or(0.0) as f32,
        escalated: true,
        outcome: outcome.clone(),
        credit_cents: credit,
        reason_code: if outcome == PARTIAL { "credit_formula" } else if outcome == DENY { "not_provider_fault" } else { "below_exclusion" }.to_string(),
        reason_text: if reason_text.is_empty() { format!("Break It review of {}", fixture.description) } else { reason_text },
        decisive,
        policy_version: row.policy_version.clone(),
        model_version: row.model_version.clone(),
    }, evidence_json.to_string());

    let caught = credit <= owed;
    let decided = AttackEval {
        decided_by: "human".to_string(),
        outcome: if caught { CAUGHT } else { MISSED }.to_string(),
        decision: outcome.clone(),
        paid_cents: credit,
        protected_cents: if caught { plan.amount_cents - credit } else { 0 },
        bad_cents: if caught { 0 } else { credit - owed },
        why: format!(
            "{} decided {} and paid {} of the {} claimed{}. Stored as labeled decision {} ({}) and mined for a rule.",
            reviewer,
            outcome,
            dollars(credit),
            dollars(plan.amount_cents),
            if caught { String::new() } else { format!("; the evidence supports {}", dollars(owed)) },
            decision_id,
            case_id
        ),
        review: "human".to_string(),
        review_ref: case_id.clone(),
        ..row.clone()
    };
    retally(ctx, &row, &decided, "decided by a human");
    ctx.db.attack_eval().id().update(decided);
    learn_from_decision(ctx, decision_id, &case_id);
    Ok(())
}

/// After a promotion, every attack in the latest run still waiting for a human is
/// decided again under the new active policy and model.
pub fn reconsider(ctx: &ReducerContext, version_id: &str) {
    let Some(session_id) = latest_session(ctx) else { return };
    let held: Vec<AttackEval> = ctx
        .db
        .attack_eval()
        .session_id()
        .filter(session_id)
        .filter(|r| r.label == AFTER && r.outcome == ESCALATED && r.review.is_empty())
        .collect();
    if held.is_empty() {
        return;
    }
    let (_, cfg) = configs(ctx);
    let (mut cleared, mut paid, mut protected, mut bad) = (0u32, 0i64, 0i64, 0i64);
    for row in &held {
        let Some((fixture, plan, pass)) = rebuild(ctx, row) else { continue };
        let atk = ClaimAttack { fixture: &fixture, plan: &plan, pass: pass.as_ref(), flags: &[], on_target: &[] };
        let base = AttackEval { policy_version: cfg.policy_version.clone(), model_version: cfg.model_version(), ..row.clone() };
        let next = decide(ctx, &cfg, base, &atk);
        if next.outcome == ESCALATED {
            continue;
        }
        cleared += 1;
        paid += next.paid_cents;
        protected += next.protected_cents;
        bad += next.bad_cents;
        let next = AttackEval { review: "cleared".to_string(), review_ref: version_id.to_string(), ..next };
        retally(ctx, row, &next, &format!("cleared by {}", version_id));
        ctx.db.attack_eval().id().update(next);
    }
    let trigger = ctx.db.policy_proposal().version_id().find(version_id.to_string()).map(|p| p.trigger_case_id).unwrap_or_default();
    ctx.db.attack_clearance().insert(AttackClearance {
        id: 0,
        session_id,
        version_id: version_id.to_string(),
        trigger_case_id: trigger,
        held_before: held.len() as u32,
        cleared,
        still_held: held.len() as u32 - cleared,
        paid_cents: paid,
        protected_cents: protected,
        bad_cents: bad,
        created_at: ctx.timestamp,
    });
    log::info!("{} cleared {} of {} held Break It attacks", version_id, cleared, held.len());
}
