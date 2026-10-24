//! Pure decision-architecture logic shared by the `decision` reducers and their tests.
//!
//! Nothing here touches `ReducerContext`, so every rule the reducers enforce
//! (Cedar evaluation of learned rules, evidence references, System 1 sanity
//! checks, credit entitlement) is unit-testable with `cargo test`.

use cedar_policy::{
    Authorizer, Context, Decision, Entities, EntityId, EntityTypeName, EntityUid, PolicySet, Request,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::str::FromStr;

/// System 1 / System 2 / learned rules auto-decide only at or above this confidence.
pub const AUTO_DECIDE_CONFIDENCE_PCT: f64 = 95.0;
/// Below this approve-probability System 1 is treated as strongly disagreeing with an approval.
pub const S1_STRONG_DENY_P: f64 = 0.2;
/// Above this approve-probability System 1 is treated as strongly disagreeing with a denial.
pub const S1_STRONG_APPROVE_P: f64 = 0.8;
/// A pass whose telemetry lost less than this share of data counts as completed.
pub const COMPLETED_LOSS_PCT: i64 = 5;
pub const STORM_KP: f64 = 5.0;

pub const MIN_RULE_SUPPORT: u32 = 3;
pub const MIN_RULE_REVIEWERS: u32 = 3;

pub const RULE_APPROVE_ACTION: &str = "auto_approve_by_rule";
pub const RULE_DENY_ACTION: &str = "auto_deny_by_rule";

pub const CLAIM_TYPES: [&str; 3] = ["dropped_pass", "degraded_link", "late_delivery"];

/// Cedar context attributes a learned rule may test. Kept in sync with
/// `worker/src/features.ts::ruleContext`.
const BOOL_FEATURES: [&str; 5] = ["pass_completed", "storm", "weather_exclusion", "within_window", "maintenance_overlap"];
const LONG_FEATURES: [&str; 4] = ["telemetry_loss_pct", "kp_x10", "amount_ratio_pct", "station_drop_rate_pct"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub feature: String,
    pub op: String,
    pub value: Value,
}

/// Deterministic telemetry for a pass that has no recorded telemetry row.
/// Dropped passes lose most of their data; a minority of completed passes are degraded.
pub struct DerivedTelemetry {
    pub expected_mb: f64,
    pub received_mb: f64,
    pub loss_pct: u32,
    pub snr_db: f64,
    pub signal_lost_offset_s: Option<u32>,
}

fn mix(mut x: u64) -> u64 {
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51afd7ed558ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ceb9fe1a85ec53);
    x ^ (x >> 33)
}

pub fn derive_telemetry(pass_id: u64, dropped: bool, completed: bool, duration_s: i64) -> DerivedTelemetry {
    let h = mix(pass_id.wrapping_add(0x9e3779b97f4a7c15));
    let expected_mb = (duration_s.max(60) as f64) * 1.5;
    let loss_pct: u32 = if dropped {
        60 + (h % 41) as u32
    } else if completed {
        if h % 100 < 18 { 10 + ((h >> 8) % 45) as u32 } else { ((h >> 8) % 3) as u32 }
    } else {
        0
    };
    let received_mb = expected_mb * (100 - loss_pct) as f64 / 100.0;
    let snr_db = 14.0 - loss_pct as f64 * 0.11 + ((h >> 16) % 20) as f64 / 10.0;
    let signal_lost_offset_s = if loss_pct >= 10 {
        Some(((duration_s.max(60) as f64) * (100 - loss_pct) as f64 / 100.0) as u32)
    } else {
        None
    };
    DerivedTelemetry { expected_mb, received_mb, loss_pct, snr_db: (snr_db * 10.0).round() / 10.0, signal_lost_offset_s }
}

/// Stand-in for the /ml pass-failure model until it lands on this branch:
/// a fixed logistic model whose per-feature SHAP values are exact for a linear model.
pub fn ml_failure_proxy(kp: f64, max_elevation_deg: f64, drop_rate: f64, maintenance: bool, strong_flare: bool) -> (f64, Vec<(String, f64)>) {
    let terms = [
        ("Kp index", 0.55 * ((kp - 3.0).max(0.0) - 0.3)),
        ("Max elevation", 0.03 * ((40.0 - max_elevation_deg).max(0.0) - 5.0)),
        ("Station drop rate (30d)", 4.0 * (drop_rate - 0.06)),
        ("Maintenance overlap", if maintenance { 1.2 } else { 0.0 }),
        ("M/X flare", if strong_flare { 0.8 } else { 0.0 }),
    ];
    let base = -2.6;
    let logit: f64 = base + terms.iter().map(|(_, v)| v).sum::<f64>();
    let p = 1.0 / (1.0 + (-logit).exp());
    let shap = terms.iter().map(|(n, v)| (n.to_string(), (v * 1000.0).round() / 1000.0)).collect();
    ((p * 10000.0).round() / 10000.0, shap)
}

/// Credit the contract entitles the customer to for this claim, before comparing to what they asked for.
pub fn entitled_credit_cents(revenue_cents: i64, credit_pct: u32, claim_type: &str, loss_pct: u32, max_credit_cents: i64) -> i64 {
    let base = revenue_cents as f64 * credit_pct as f64 / 100.0;
    let share = match claim_type {
        "dropped_pass" => 1.0,
        "degraded_link" => loss_pct as f64 / 100.0,
        _ => 0.25,
    };
    ((base * share).round() as i64).clamp(0, max_credit_cents.max(0))
}

/// Cedar context a learned rule is evaluated against, derived from a case snapshot.
pub fn rule_context(snapshot: &Value) -> Value {
    let loss = snapshot["telemetry"]["loss_pct"].as_i64().unwrap_or(0);
    let status = snapshot["pass"]["status"].as_str().unwrap_or("");
    let entitled = snapshot["contract"]["entitled_credit_cents"].as_i64().unwrap_or(0);
    let claimed = snapshot["claim"]["amount_claimed_cents"].as_i64().unwrap_or(0);
    let ratio = if entitled <= 0 { 1000 } else { (claimed * 100 / entitled).min(1000) };
    json!({
        "claim_type": snapshot["claim"]["claim_type"].as_str().unwrap_or(""),
        "telemetry_loss_pct": loss,
        "pass_completed": status == "Ok" && loss < COMPLETED_LOSS_PCT,
        "storm": snapshot["weather"]["storm"].as_bool().unwrap_or(false),
        "kp_x10": (snapshot["weather"]["kp_index"].as_f64().unwrap_or(0.0) * 10.0).round() as i64,
        "weather_exclusion": snapshot["contract"]["weather_exclusion"].as_bool().unwrap_or(false),
        "within_window": snapshot["contract"]["within_window"].as_bool().unwrap_or(false),
        "maintenance_overlap": snapshot["station_history"]["maintenance_overlap"].as_bool().unwrap_or(false),
        "amount_ratio_pct": ratio,
        "station_drop_rate_pct": snapshot["station_history"]["drop_rate_pct"].as_i64().unwrap_or(0),
    })
}

fn condition_to_cedar(c: &Condition) -> Result<String, String> {
    let f = c.feature.as_str();
    if f == "claim_type" {
        let v = c.value.as_str().ok_or("claim_type must be a string")?;
        if c.op != "eq" || !CLAIM_TYPES.contains(&v) {
            return Err(format!("invalid claim_type condition {:?}", c));
        }
        return Ok(format!("context.claim_type == \"{}\"", v));
    }
    if BOOL_FEATURES.contains(&f) {
        let v = c.value.as_bool().ok_or_else(|| format!("{} must be a bool", f))?;
        if c.op != "eq" {
            return Err(format!("{} only supports eq", f));
        }
        return Ok(format!("context.{} == {}", f, v));
    }
    if LONG_FEATURES.contains(&f) {
        let v = c.value.as_i64().ok_or_else(|| format!("{} must be an integer", f))?;
        let op = match c.op.as_str() {
            "eq" => "==",
            "gte" => ">=",
            "lt" => "<",
            other => return Err(format!("unsupported op {}", other)),
        };
        return Ok(format!("context.{} {} {}", f, op, v));
    }
    Err(format!("unknown feature {}", f))
}

/// Builds the Cedar permit for a learned rule. Conditions are validated against a
/// fixed vocabulary, so a proposal can never smuggle arbitrary Cedar into the policy.
pub fn cedar_for_rule(rule_id: u64, approve: bool, conditions: &[Condition]) -> Result<String, String> {
    if conditions.is_empty() {
        return Err("a rule needs at least one condition".into());
    }
    if !conditions.iter().any(|c| c.feature == "claim_type") {
        return Err("a rule must be scoped to a claim type".into());
    }
    let clauses = conditions.iter().map(condition_to_cedar).collect::<Result<Vec<_>, _>>()?;
    let action = if approve { RULE_APPROVE_ACTION } else { RULE_DENY_ACTION };
    let text = format!(
        "// Learned rule L{id}: mined from consistent human decisions\npermit(\n    principal == GroundTruth::Actor::\"ai_analyst\",\n    action == GroundTruth::Action::\"{action}\",\n    resource\n) when {{\n    {body}\n}};\n",
        id = rule_id,
        action = action,
        body = clauses.join(" &&\n    ")
    );
    PolicySet::from_str(&text).map_err(|e| format!("generated Cedar does not parse: {}", e))?;
    Ok(text)
}

/// Evaluates `action` for the AI analyst against `policy_text` with an arbitrary context.
pub fn cedar_permits(policy_text: &str, action: &str, amount_cents: i64, context: &Value) -> bool {
    let Ok(policies) = PolicySet::from_str(policy_text) else { return false };
    let uid = |ty: &str, id: &str| {
        EntityUid::from_type_name_and_id(EntityTypeName::from_str(ty).unwrap(), EntityId::from_str(id).unwrap())
    };
    let entities_json = json!([
        {"uid": {"type": "GroundTruth::Actor", "id": "ai_analyst"}, "attrs": {}, "parents": []},
        {"uid": {"type": "GroundTruth::Claim", "id": "case"}, "attrs": {"amount_cents": amount_cents}, "parents": []},
    ]);
    let Ok(entities) = Entities::from_json_value(entities_json, None) else { return false };
    let Ok(ctx) = Context::from_json_value(context.clone(), None) else { return false };
    let Ok(request) = Request::new(
        uid("GroundTruth::Actor", "ai_analyst"),
        uid("GroundTruth::Action", action),
        uid("GroundTruth::Claim", "case"),
        ctx,
        None,
    ) else {
        return false;
    };
    Authorizer::new().is_authorized(&request, &policies, &entities).decision() == Decision::Allow
}

/// Splits an evidence citation like `pass:42` or `contract_term:SkyNet Communications`.
pub fn parse_evidence_ref(s: &str) -> Option<(&str, &str)> {
    let (table, key) = s.split_once(':')?;
    let table = table.trim();
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    const TABLES: [&str; 7] = [
        "pass", "pass_telemetry", "space_weather", "contract_term", "station", "station_maintenance", "dispute_message",
    ];
    TABLES.contains(&table).then_some((table, key))
}

/// Whether a claim must go to System 2 even if System 1 is confident: late-delivery
/// claims are customer-reported, and a denial must not be issued without reading the customer's side.
pub fn needs_text(claim_type: &str, s1_approves: bool, has_message: bool) -> bool {
    has_message && (claim_type == "late_delivery" || !s1_approves)
}

/// System 1 sanity checks on a System 2 verdict. Returns the failed checks.
pub fn sanity_failures(claim_type: &str, approve: bool, pass_completed: bool, s1_p_approve: Option<f64>) -> Vec<String> {
    let mut failures = Vec::new();
    if approve && pass_completed && claim_type != "late_delivery" {
        failures.push("telemetry shows the pass completed".to_string());
    }
    match s1_p_approve {
        Some(p) if approve && p < S1_STRONG_DENY_P => {
            failures.push(format!("System 1 strongly disagrees (approve probability {:.0}%)", p * 100.0))
        }
        Some(p) if !approve && p > S1_STRONG_APPROVE_P => {
            failures.push(format!("System 1 strongly disagrees (approve probability {:.0}%)", p * 100.0))
        }
        None => failures.push("no System 1 output on record".to_string()),
        _ => {}
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(claim_type: &str, loss: i64, status: &str, storm: bool, exclusion: bool) -> Value {
        json!({
            "claim": {"claim_type": claim_type, "amount_claimed_cents": 150000},
            "pass": {"status": status},
            "telemetry": {"loss_pct": loss},
            "weather": {"storm": storm, "kp_index": if storm { 6.3 } else { 2.0 }},
            "station_history": {"maintenance_overlap": false, "drop_rate_pct": 4},
            "contract": {"weather_exclusion": exclusion, "within_window": true, "entitled_credit_cents": 150000},
        })
    }

    fn degraded_storm_rule() -> Vec<Condition> {
        vec![
            Condition { feature: "claim_type".into(), op: "eq".into(), value: json!("degraded_link") },
            Condition { feature: "telemetry_loss_pct".into(), op: "gte".into(), value: json!(40) },
            Condition { feature: "telemetry_loss_pct".into(), op: "lt".into(), value: json!(60) },
            Condition { feature: "storm".into(), op: "eq".into(), value: json!(true) },
            Condition { feature: "weather_exclusion".into(), op: "eq".into(), value: json!(false) },
        ]
    }

    #[test]
    fn learned_rule_permits_only_matching_cases() {
        let cedar = cedar_for_rule(1, true, &degraded_storm_rule()).unwrap();
        let hit = rule_context(&snapshot("degraded_link", 45, "Ok", true, false));
        let wrong_band = rule_context(&snapshot("degraded_link", 30, "Ok", true, false));
        let excluded = rule_context(&snapshot("degraded_link", 45, "Ok", true, true));
        let other_type = rule_context(&snapshot("dropped_pass", 45, "Dropped", true, false));
        assert!(cedar_permits(&cedar, RULE_APPROVE_ACTION, 150000, &hit));
        assert!(!cedar_permits(&cedar, RULE_APPROVE_ACTION, 150000, &wrong_band));
        assert!(!cedar_permits(&cedar, RULE_APPROVE_ACTION, 150000, &excluded));
        assert!(!cedar_permits(&cedar, RULE_APPROVE_ACTION, 150000, &other_type));
        assert!(!cedar_permits(&cedar, RULE_DENY_ACTION, 150000, &hit));
    }

    #[test]
    fn base_policy_forbids_still_apply_next_to_learned_rules() {
        let cedar = cedar_for_rule(1, true, &degraded_storm_rule()).unwrap();
        let forbid = "forbid(principal, action == GroundTruth::Action::\"auto_approve_by_rule\", resource) when { resource.amount_cents > 100000 };";
        let combined = format!("{}\n{}", cedar, forbid);
        let hit = rule_context(&snapshot("degraded_link", 45, "Ok", true, false));
        assert!(!cedar_permits(&combined, RULE_APPROVE_ACTION, 150000, &hit));
        assert!(cedar_permits(&combined, RULE_APPROVE_ACTION, 90000, &hit));
    }

    #[test]
    fn rule_conditions_cannot_inject_cedar() {
        let evil = vec![
            Condition { feature: "claim_type".into(), op: "eq".into(), value: json!("degraded_link\" || true || \"") },
        ];
        assert!(cedar_for_rule(2, true, &evil).is_err());
        let unknown = vec![
            Condition { feature: "claim_type".into(), op: "eq".into(), value: json!("dropped_pass") },
            Condition { feature: "principal".into(), op: "eq".into(), value: json!(true) },
        ];
        assert!(cedar_for_rule(3, true, &unknown).is_err());
        let unscoped = vec![Condition { feature: "storm".into(), op: "eq".into(), value: json!(true) }];
        assert!(cedar_for_rule(4, true, &unscoped).is_err());
    }

    #[test]
    fn evidence_refs_parse_known_tables_only() {
        assert_eq!(parse_evidence_ref("pass:42"), Some(("pass", "42")));
        assert_eq!(parse_evidence_ref("contract_term:SkyNet Communications"), Some(("contract_term", "SkyNet Communications")));
        assert_eq!(parse_evidence_ref("cedar_policy_store:v4"), None);
        assert_eq!(parse_evidence_ref("pass:"), None);
        assert_eq!(parse_evidence_ref("nonsense"), None);
    }

    #[test]
    fn sanity_check_escalates_approval_of_completed_pass() {
        let f = sanity_failures("dropped_pass", true, true, Some(0.6));
        assert_eq!(f, vec!["telemetry shows the pass completed".to_string()]);
        assert_eq!(sanity_failures("dropped_pass", true, false, Some(0.1)).len(), 1);
        assert!(sanity_failures("dropped_pass", true, false, Some(0.5)).is_empty());
        assert_eq!(sanity_failures("dropped_pass", false, false, Some(0.9)).len(), 1);
        assert_eq!(sanity_failures("late_delivery", true, true, None).len(), 1);
    }

    #[test]
    fn text_is_needed_for_late_delivery_and_denials() {
        assert!(needs_text("late_delivery", true, true));
        assert!(needs_text("dropped_pass", false, true));
        assert!(!needs_text("dropped_pass", true, true));
        assert!(!needs_text("late_delivery", true, false));
    }

    #[test]
    fn entitlement_scales_with_claim_type_and_caps() {
        assert_eq!(entitled_credit_cents(500000, 50, "dropped_pass", 100, 1_000_000), 250000);
        assert_eq!(entitled_credit_cents(500000, 50, "degraded_link", 40, 1_000_000), 100000);
        assert_eq!(entitled_credit_cents(500000, 50, "late_delivery", 0, 1_000_000), 62500);
        assert_eq!(entitled_credit_cents(500000, 100, "dropped_pass", 100, 200000), 200000);
    }

    #[test]
    fn derived_telemetry_matches_pass_status() {
        for id in 0..200u64 {
            let d = derive_telemetry(id, true, false, 600);
            assert!(d.loss_pct >= 60);
            let ok = derive_telemetry(id, false, true, 600);
            assert!(ok.loss_pct < 55);
            assert!((ok.received_mb - ok.expected_mb * (100 - ok.loss_pct) as f64 / 100.0).abs() < 1e-6);
        }
    }

    #[test]
    fn ml_proxy_rises_with_storms() {
        let (calm, _) = ml_failure_proxy(2.0, 60.0, 0.05, false, false);
        let (storm, shap) = ml_failure_proxy(6.7, 25.0, 0.2, false, true);
        assert!(storm > calm);
        assert_eq!(shap.len(), 5);
    }
}
