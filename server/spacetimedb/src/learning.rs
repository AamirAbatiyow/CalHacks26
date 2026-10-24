//! Policy learning from labeled human decisions.
//!
//! Two channels learn from every human decision. Model retraining (System 1) is
//! owned elsewhere and reads `audit_decision`. This module owns policies: it
//! proposes a Cedar rule only when at least `MIN_SUPPORT` labeled decisions share
//! the same deciding features and outcome and no labeled decision with those
//! features went the other way. Rules are data in `cedar_policy_store`, replayed
//! against the history and promoted only if precision does not regress. Nothing
//! trains on policy outcomes: only human decisions become labels.

use std::collections::BTreeMap;
use std::str::FromStr;

use cedar_policy::{Authorizer, Context, Decision, Entities, EntityUid, PolicySet, Request, RestrictedExpression};
use serde::Serialize;
use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::authority::{cedar_policy_store, get_active_policy, CedarPolicyStore};
use crate::evidence::{assess, Assessment, Features, MessageFieldsSnapshot, DECIDING_KEYS, DENY};
use crate::policy::{cedar_rule, policy_replay, policy_version, CedarRule, PolicyReplay, PolicyStatus, PolicyVersion, ReplayStatus};

pub const MIN_SUPPORT: usize = 3;
pub const AUTO_DECIDE_CONFIDENCE: i64 = 95;

#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = audit_decision, public)]
pub struct AuditDecision {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// history | live
    #[index(btree)]
    pub source: String,
    pub case_id: String,
    pub decided_at: Timestamp,
    pub reviewer: String,
    pub claim_type: String,
    pub customer_id: String,
    pub customer_name: String,
    pub tier: String,
    #[index(btree)]
    pub station_id: String,
    pub pass_fee_cents: i64,
    pub claimed_cents: i64,
    pub contract_credit_cents: i64,
    pub lost_pct: i64,
    pub max_elevation_deg: f64,
    pub kp: f32,
    pub kp_exclusion: f32,
    pub maintenance: String,
    pub notice_hours: i64,
    pub required_notice_hours: i64,
    pub integrity: String,
    pub msg_cites_weather: bool,
    pub msg_claims_full_loss: bool,
    pub msg_mentions_maintenance: bool,
    pub new_account: bool,
    pub full_credit_lost_pct: i64,
    pub min_elevation_deg: f64,
    pub ai_recommended: String,
    pub ai_confidence: i64,
    pub ml_failure_prob: f32,
    pub escalated: bool,
    /// approve | partial | deny
    pub outcome: String,
    pub credit_cents: i64,
    pub reason_code: String,
    pub reason_text: String,
    /// Deciding-feature keys the reviewer marked as decisive.
    pub decisive: Vec<String>,
    pub policy_version: String,
    pub model_version: String,
}

impl AuditDecision {
    pub fn features(&self) -> Features {
        Features {
            claim_type: self.claim_type.clone(),
            customer_id: self.customer_id.clone(),
            tier: self.tier.clone(),
            station_id: self.station_id.clone(),
            pass_fee_cents: self.pass_fee_cents,
            claimed_cents: self.claimed_cents,
            lost_pct: self.lost_pct,
            max_elevation_deg: self.max_elevation_deg,
            kp: self.kp,
            kp_exclusion: self.kp_exclusion,
            maintenance: self.maintenance.clone(),
            notice_hours: self.notice_hours,
            required_notice_hours: self.required_notice_hours,
            integrity: self.integrity.clone(),
            msg: MessageFieldsSnapshot {
                cites_weather: self.msg_cites_weather,
                claims_full_loss: self.msg_claims_full_loss,
                mentions_maintenance: self.msg_mentions_maintenance,
            },
            new_account: self.new_account,
            full_credit_lost_pct: self.full_credit_lost_pct,
            min_elevation_deg: self.min_elevation_deg,
        }
    }
}

/// Full evidence the reviewer saw, frozen at decision time.
#[spacetimedb::table(accessor = decision_snapshot, public)]
pub struct DecisionSnapshot {
    #[primary_key]
    pub decision_id: u64,
    pub evidence_json: String,
}

#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = mined_rule, public)]
pub struct MinedRule {
    #[primary_key]
    pub rule_id: String,
    #[index(btree)]
    pub policy_version_id: String,
    pub outcome: String,
    /// `key=value` deciding-feature conditions.
    pub conditions: Vec<String>,
    pub title: String,
    pub rationale: String,
    pub cedar_text: String,
    pub support: u32,
    pub contradictions: u32,
    pub source_decision_ids: Vec<u64>,
    pub writer: String,
    /// proposed | active | blocked | retired
    pub status: String,
    pub created_at: Timestamp,
}

#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = policy_proposal, public)]
pub struct PolicyProposal {
    #[primary_key]
    pub version_id: String,
    pub base_version_id: String,
    /// history_mining | human_decision
    pub origin: String,
    pub trigger_decision_id: Option<u64>,
    pub trigger_case_id: String,
    pub rule_ids: Vec<String>,
    /// proposed | promoted | blocked
    pub status: String,
    pub block_reason: String,
    pub history_cases: u32,
    pub replay_cases: u32,
    pub escalations_before: u32,
    pub escalations_after: u32,
    pub resolved: u32,
    pub resolved_history: u32,
    pub auto_before: u32,
    pub auto_after: u32,
    pub correct_before: u32,
    pub correct_after: u32,
    pub precision_before: f32,
    pub precision_after: f32,
    pub regressions: u32,
    pub dollar_impact_cents: i64,
    /// Credits the new rules settle without a human, summed over resolved cases.
    pub auto_credit_cents: i64,
    pub created_at: Timestamp,
    pub promoted_at: Option<Timestamp>,
}

/// What the miner concluded after one human decision.
#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = mining_result, public)]
pub struct MiningResult {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub decision_id: u64,
    pub case_id: String,
    /// proposed | below_support | contradicted | no_decisive_evidence
    pub status: String,
    pub pattern: Vec<String>,
    pub outcome: String,
    pub consistent: u32,
    pub contradicting: u32,
    pub consistent_ids: Vec<u64>,
    pub contradiction_ids: Vec<u64>,
    pub proposal_version: Option<String>,
    pub detail: String,
    pub created_at: Timestamp,
}

// ---------------------------------------------------------------- pure core

#[derive(Clone, Debug)]
pub struct Labeled {
    pub id: u64,
    pub features: Features,
    pub outcome: String,
    pub credit_cents: i64,
    pub decisive: Vec<String>,
    pub history: bool,
}

impl From<&AuditDecision> for Labeled {
    fn from(d: &AuditDecision) -> Self {
        Labeled {
            id: d.id,
            features: d.features(),
            outcome: d.outcome.clone(),
            credit_cents: d.credit_cents,
            decisive: d.decisive.clone(),
            history: d.source == "history",
        }
    }
}

pub type Conditions = Vec<(String, String)>;

/// Claim type plus each feature the reviewer marked decisive, in a fixed key order.
pub fn pattern_conditions(features: &Features, decisive: &[String]) -> Conditions {
    DECIDING_KEYS
        .iter()
        .filter(|k| **k == "claim_type" || decisive.iter().any(|d| d == *k))
        .filter_map(|k| features.value(k).map(|v| (k.to_string(), v)))
        .collect()
}

pub fn matches(features: &Features, conditions: &Conditions) -> bool {
    conditions.iter().all(|(k, v)| features.value(k).as_deref() == Some(v.as_str()))
}

pub fn condition_strings(conditions: &Conditions) -> Vec<String> {
    conditions.iter().map(|(k, v)| format!("{}={}", k, v)).collect()
}

pub fn parse_conditions(strings: &[String]) -> Conditions {
    strings
        .iter()
        .filter_map(|s| s.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct PatternCheck {
    pub consistent: Vec<u64>,
    pub contradicting: Vec<u64>,
}

/// Every labeled decision whose features meet the conditions either agrees with
/// the outcome or contradicts it, whatever that reviewer marked decisive.
pub fn check_pattern(conditions: &Conditions, outcome: &str, labeled: &[Labeled]) -> PatternCheck {
    let mut check = PatternCheck { consistent: Vec::new(), contradicting: Vec::new() };
    for l in labeled.iter().filter(|l| matches(&l.features, conditions)) {
        if l.outcome == outcome {
            check.consistent.push(l.id);
        } else {
            check.contradicting.push(l.id);
        }
    }
    check
}

#[derive(Clone, Debug, PartialEq)]
pub enum MineStatus {
    Proposed,
    BelowSupport,
    Contradicted,
    NoDecisiveEvidence,
}

impl MineStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MineStatus::Proposed => "proposed",
            MineStatus::BelowSupport => "below_support",
            MineStatus::Contradicted => "contradicted",
            MineStatus::NoDecisiveEvidence => "no_decisive_evidence",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Pattern {
    pub conditions: Conditions,
    pub outcome: String,
    pub check: PatternCheck,
    pub status: MineStatus,
}

pub fn evaluate_decision(decision: &Labeled, labeled: &[Labeled]) -> Pattern {
    let conditions = pattern_conditions(&decision.features, &decision.decisive);
    let check = check_pattern(&conditions, &decision.outcome, labeled);
    let status = if conditions.len() < 2 {
        MineStatus::NoDecisiveEvidence
    } else if !check.contradicting.is_empty() {
        MineStatus::Contradicted
    } else if check.consistent.len() < MIN_SUPPORT {
        MineStatus::BelowSupport
    } else {
        MineStatus::Proposed
    };
    Pattern { conditions, outcome: decision.outcome.clone(), check, status }
}

/// Distinct minable patterns among the given decisions (typically the escalated ones).
pub fn mine<'a>(candidates: impl Iterator<Item = &'a Labeled>, labeled: &[Labeled]) -> Vec<Pattern> {
    let mut seen: BTreeMap<(Vec<String>, String), Pattern> = BTreeMap::new();
    for d in candidates {
        let conditions = pattern_conditions(&d.features, &d.decisive);
        let key = (condition_strings(&conditions), d.outcome.clone());
        if !seen.contains_key(&key) {
            seen.insert(key, evaluate_decision(d, labeled));
        }
    }
    seen.into_values().filter(|p| p.status == MineStatus::Proposed).collect()
}

// ---------------------------------------------------------------- rule text

pub struct RuleDraft<'a> {
    pub rule_id: String,
    pub pattern: &'a Pattern,
}

pub struct RuleText {
    pub title: String,
    pub rationale: String,
    pub cedar: String,
}

/// Turns a mined pattern into rule text. The template writer is deterministic;
/// an LLM writer can implement the same trait, and its text is still parsed by
/// Cedar and replayed before anyone can promote it.
pub trait RuleWriter {
    fn writer_id(&self) -> &'static str;
    fn write(&self, draft: &RuleDraft) -> RuleText;
}

pub struct TemplateRuleWriter;

fn describe(key: &str, value: &str) -> String {
    let v = value.replace('_', " ");
    match key {
        "claim_type" => v,
        "weather_band" => format!("space weather {}", v),
        "maintenance" => format!("maintenance {}", v),
        "integrity" => format!("integrity {}", v),
        "lost_band" => format!("loss {}%", v.replace(" to ", "-").replace(" plus", "+").replace("under ", "<")),
        "claim_vs_contract" => format!("claim {} contract credit", v),
        "msg_cites_weather" => format!("message cites weather: {}", v),
        "elevation_band" => format!("elevation {}", v),
        "account" => format!("{} account", v),
        "tier" => format!("{} tier", v),
        _ => format!("{} {}", key, v),
    }
}

pub fn precedent_confidence(check: &PatternCheck) -> i64 {
    let n = check.consistent.len() + check.contradicting.len();
    if n == 0 {
        return 0;
    }
    ((check.consistent.len() * 100 / n) as i64).min(99)
}

impl RuleWriter for TemplateRuleWriter {
    fn writer_id(&self) -> &'static str {
        "template-v1"
    }

    fn write(&self, draft: &RuleDraft) -> RuleText {
        let p = draft.pattern;
        let parts: Vec<String> = p.conditions.iter().map(|(k, v)| describe(k, v)).collect();
        let title = format!("{}: {}", p.outcome, parts.join(", "));
        let rationale = format!(
            "{} labeled decisions with these deciding features were all decided {}; none contradict it.",
            p.check.consistent.len(),
            p.outcome
        );
        let when: Vec<String> = p.conditions.iter().map(|(k, v)| format!("  context.{} == \"{}\"", k, v)).collect();
        let cedar = format!(
            "@id(\"{id}\")\n@outcome(\"{outcome}\")\n@confidence(\"{conf}\")\n@support(\"{support}\")\npermit (\n  principal == GroundTruth::Actor::\"ai_analyst\",\n  action == GroundTruth::Action::\"apply_precedent\",\n  resource\n) when {{\n{when}\n}};\n",
            id = draft.rule_id,
            outcome = p.outcome,
            conf = precedent_confidence(&p.check),
            support = p.check.consistent.len(),
            when = when.join(" &&\n"),
        );
        RuleText { title, rationale, cedar }
    }
}

// ---------------------------------------------------------------- Cedar gate

fn uid(kind: &str, id: &str) -> EntityUid {
    EntityUid::from_str(&format!("GroundTruth::{}::\"{}\"", kind, id)).expect("entity uid")
}

fn claim_context(f: &Features, confidence: i64) -> Context {
    let mut pairs: Vec<(String, RestrictedExpression)> = f
        .deciding()
        .into_iter()
        .map(|(k, v)| (k, RestrictedExpression::new_string(v)))
        .collect();
    pairs.push(("confidence_percent".into(), RestrictedExpression::new_long(confidence)));
    pairs.push(("amount_cents".into(), RestrictedExpression::new_long(f.claimed_cents)));
    Context::from_pairs(pairs).expect("claim context")
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FiredRule {
    pub policy: String,
    pub action: String,
    pub outcome: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GateResult {
    pub outcome: String,
    pub credit_cents: i64,
    pub confidence: i64,
    pub auto: bool,
    pub precedent: Option<String>,
    pub fired: Vec<FiredRule>,
    pub note: String,
}

fn authorize(policies: &PolicySet, action: &str, context: Context) -> (bool, Vec<String>) {
    let request = Request::new(uid("Actor", "ai_analyst"), uid("Action", action), uid("Claim", "case"), context, None)
        .expect("request");
    let response = Authorizer::new().is_authorized(&request, policies, &Entities::empty());
    let ids = response.diagnostics().reason().map(|id| id.to_string()).collect();
    (response.decision() == Decision::Allow, ids)
}

fn annotation(policies: &PolicySet, policy_id: &str, key: &str) -> Option<String> {
    policies
        .policies()
        .find(|p| p.id().to_string() == policy_id)
        .and_then(|p| p.annotation(key).map(|s| s.to_string()))
}

/// Runs a claim through the active Cedar policies: a learned precedent may set
/// the outcome and confidence, then `auto_approve` decides whether it is automatic.
pub fn gate(policies: &PolicySet, f: &Features, a: &Assessment) -> GateResult {
    let mut fired = Vec::new();
    let mut outcome = a.recommended.to_string();
    let mut confidence = a.confidence;
    let mut precedent = None;
    let mut note = String::new();

    let (_, precedent_ids) = authorize(policies, "apply_precedent", claim_context(f, confidence));
    let mut outcomes: Vec<(String, String, i64)> = precedent_ids
        .iter()
        .map(|pid| {
            let name = annotation(policies, pid, "id").unwrap_or_else(|| pid.clone());
            let out = annotation(policies, pid, "outcome").unwrap_or_default();
            let conf = annotation(policies, pid, "confidence").and_then(|c| c.parse().ok()).unwrap_or(0);
            (name, out, conf)
        })
        .collect();
    outcomes.sort();
    for (name, out, _) in &outcomes {
        fired.push(FiredRule { policy: name.clone(), action: "apply_precedent".into(), outcome: out.clone() });
    }
    let mut distinct: Vec<&String> = outcomes.iter().map(|(_, o, _)| o).collect();
    distinct.dedup();
    if distinct.len() == 1 {
        let (name, out, conf) = outcomes.iter().max_by_key(|(_, _, c)| *c).unwrap();
        outcome = out.clone();
        confidence = *conf;
        precedent = Some(name.clone());
    } else if distinct.len() > 1 {
        note = "Learned precedents disagree; none applied".into();
    }

    let (auto, auto_ids) = authorize(policies, "auto_approve", claim_context(f, confidence));
    for pid in auto_ids {
        fired.push(FiredRule {
            policy: annotation(policies, &pid, "id").unwrap_or(pid),
            action: "auto_approve".into(),
            outcome: outcome.clone(),
        });
    }
    if !auto && note.is_empty() {
        note = format!("Confidence {}% below the {}% auto-decide threshold", confidence, AUTO_DECIDE_CONFIDENCE);
    }
    GateResult { credit_cents: f.credit_for(&outcome), outcome, confidence, auto, precedent, fired, note }
}

/// True when the policy set auto-decides below the 95% floor.
pub fn lowers_confidence_floor(policies: &PolicySet, sample: &Features) -> bool {
    authorize(policies, "auto_approve", claim_context(sample, AUTO_DECIDE_CONFIDENCE - 1)).0
}

// ---------------------------------------------------------------- replay

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReplayMetrics {
    pub cases: u32,
    pub history_cases: u32,
    pub escalated_before: u32,
    pub escalated_after: u32,
    pub resolved: u32,
    pub resolved_history: u32,
    pub auto_before: u32,
    pub auto_after: u32,
    pub correct_before: u32,
    pub correct_after: u32,
    pub regressions: u32,
    pub dollar_impact_cents: i64,
    pub auto_credit_cents: i64,
}

impl ReplayMetrics {
    pub fn precision_before(&self) -> f32 {
        if self.auto_before == 0 { 100.0 } else { self.correct_before as f32 * 100.0 / self.auto_before as f32 }
    }
    pub fn precision_after(&self) -> f32 {
        if self.auto_after == 0 { 100.0 } else { self.correct_after as f32 * 100.0 / self.auto_after as f32 }
    }
    pub fn regressed(&self) -> bool {
        // Integer cross-multiplication avoids float noise in the comparison.
        (self.correct_after as u64) * (self.auto_before as u64) < (self.correct_before as u64) * (self.auto_after as u64)
    }
}

/// Replays labeled decisions under two policy sets and scores each set's
/// automatic decisions against what the human decided.
pub fn replay(labeled: &[Labeled], before: &PolicySet, after: &PolicySet) -> ReplayMetrics {
    let mut m = ReplayMetrics::default();
    for l in labeled {
        let a = assess(&l.features);
        let b = gate(before, &l.features, &a);
        let n = gate(after, &l.features, &a);
        m.cases += 1;
        m.history_cases += l.history as u32;
        let right = |g: &GateResult| g.outcome == l.outcome;
        if b.auto {
            m.auto_before += 1;
            m.correct_before += right(&b) as u32;
        } else {
            m.escalated_before += 1;
        }
        if n.auto {
            m.auto_after += 1;
            m.correct_after += right(&n) as u32;
            if !right(&n) && (!b.auto || right(&b)) {
                m.regressions += 1;
            }
        } else {
            m.escalated_after += 1;
        }
        if !b.auto && n.auto {
            m.resolved += 1;
            m.resolved_history += l.history as u32;
            m.dollar_impact_cents += n.credit_cents - l.credit_cents;
            m.auto_credit_cents += n.credit_cents;
        }
    }
    m
}

pub fn parse_policies(text: &str) -> Result<PolicySet, String> {
    PolicySet::from_str(text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- reducers

pub fn all_labeled(ctx: &ReducerContext) -> Vec<Labeled> {
    let mut rows: Vec<Labeled> = ctx.db.audit_decision().iter().map(|d| Labeled::from(&d)).collect();
    rows.sort_by_key(|l| l.id);
    rows
}

fn active_policies(ctx: &ReducerContext) -> (String, String) {
    get_active_policy(ctx)
        .map(|p| (p.version, p.policy_text))
        .unwrap_or_else(|| (crate::CURRENT_POLICY_VERSION.to_string(), crate::authority::get_default_policy_text().to_string()))
}

pub fn active_policy_set(ctx: &ReducerContext) -> (String, PolicySet) {
    let (version, text) = active_policies(ctx);
    let set = parse_policies(&text).unwrap_or_else(|_| PolicySet::new());
    (version, set)
}

fn next_version(ctx: &ReducerContext) -> u32 {
    ctx.db.policy_version().iter().map(|v| v.version).max().unwrap_or(0) + 1
}

pub struct ProposalTrigger {
    pub origin: &'static str,
    pub decision_id: Option<u64>,
    pub case_id: String,
}

/// Writes a proposed policy version: rule text appended to the active Cedar
/// policy, measured replay, and the rows the Policies page shows.
pub fn create_proposal(ctx: &ReducerContext, patterns: &[Pattern], trigger: ProposalTrigger) -> Option<String> {
    if patterns.is_empty() {
        return None;
    }
    let (base_version, base_text) = active_policies(ctx);
    let version = next_version(ctx);
    let version_id = format!("v{}", version);
    let writer = TemplateRuleWriter;
    let mut rule_texts = Vec::new();
    for (i, pattern) in patterns.iter().enumerate() {
        let rule_id = format!("{}-learned-{}", version_id, i + 1);
        let text = writer.write(&RuleDraft { rule_id: rule_id.clone(), pattern });
        rule_texts.push((rule_id, pattern, text));
    }
    let new_text = format!(
        "{}\n// Learned rules, {} ({})\n{}",
        base_text.trim_end(),
        version_id,
        writer.writer_id(),
        rule_texts.iter().map(|(_, _, t)| t.cedar.clone()).collect::<Vec<_>>().join("\n")
    );

    let labeled = all_labeled(ctx);
    let before = parse_policies(&base_text).unwrap_or_else(|_| PolicySet::new());
    let (metrics, block_reason) = match parse_policies(&new_text) {
        Ok(after) => {
            let m = replay(&labeled, &before, &after);
            let reason = match labeled.first() {
                Some(sample) if lowers_confidence_floor(&after, &sample.features) => "auto-decides below the 95% confidence floor".to_string(),
                _ if m.regressed() => format!("precision regression ({:.2}% to {:.2}%)", m.precision_before(), m.precision_after()),
                _ => String::new(),
            };
            (m, reason)
        }
        Err(e) => (ReplayMetrics::default(), format!("Cedar parse error: {}", e)),
    };
    let blocked = !block_reason.is_empty();

    ctx.db.cedar_policy_store().insert(CedarPolicyStore {
        version: version_id.clone(),
        policy_text: new_text,
        created_at: ctx.timestamp,
        is_active: false,
        description: format!("{} learned rule(s) on top of {}", rule_texts.len(), base_version),
    });
    ctx.db.policy_version().insert(PolicyVersion {
        id: version_id.clone(),
        version,
        status: PolicyStatus::Proposed,
        author: match trigger.origin {
            "history_mining" => "Mined from history".to_string(),
            _ => format!("Learned from {}", trigger.case_id),
        },
        created_at: ctx.timestamp,
        decision_count: 0,
    });
    let base_rules: Vec<CedarRule> = ctx.db.cedar_rule().policy_version_id().filter(&base_version).collect();
    let mut order = 0u32;
    for rule in base_rules {
        ctx.db.cedar_rule().insert(CedarRule {
            id: format!("{}-{}", version_id, rule.order_index),
            policy_version_id: version_id.clone(),
            order_index: rule.order_index,
            ..rule
        });
        order = order.max(rule.order_index + 1);
    }
    let mut rule_ids = Vec::new();
    for (i, (rule_id, pattern, text)) in rule_texts.into_iter().enumerate() {
        ctx.db.cedar_rule().insert(CedarRule {
            id: rule_id.clone(),
            policy_version_id: version_id.clone(),
            name: text.title.clone(),
            description: text.rationale.clone(),
            cedar_code: text.cedar.clone(),
            enabled: true,
            order_index: order + i as u32,
        });
        ctx.db.mined_rule().insert(MinedRule {
            rule_id: rule_id.clone(),
            policy_version_id: version_id.clone(),
            outcome: pattern.outcome.clone(),
            conditions: condition_strings(&pattern.conditions),
            title: text.title,
            rationale: text.rationale,
            cedar_text: text.cedar,
            support: pattern.check.consistent.len() as u32,
            contradictions: pattern.check.contradicting.len() as u32,
            source_decision_ids: pattern.check.consistent.clone(),
            writer: writer.writer_id().to_string(),
            status: if blocked { "blocked" } else { "proposed" }.to_string(),
            created_at: ctx.timestamp,
        });
        rule_ids.push(rule_id);
    }
    ctx.db.policy_replay().insert(PolicyReplay {
        id: 0,
        proposed_version_id: version_id.clone(),
        current_version_id: base_version.clone(),
        status: if blocked { ReplayStatus::Blocked } else { ReplayStatus::Completed },
        total_claims: metrics.cases,
        current_claim: metrics.cases,
        precision_before: metrics.precision_before(),
        precision_after: metrics.precision_after(),
        decisions_changed: metrics.resolved,
        dollar_impact_cents: metrics.dollar_impact_cents,
        block_reason: block_reason.clone(),
        created_at: ctx.timestamp,
        is_playing: false,
        speed_multiplier: 4.0,
    });
    ctx.db.policy_proposal().insert(PolicyProposal {
        version_id: version_id.clone(),
        base_version_id: base_version,
        origin: trigger.origin.to_string(),
        trigger_decision_id: trigger.decision_id,
        trigger_case_id: trigger.case_id,
        rule_ids,
        status: if blocked { "blocked" } else { "proposed" }.to_string(),
        block_reason,
        history_cases: metrics.history_cases,
        replay_cases: metrics.cases,
        escalations_before: metrics.escalated_before,
        escalations_after: metrics.escalated_after,
        resolved: metrics.resolved,
        resolved_history: metrics.resolved_history,
        auto_before: metrics.auto_before,
        auto_after: metrics.auto_after,
        correct_before: metrics.correct_before,
        correct_after: metrics.correct_after,
        precision_before: metrics.precision_before(),
        precision_after: metrics.precision_after(),
        regressions: metrics.regressions,
        dollar_impact_cents: metrics.dollar_impact_cents,
        auto_credit_cents: metrics.auto_credit_cents,
        created_at: ctx.timestamp,
        promoted_at: None,
    });
    Some(version_id)
}

/// Runs the miner on one new human decision and records what it concluded.
pub fn learn_from_decision(ctx: &ReducerContext, decision_id: u64, case_id: &str) -> MiningResult {
    let labeled = all_labeled(ctx);
    let decision = labeled.iter().find(|l| l.id == decision_id).cloned();
    let pattern = decision.as_ref().map(|d| evaluate_decision(d, &labeled));
    let (status, proposal_version, detail, pattern) = match pattern {
        None => ("no_decisive_evidence".to_string(), None, "Decision not found".to_string(), None),
        Some(p) => {
            let proposal = if p.status == MineStatus::Proposed {
                create_proposal(ctx, std::slice::from_ref(&p), ProposalTrigger {
                    origin: "human_decision",
                    decision_id: Some(decision_id),
                    case_id: case_id.to_string(),
                })
            } else {
                None
            };
            let detail = match p.status {
                MineStatus::Proposed => format!("{} consistent decisions, none contradicting", p.check.consistent.len()),
                MineStatus::BelowSupport => format!("{} of {} consistent decisions needed; no rule proposed", p.check.consistent.len(), MIN_SUPPORT),
                MineStatus::Contradicted => format!("{} decision(s) with the same deciding features went the other way; no rule proposed", p.check.contradicting.len()),
                MineStatus::NoDecisiveEvidence => "No decisive evidence marked; a pattern needs at least one deciding feature".to_string(),
            };
            (p.status.as_str().to_string(), proposal, detail, Some(p))
        }
    };
    let p = pattern.as_ref();
    ctx.db.mining_result().insert(MiningResult {
        id: 0,
        decision_id,
        case_id: case_id.to_string(),
        status,
        pattern: p.map(|p| condition_strings(&p.conditions)).unwrap_or_default(),
        outcome: p.map(|p| p.outcome.clone()).unwrap_or_default(),
        consistent: p.map(|p| p.check.consistent.len() as u32).unwrap_or(0),
        contradicting: p.map(|p| p.check.contradicting.len() as u32).unwrap_or(0),
        consistent_ids: p.map(|p| p.check.consistent.clone()).unwrap_or_default(),
        contradiction_ids: p.map(|p| p.check.contradicting.clone()).unwrap_or_default(),
        proposal_version,
        detail,
        created_at: ctx.timestamp,
    })
}

/// Marks a promoted proposal's rules active and retires rules of the version it replaced.
pub fn on_promoted(ctx: &ReducerContext, version_id: &str) {
    let text = ctx.db.cedar_policy_store().version().find(version_id.to_string()).map(|p| p.policy_text).unwrap_or_default();
    let rules: Vec<MinedRule> = ctx.db.mined_rule().iter().collect();
    for rule in rules {
        let carried = text.contains(&format!("@id(\"{}\")", rule.rule_id));
        let status = if rule.policy_version_id == version_id || (carried && rule.status == "active") {
            "active"
        } else if rule.status == "active" {
            "retired"
        } else {
            continue;
        };
        ctx.db.mined_rule().rule_id().update(MinedRule { status: status.to_string(), ..rule });
    }
    if let Some(p) = ctx.db.policy_proposal().version_id().find(version_id.to_string()) {
        ctx.db.policy_proposal().version_id().update(PolicyProposal {
            status: "promoted".to_string(),
            promoted_at: Some(ctx.timestamp),
            ..p
        });
    }
}

pub fn insert_labeled(ctx: &ReducerContext, row: AuditDecision, evidence_json: String) -> u64 {
    let id = ctx.db.audit_decision().insert(row).id;
    ctx.db.decision_snapshot().insert(DecisionSnapshot { decision_id: id, evidence_json });
    id
}

pub fn is_deny(outcome: &str) -> bool {
    outcome == DENY
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::{tests::clean, APPROVE, PARTIAL};
    use crate::history::tests::fixture_history;

    fn base() -> PolicySet {
        parse_policies(crate::authority::get_default_policy_text()).unwrap()
    }

    fn history_labeled() -> Vec<Labeled> {
        fixture_history()
            .into_iter()
            .enumerate()
            .map(|(i, h)| Labeled {
                id: i as u64 + 1,
                credit_cents: h.credit_cents,
                outcome: h.outcome.to_string(),
                decisive: h.decisive.iter().map(|d| d.to_string()).collect(),
                features: h.features,
                history: true,
            })
            .collect()
    }

    fn escalated_under(policies: &PolicySet, labeled: &[Labeled]) -> Vec<Labeled> {
        labeled.iter().filter(|l| !gate(policies, &l.features, &assess(&l.features)).auto).cloned().collect()
    }

    fn with_rules(patterns: &[Pattern], version: &str) -> PolicySet {
        let mut text = crate::authority::get_default_policy_text().to_string();
        for (i, p) in patterns.iter().enumerate() {
            let draft = RuleDraft { rule_id: format!("{}-learned-{}", version, i + 1), pattern: p };
            text.push_str(&TemplateRuleWriter.write(&draft).cedar);
        }
        parse_policies(&text).expect("learned rules parse")
    }

    fn mined_from_history() -> (Vec<Labeled>, Vec<Pattern>) {
        let labeled = history_labeled();
        let escalated = escalated_under(&base(), &labeled);
        let patterns = mine(escalated.iter(), &labeled);
        (labeled, patterns)
    }

    #[test]
    fn miner_derives_rules_from_consistent_history_patterns() {
        let (_, patterns) = mined_from_history();
        let has = |needle: &str, outcome: &str| {
            patterns.iter().any(|p| p.outcome == outcome && condition_strings(&p.conditions).iter().any(|c| c == needle))
        };
        assert!(has("maintenance=short_notice", APPROVE), "{:?}", patterns.iter().map(|p| condition_strings(&p.conditions)).collect::<Vec<_>>());
        assert!(has("claim_vs_contract=over", PARTIAL));
        for p in &patterns {
            assert!(p.check.consistent.len() >= MIN_SUPPORT);
            assert!(p.check.contradicting.is_empty());
        }
    }

    #[test]
    fn contradicted_and_thin_patterns_are_not_proposed() {
        let (_, patterns) = mined_from_history();
        for p in &patterns {
            let c = condition_strings(&p.conditions);
            assert!(!c.contains(&"integrity=pending".to_string()), "pending-integrity reviewers disagree");
            assert!(!c.contains(&"elevation_band=below_contract_min".to_string()), "low-elevation reviewers disagree");
            assert!(!c.contains(&"weather_band=near_threshold".to_string()), "only one near-threshold full-loss decision");
        }
    }

    #[test]
    fn mined_rule_flips_held_out_claim_and_passes_replay() {
        let (labeled, patterns) = mined_from_history();
        let after = with_rules(&patterns, "v6");

        let mut held_out = clean("aether");
        held_out.lost_pct = 45;
        held_out.claim_type = "partial_downlink".into();
        held_out.claimed_cents = held_out.contract_credit_cents();
        held_out.maintenance = "short_notice".into();
        held_out.notice_hours = 30;
        let a = assess(&held_out);
        let before_gate = gate(&base(), &held_out, &a);
        assert!(!before_gate.auto, "held-out claim escalates before: {}", before_gate.confidence);
        let after_gate = gate(&after, &held_out, &a);
        assert!(after_gate.auto && after_gate.confidence >= 95, "{:?}", after_gate);
        assert_eq!(after_gate.outcome, APPROVE);
        assert!(after_gate.precedent.as_deref().unwrap().starts_with("v6-learned-"));
        assert!(after_gate.fired.iter().any(|r| r.action == "auto_approve"));

        let m = replay(&labeled, &base(), &after);
        assert!(m.resolved > 0);
        assert!(!m.regressed(), "{:.2} -> {:.2}", m.precision_before(), m.precision_after());
        assert_eq!(m.regressions, 0);
    }

    #[test]
    fn single_decision_never_creates_a_rule_and_third_consistent_one_does() {
        let mut labeled = history_labeled();
        let near = |id: u64| {
            let mut f = clean("polar-data");
            f.kp = 6.6;
            f.msg.cites_weather = true;
            Labeled {
                id,
                credit_cents: f.contract_credit_cents(),
                features: f,
                outcome: APPROVE.into(),
                decisive: vec!["weather_band".into(), "lost_band".into(), "integrity".into()],
                history: false,
            }
        };
        let first = near(100_001);
        let mut probe = first.clone();
        let a = assess(&probe.features);
        assert!(!gate(&base(), &probe.features, &a).auto);

        labeled.push(first.clone());
        assert_eq!(evaluate_decision(&first, &labeled).status, MineStatus::BelowSupport);

        let second = near(100_002);
        labeled.push(second.clone());
        let pattern = evaluate_decision(&second, &labeled);
        assert_eq!(pattern.status, MineStatus::Proposed);
        assert_eq!(pattern.check.consistent.len(), 3);

        let after = with_rules(&[pattern], "v7");
        probe.features.station_id = "trollsat".into();
        probe.features.kp = 6.2;
        let g = gate(&after, &probe.features, &a);
        assert!(g.auto && g.confidence >= 95 && g.precedent.is_some(), "{:?}", g);
    }

    #[test]
    fn marking_too_little_decisive_evidence_hits_contradictions() {
        let mut labeled = history_labeled();
        let mut f = clean("polar-data");
        f.kp = 6.6;
        f.lost_pct = 70;
        f.claim_type = "partial_downlink".into();
        let d = Labeled { id: 200_001, credit_cents: f.contract_credit_cents(), features: f, outcome: APPROVE.into(), decisive: vec!["weather_band".into()], history: false };
        labeled.push(d.clone());
        let p = evaluate_decision(&d, &labeled);
        assert_eq!(p.status, MineStatus::Contradicted, "small-loss partials share weather_band only");

        let none = Labeled { decisive: vec![], ..d };
        assert_eq!(evaluate_decision(&none, &labeled).status, MineStatus::NoDecisiveEvidence);
    }

    #[test]
    fn lowering_the_threshold_is_caught_as_a_floor_violation() {
        let text = crate::authority::get_default_policy_text().replace("confidence_percent >= 95", "confidence_percent >= 90");
        let lowered = parse_policies(&text).unwrap();
        assert!(lowers_confidence_floor(&lowered, &clean("nexus")));
        assert!(!lowers_confidence_floor(&base(), &clean("nexus")));
    }
}
