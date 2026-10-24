//! Per-decision pipeline path for the decision replay.
//!
//! Every reducer in `decision.rs` that moves a case appends one `pipeline_step` row:
//! intake, System 1, Cedar or a learned rule, the injection screen, System 2,
//! re-verification, the human, and the label, retrain, model and policy steps the
//! human's decision causes. Rows mirror `PipelineStepRow` in `web/src/replay/types.ts`
//! and are keyed `case:<claim_ref>`, the replay key of the case.

use serde_json::json;
use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::decision_logic::AUTO_DECIDE_CONFIDENCE_PCT;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    Claim,
    System1,
    Cedar,
    Injection,
    System2,
    Reverify,
    Decided,
    Human,
    Label,
    Retrain,
    Model,
    Proposal,
}

impl Stage {
    /// The `StageKind` string the web replay expects.
    pub fn key(self) -> &'static str {
        match self {
            Stage::Claim => "claim",
            Stage::System1 => "system1",
            Stage::Cedar => "cedar",
            Stage::Injection => "injection",
            Stage::System2 => "system2",
            Stage::Reverify => "reverify",
            Stage::Decided => "decided",
            Stage::Human => "human",
            Stage::Label => "label",
            Stage::Retrain => "retrain",
            Stage::Model => "model",
            Stage::Proposal => "proposal",
        }
    }
}

#[spacetimedb::table(accessor = pipeline_step, public)]
#[derive(Clone)]
pub struct PipelineStep {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub decision_key: String,
    #[index(btree)]
    pub case_id: u64,
    pub seq: u32,
    pub stage: String,
    pub system: String,
    pub version: Option<String>,
    pub verdict: String,
    pub confidence_pct: Option<f64>,
    pub amount_cents: Option<i64>,
    /// Short caption shown under the headline.
    pub note: String,
    /// Longer quoted text: System 2's rationale, an escalation reason, a rule's description.
    pub detail: String,
    /// `[{"label": .., "ok": ..}]` for re-verification.
    pub checks_json: String,
    pub created_at: Timestamp,
}

pub fn decision_key(claim_ref: &str) -> String {
    format!("case:{}", claim_ref)
}

/// One step to append. Built by the decision reducers, written by [`record`].
pub struct Step {
    pub stage: Stage,
    pub system: String,
    pub version: Option<String>,
    pub verdict: String,
    pub confidence_pct: Option<f64>,
    pub amount_cents: Option<i64>,
    pub note: String,
    pub detail: String,
    pub checks: Vec<(String, bool)>,
}

impl Step {
    pub fn new(stage: Stage, system: impl Into<String>, verdict: impl Into<String>) -> Self {
        Step {
            stage,
            system: system.into(),
            version: None,
            verdict: verdict.into(),
            confidence_pct: None,
            amount_cents: None,
            note: String::new(),
            detail: String::new(),
            checks: Vec::new(),
        }
    }
    pub fn version(mut self, v: impl Into<String>) -> Self {
        let v = v.into();
        self.version = if v.is_empty() { None } else { Some(v) };
        self
    }
    pub fn confidence(mut self, pct: f64) -> Self {
        self.confidence_pct = Some((pct * 10.0).round() / 10.0);
        self
    }
    pub fn amount(mut self, cents: i64) -> Self {
        self.amount_cents = Some(cents);
        self
    }
    pub fn note(mut self, n: impl Into<String>) -> Self {
        self.note = n.into();
        self
    }
    pub fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = d.into();
        self
    }
    pub fn checks(mut self, c: Vec<(String, bool)>) -> Self {
        self.checks = c;
        self
    }
}

fn checks_json(checks: &[(String, bool)]) -> String {
    if checks.is_empty() {
        return String::new();
    }
    json!(checks.iter().map(|(label, ok)| json!({"label": label, "ok": ok})).collect::<Vec<_>>()).to_string()
}

fn row(ctx: &ReducerContext, case_id: u64, claim_ref: &str, seq: u32, step: Step) -> PipelineStep {
    PipelineStep {
        id: 0,
        decision_key: decision_key(claim_ref),
        case_id,
        seq,
        stage: step.stage.key().to_string(),
        system: step.system,
        version: step.version,
        verdict: step.verdict,
        confidence_pct: step.confidence_pct,
        amount_cents: step.amount_cents,
        note: step.note,
        checks_json: checks_json(&step.checks),
        detail: step.detail,
        created_at: ctx.timestamp,
    }
}

/// Appends a step to the case's path.
pub fn record(ctx: &ReducerContext, case_id: u64, claim_ref: &str, step: Step) {
    let seq = ctx.db.pipeline_step().case_id().filter(case_id).map(|s| s.seq + 1).max().unwrap_or(0);
    ctx.db.pipeline_step().insert(row(ctx, case_id, claim_ref, seq, step));
}

/// Replaces the case's open "awaiting review" human step with the reviewer's
/// decision, so the path shows one human stage; appends when there is none.
pub fn resolve_human(ctx: &ReducerContext, case_id: u64, claim_ref: &str, step: Step) {
    let open = ctx
        .db
        .pipeline_step()
        .case_id()
        .filter(case_id)
        .filter(|s| s.stage == Stage::Human.key())
        .max_by_key(|s| s.seq);
    match open {
        Some(existing) => {
            let updated = PipelineStep { id: existing.id, ..row(ctx, case_id, claim_ref, existing.seq, step) };
            ctx.db.pipeline_step().id().update(updated);
        }
        None => record(ctx, case_id, claim_ref, step),
    }
}

/// The re-verification checks shown for a System 2 result, grouped from the
/// module's failure messages in `submit_system2`.
pub fn reverify_checks(failures: &[String]) -> Vec<(String, bool)> {
    let failed = |pred: &dyn Fn(&str) -> bool| failures.iter().any(|f| pred(f));
    let evidence = !failed(&|f| f.starts_with("cited evidence") || f.contains("evidence reference") || f.contains("cited no evidence") || f.contains("non-numeric key"));
    let amount = !failed(&|f| f.contains("entitlement") || f.contains("amount claimed") || f.contains("without a credit"));
    let sanity = failures.iter().find(|f| f.contains("System 1") || f.contains("telemetry shows"));
    let range = !failed(&|f| f.contains("out of range"));
    let mut checks = vec![
        ("Cited evidence exists".to_string(), evidence),
        ("Credit within entitlement".to_string(), amount),
        (
            match sanity {
                Some(f) => capitalize(f),
                None => "System 1 and telemetry agree".to_string(),
            },
            sanity.is_none(),
        ),
    ];
    if !range {
        checks.push(("Confidence in range".to_string(), false));
    }
    checks
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// System 1's routing note: where its confidence sends the case next.
pub fn system1_route_note(confidence_pct: f64, text_needed: bool) -> String {
    if text_needed {
        "customer text needed · injection screen".to_string()
    } else if confidence_pct >= AUTO_DECIDE_CONFIDENCE_PCT {
        format!("≥ {:.0}% · Cedar", AUTO_DECIDE_CONFIDENCE_PCT)
    } else {
        format!("< {:.0}% · learned rules, then System 2", AUTO_DECIDE_CONFIDENCE_PCT)
    }
}

pub fn usd(cents: i64) -> String {
    let whole = (cents as f64 / 100.0).round() as i64;
    let digits = whole.abs().to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{}${}", if whole < 0 { "-" } else { "" }, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_match_web_stage_kinds() {
        let all = [
            Stage::Claim, Stage::System1, Stage::Cedar, Stage::Injection, Stage::System2, Stage::Reverify,
            Stage::Decided, Stage::Human, Stage::Label, Stage::Retrain, Stage::Model, Stage::Proposal,
        ];
        let keys: Vec<&str> = all.iter().map(|s| s.key()).collect();
        assert_eq!(
            keys,
            ["claim", "system1", "cedar", "injection", "system2", "reverify", "decided", "human", "label", "retrain", "model", "proposal"]
        );
        assert_eq!(decision_key("CLM-20001"), "case:CLM-20001");
    }

    #[test]
    fn reverify_all_pass() {
        let checks = reverify_checks(&[]);
        assert_eq!(checks.len(), 3);
        assert!(checks.iter().all(|(_, ok)| *ok));
    }

    #[test]
    fn reverify_groups_failures() {
        let failures = vec![
            "cited evidence pass_telemetry:999999 does not exist for this claim".to_string(),
            "credit $10.00 exceeds the contract entitlement $5.00".to_string(),
            "telemetry shows the pass completed".to_string(),
        ];
        let checks = reverify_checks(&failures);
        assert_eq!(checks[0], ("Cited evidence exists".to_string(), false));
        assert_eq!(checks[1], ("Credit within entitlement".to_string(), false));
        assert_eq!(checks[2], ("Telemetry shows the pass completed".to_string(), false));
    }

    #[test]
    fn reverify_reports_system1_disagreement() {
        let checks = reverify_checks(&["System 1 strongly disagrees (approve probability 7%)".to_string()]);
        assert!(checks[0].1 && checks[1].1);
        assert_eq!(checks[2], ("System 1 strongly disagrees (approve probability 7%)".to_string(), false));
    }

    #[test]
    fn route_notes() {
        assert_eq!(system1_route_note(97.2, false), "≥ 95% · Cedar");
        assert_eq!(system1_route_note(85.5, false), "< 95% · learned rules, then System 2");
        assert_eq!(system1_route_note(99.0, true), "customer text needed · injection screen");
    }

    #[test]
    fn usd_formats_whole_dollars() {
        assert_eq!(usd(123_456_78), "$123,457");
        assert_eq!(usd(99), "$1");
        assert_eq!(usd(0), "$0");
        assert_eq!(usd(-250_000), "-$2,500");
    }
}
