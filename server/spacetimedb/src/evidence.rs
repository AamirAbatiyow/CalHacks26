//! Deciding features of a claim and the assessment the confidence gate reads.
//!
//! Pure functions so the 6-month replay, the miner and cargo tests run the same
//! code as the reducers. The failure probability here comes from a fixed-weight
//! logistic stand-in (`PROXY_MODEL_VERSION`); the System 1 model owned by the
//! retraining work replaces it by writing `case_score` rows.

use serde::{Deserialize, Serialize};

use crate::contracts::{CustomerContract, MessageFields, NEW_ACCOUNT_DAYS};

pub const PROXY_MODEL_VERSION: &str = "proxy-logit-0";

pub const APPROVE: &str = "approve";
pub const PARTIAL: &str = "partial";
pub const DENY: &str = "deny";

/// Keys a human can mark as decisive and a learned rule can condition on.
pub const DECIDING_KEYS: [&str; 10] = [
    "claim_type",
    "tier",
    "weather_band",
    "maintenance",
    "integrity",
    "lost_band",
    "claim_vs_contract",
    "msg_cites_weather",
    "elevation_band",
    "account",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Features {
    /// dropped_pass | partial_downlink | data_integrity
    pub claim_type: String,
    pub customer_id: String,
    pub tier: String,
    pub station_id: String,
    pub pass_fee_cents: i64,
    pub claimed_cents: i64,
    /// Share of the planned contact without usable downlink, from telemetry.
    pub lost_pct: i64,
    pub max_elevation_deg: f64,
    /// Kp nearest to signal loss.
    pub kp: f32,
    pub kp_exclusion: f32,
    /// none | notified | short_notice | unplanned
    pub maintenance: String,
    pub notice_hours: i64,
    pub required_notice_hours: i64,
    /// pass | fail | pending
    pub integrity: String,
    pub msg: MessageFieldsSnapshot,
    pub new_account: bool,
    pub full_credit_lost_pct: i64,
    pub min_elevation_deg: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageFieldsSnapshot {
    pub cites_weather: bool,
    pub claims_full_loss: bool,
    pub mentions_maintenance: bool,
}

impl From<MessageFields> for MessageFieldsSnapshot {
    fn from(m: MessageFields) -> Self {
        Self { cites_weather: m.cites_weather, claims_full_loss: m.claims_full_loss, mentions_maintenance: m.mentions_maintenance }
    }
}

pub fn claim_type_for(lost_pct: i64, integrity: &str) -> &'static str {
    if integrity != "pass" && lost_pct < 25 {
        "data_integrity"
    } else if lost_pct >= 90 {
        "dropped_pass"
    } else {
        "partial_downlink"
    }
}

impl Features {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        contract: &CustomerContract,
        station_id: &str,
        pass_fee_cents: i64,
        claimed_cents: i64,
        lost_pct: i64,
        max_elevation_deg: f64,
        kp: f32,
        maintenance: &str,
        notice_hours: i64,
        integrity: &str,
        msg: MessageFields,
    ) -> Self {
        Self {
            claim_type: claim_type_for(lost_pct, integrity).to_string(),
            customer_id: contract.customer_id.clone(),
            tier: contract.tier.clone(),
            station_id: station_id.to_string(),
            pass_fee_cents,
            claimed_cents,
            lost_pct: lost_pct.clamp(0, 100),
            max_elevation_deg,
            kp,
            kp_exclusion: contract.kp_exclusion,
            maintenance: maintenance.to_string(),
            notice_hours,
            required_notice_hours: contract.maintenance_notice_hours,
            integrity: integrity.to_string(),
            msg: msg.into(),
            new_account: contract.since_days < NEW_ACCOUNT_DAYS,
            full_credit_lost_pct: contract.full_credit_lost_pct,
            min_elevation_deg: contract.min_elevation_deg,
        }
    }

    pub fn weather_band(&self) -> &'static str {
        if self.kp >= self.kp_exclusion {
            "excluded"
        } else if self.kp >= self.kp_exclusion - 1.0 {
            "near_threshold"
        } else {
            "clear"
        }
    }

    pub fn lost_band(&self) -> &'static str {
        match self.lost_pct {
            p if p >= 60 => "60_plus",
            p if p >= 25 => "25_to_59",
            _ => "under_25",
        }
    }

    pub fn elevation_band(&self) -> &'static str {
        if self.max_elevation_deg < self.min_elevation_deg { "below_contract_min" } else { "ok" }
    }

    /// Credit the contract formula pays for the telemetry-measured loss.
    pub fn contract_credit_cents(&self) -> i64 {
        let full = self.full_credit_lost_pct.max(1);
        if self.lost_pct >= full {
            self.pass_fee_cents
        } else {
            self.pass_fee_cents * self.lost_pct / full
        }
    }

    pub fn claim_vs_contract(&self) -> &'static str {
        if self.claimed_cents * 100 > self.contract_credit_cents() * 110 { "over" } else { "within" }
    }

    pub fn value(&self, key: &str) -> Option<String> {
        Some(match key {
            "claim_type" => self.claim_type.clone(),
            "tier" => self.tier.clone(),
            "weather_band" => self.weather_band().to_string(),
            "maintenance" => self.maintenance.clone(),
            "integrity" => self.integrity.clone(),
            "lost_band" => self.lost_band().to_string(),
            "claim_vs_contract" => self.claim_vs_contract().to_string(),
            "msg_cites_weather" => if self.msg.cites_weather { "yes" } else { "no" }.to_string(),
            "elevation_band" => self.elevation_band().to_string(),
            "account" => if self.new_account { "new" } else { "established" }.to_string(),
            _ => return None,
        })
    }

    pub fn deciding(&self) -> Vec<(String, String)> {
        DECIDING_KEYS.iter().map(|k| (k.to_string(), self.value(k).unwrap_or_default())).collect()
    }

    /// Credit paid for an outcome under the contract formula.
    pub fn credit_for(&self, outcome: &str) -> i64 {
        match outcome {
            APPROVE => self.claimed_cents.min(self.contract_credit_cents()),
            PARTIAL => self.contract_credit_cents().min(self.claimed_cents),
            _ => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Shap {
    pub feature: String,
    pub detail: String,
    /// Contribution to the failure log-odds relative to the reference claim.
    pub value: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Conflict {
    pub sources: String,
    pub detail: String,
    pub penalty: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Assessment {
    pub recommended: &'static str,
    pub credit_cents: i64,
    /// Probability the loss was a provider-side failure that the contract credits.
    pub failure_prob: f64,
    pub confidence: i64,
    pub shap: Vec<Shap>,
    pub conflicts: Vec<Conflict>,
    pub model_version: String,
}

fn dollars(cents: i64) -> String {
    let d = cents / 100;
    let s = d.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    format!("{}${}", if d < 0 { "-" } else { "" }, out)
}

pub fn format_dollars(cents: i64) -> String {
    dollars(cents)
}

/// Logistic terms: (feature, detail, x, weight, reference x). SHAP for a linear
/// logit is exact: phi = w * (x - reference).
fn proxy_terms(f: &Features) -> Vec<(&'static str, String, f64, f64, f64)> {
    let lost = f.lost_pct as f64 / 100.0;
    let ratio = if f.contract_credit_cents() > 0 {
        f.claimed_cents as f64 / f.contract_credit_cents() as f64
    } else {
        3.0
    };
    let band = f.weather_band();
    // Indicator features are labeled by the state the claim is actually in, so a
    // positive contribution from an absent risk reads as such.
    let flag = |on: bool, yes: &'static str, no: &'static str| (if on { yes } else { no }, on as i32 as f64);
    let (excluded, excluded_x) = flag(band == "excluded", "Space weather excluded", "Space weather not excluded");
    let (near, near_x) = flag(band == "near_threshold", "Space weather near exclusion", "Space weather not near exclusion");
    let (notified, notified_x) = flag(f.maintenance == "notified", "Notified maintenance", "No notified maintenance");
    let (outage, outage_x) = flag(f.maintenance == "unplanned", "Unplanned station outage", "No unplanned outage");
    let (low, low_x) = flag(f.elevation_band() != "ok", "Below contract min elevation", "Above contract min elevation");
    let (failed, failed_x) = flag(f.integrity == "fail", "Data integrity failed", "Data integrity not failed");
    let (pending, pending_x) = flag(f.integrity == "pending", "Data integrity pending", "Data integrity settled");
    vec![
        ("Telemetry loss", format!("{}% of contact without downlink", f.lost_pct), lost, 2.0, 0.55),
        (excluded, format!("Kp {:.1} vs contract exclusion {:.1}", f.kp, f.kp_exclusion), excluded_x, -8.5, 0.12),
        (near, format!("Kp {:.1}, {:.1} below exclusion", f.kp, (f.kp_exclusion - f.kp).max(0.0)), near_x, -1.5, 0.02),
        (notified, if f.maintenance == "none" { "none logged".to_string() } else { format!("{}h notice, contract needs {}h", f.notice_hours, f.required_notice_hours) }, notified_x, -8.5, 0.06),
        (outage, "maintenance log".to_string(), outage_x, 1.5, 0.01),
        (low, format!("{:.1}° max vs {:.0}° minimum", f.max_elevation_deg, f.min_elevation_deg), low_x, -6.0, 0.04),
        (failed, "checksum and frame counts".to_string(), failed_x, -7.0, 0.03),
        (pending, format!("integrity {}", f.integrity), pending_x, -1.0, 0.05),
        ("Claim vs contract credit", format!("{} claimed vs {} contract credit", dollars(f.claimed_cents), dollars(f.contract_credit_cents())), (ratio - 1.0).clamp(0.0, 3.0), -0.8, 0.15),
    ]
}

const PROXY_INTERCEPT: f64 = 3.2;

pub fn failure_score(f: &Features) -> (f64, Vec<Shap>) {
    let terms = proxy_terms(f);
    let logit = PROXY_INTERCEPT + terms.iter().map(|(_, _, x, w, _)| w * x).sum::<f64>();
    let p = 1.0 / (1.0 + (-logit).exp());
    let mut shap: Vec<Shap> = terms
        .into_iter()
        .map(|(feature, detail, x, w, reference)| Shap { feature: feature.to_string(), detail, value: (w * (x - reference)) as f32 })
        .filter(|s| s.value.abs() >= 0.01)
        .collect();
    shap.sort_by(|a, b| b.value.abs().total_cmp(&a.value.abs()));
    (p, shap)
}

/// Contract-literal recommendation: what the clause says before any judgment.
pub fn recommend(f: &Features) -> &'static str {
    if f.integrity == "fail" && f.lost_pct < 25 {
        DENY
    } else if f.weather_band() == "excluded" || f.maintenance == "notified" || f.elevation_band() != "ok" {
        DENY
    } else if f.claim_vs_contract() == "over" {
        PARTIAL
    } else {
        APPROVE
    }
}

/// Places where two sources disagree or a clause is borderline. Each lowers confidence.
pub fn conflicts(f: &Features) -> Vec<Conflict> {
    let mut out = Vec::new();
    let mut add = |sources: &str, detail: String, penalty: i64| {
        out.push(Conflict { sources: sources.to_string(), detail, penalty })
    };
    let band = f.weather_band();
    if band == "near_threshold" {
        add("space weather × contract", format!("Kp {:.1} is {:.1} below the Kp {:.1} exclusion, so the storm is not excused but was active", f.kp, f.kp_exclusion - f.kp, f.kp_exclusion), 15);
    }
    if f.msg.cites_weather && band != "excluded" {
        add("message × contract", "Customer attributes the loss to space weather, which the contract would excuse only above its threshold".to_string(), 6);
    }
    if f.maintenance == "short_notice" {
        add("maintenance log × contract", format!("Planned work announced {}h ahead; contract requires {}h", f.notice_hours, f.required_notice_hours), 15);
    }
    if f.claim_vs_contract() == "over" {
        add("message × contract", format!("Claimed {} but the credit formula gives {}", dollars(f.claimed_cents), dollars(f.contract_credit_cents())), 8);
    }
    if f.integrity == "pending" {
        add("telemetry", "Data integrity verification not complete".to_string(), 12);
    }
    if f.msg.claims_full_loss && f.lost_pct < 90 {
        add("message × telemetry", format!("Customer reports a full loss; telemetry shows {}% lost", f.lost_pct), 8);
    }
    if f.elevation_band() != "ok" {
        add("telemetry × contract", format!("Pass peaked at {:.1}°, below the {:.0}° best-effort line", f.max_elevation_deg, f.min_elevation_deg), 10);
    }
    if f.new_account {
        add("customer history", "New account with no prior decisions to compare against".to_string(), 10);
    }
    out
}

pub fn assess(f: &Features) -> Assessment {
    let (p, shap) = failure_score(f);
    let recommended = recommend(f);
    let agreement = if recommended == DENY { 1.0 - p } else { p };
    let conflicts = conflicts(f);
    let penalty: i64 = conflicts.iter().map(|c| c.penalty).sum();
    let confidence = ((agreement * 100.0).floor() as i64 - penalty).clamp(5, 99);
    Assessment {
        recommended,
        credit_cents: f.credit_for(recommended),
        failure_prob: p,
        confidence,
        shap,
        conflicts,
        model_version: PROXY_MODEL_VERSION.to_string(),
    }
}

/// `assess` with a trained System 1 supplying the probability instead of the proxy.
/// `p_approve` is the model's probability that a human would credit the claim, so
/// confidence is agreement with paying the recommended credit (or with paying
/// nothing when the contract-literal credit is zero), minus the evidence conflicts.
pub fn assess_with_model(f: &Features, p_approve: f64, model_version: &str, shap: Vec<Shap>) -> Assessment {
    let recommended = recommend(f);
    let credit_cents = f.credit_for(recommended);
    let pays = recommended != DENY && credit_cents > 0;
    let agreement = if pays { p_approve } else { 1.0 - p_approve };
    let conflicts = conflicts(f);
    let penalty: i64 = conflicts.iter().map(|c| c.penalty).sum();
    Assessment {
        recommended,
        credit_cents,
        failure_prob: p_approve,
        confidence: ((agreement * 100.0).floor() as i64 - penalty).clamp(5, 99),
        shap,
        conflicts,
        model_version: model_version.to_string(),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::contracts::fixture_contracts;

    pub fn contract(id: &str) -> CustomerContract {
        fixture_contracts().into_iter().find(|c| c.customer_id == id).unwrap()
    }

    pub fn clean(id: &str) -> Features {
        let c = contract(id);
        Features::new(&c, "svalsat", 480_000, 480_000, 100, 60.0, 2.0, "none", 0, "pass", MessageFields::default())
    }

    #[test]
    fn clean_dropped_pass_is_confident_full_credit() {
        let a = assess(&clean("northpoint"));
        assert_eq!(a.recommended, APPROVE);
        assert_eq!(a.credit_cents, 480_000);
        assert!(a.confidence >= 95, "{}", a.confidence);
        assert!(a.conflicts.is_empty());
    }

    #[test]
    fn excluded_storm_is_a_confident_denial() {
        let mut f = clean("skynet");
        f.kp = 6.3;
        let a = assess(&f);
        assert_eq!((f.weather_band(), a.recommended), ("excluded", DENY));
        assert!(a.confidence >= 95, "{}", a.confidence);
    }

    #[test]
    fn near_threshold_storm_escalates() {
        let mut f = clean("polar-data");
        f.kp = 6.7;
        f.msg.cites_weather = true;
        let a = assess(&f);
        assert_eq!(f.weather_band(), "near_threshold");
        assert!(a.confidence < 95, "{}", a.confidence);
        assert_eq!(a.conflicts.len(), 2);
    }

    #[test]
    fn contract_credit_is_pro_rata_below_full_threshold() {
        let mut f = clean("polar-data");
        f.lost_pct = 30;
        assert_eq!(f.contract_credit_cents(), 240_000);
        assert_eq!(f.claim_vs_contract(), "over");
        assert_eq!(recommend(&f), PARTIAL);
    }

    #[test]
    fn shap_values_sum_to_logit_minus_reference() {
        let mut f = clean("kestrel");
        f.lost_pct = 40;
        f.maintenance = "notified".into();
        let (p, shap) = failure_score(&f);
        let reference_logit = PROXY_INTERCEPT + proxy_terms(&f).iter().map(|(_, _, _, w, r)| w * r).sum::<f64>();
        let logit = (p / (1.0 - p)).ln();
        let total: f64 = proxy_terms(&f).iter().map(|(_, _, x, w, r)| w * (x - r)).sum();
        assert!((logit - reference_logit - total).abs() < 1e-9);
        assert!(shap.windows(2).all(|w| w[0].value.abs() >= w[1].value.abs()));
    }
}
