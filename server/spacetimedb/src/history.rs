//! Six months of human audit decisions: the known data the automation starts from.
//!
//! Synthetic but structured like a real review desk. Claim volume per station and
//! month is the station's pass count (monthly revenue / average pass fee) times
//! the claim rate the pass generator assumes (drops plus disputes) that the
//! confidence gate leaves to a human. Reviewers follow consistent practices in some situations
//! (minable patterns), disagree in others (contradiction zones), and occasionally
//! decide against the evidence for reasons the record does not capture (noise).

use crate::contracts::CustomerContract;
use crate::evidence::{Features, APPROVE, DENY, PARTIAL};

/// Share of passes that become a claim a human decides: the pass generator's drop
/// rate plus its dispute rate, times the share the confidence gate does not
/// auto-decide (fixtures/contracts.json), so both seeds agree.
pub fn claim_rate() -> f64 {
    let v: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/contracts.json")).expect("contracts.json");
    let claims = v["drop_rate"].as_f64().unwrap_or(0.015) + v["settlement"]["dispute_per_mille"].as_f64().unwrap_or(20.0) / 1000.0;
    claims * (100.0 - v["settlement"]["auto_decided_pct"].as_f64().unwrap_or(0.0)) / 100.0
}
pub const HISTORY_DAYS: i64 = 182;
/// Share of decisions in the consistent zones that go against the usual practice.
pub const NOISE_RATE: f64 = 0.01;

pub const REVIEWERS: [&str; 5] = ["S. Chen", "J. Wilson", "M. Okafor", "A. Lindqvist", "R. Patel"];

#[derive(Clone, Debug)]
pub struct HistoryCase {
    pub features: Features,
    pub outcome: &'static str,
    pub credit_cents: i64,
    pub reason_code: &'static str,
    pub reason_text: String,
    pub decisive: Vec<&'static str>,
    pub reviewer: &'static str,
    /// Days before now the decision was made.
    pub days_ago: f64,
    /// Generating situation, for tests and the README; not shown as evidence.
    pub zone: &'static str,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct StationVolume {
    pub station_id: String,
    pub monthly_revenue_cents: i64,
    pub avg_pass_fee_cents: i64,
}

/// splitmix64: deterministic in the module and in tests.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.unit()
    }
    pub fn int(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next_u64() % ((hi - lo + 1) as u64)) as i64
    }
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next_u64() % items.len() as u64) as usize]
    }
}

fn hash(parts: &[u64]) -> u64 {
    parts.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, p| (h ^ p).wrapping_mul(0x1000_0000_01b3))
}

fn str_hash(s: &str) -> u64 {
    hash(&s.bytes().map(|b| b as u64).collect::<Vec<_>>())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Zone {
    Clean,
    Excluded,
    Notified,
    ShortNotice,
    OverClaim,
    PendingFullLoss,
    LowElevation,
    Unplanned,
    IntegrityFail,
}

fn zone_for(rng: &mut Rng) -> Zone {
    let table = [
        (Zone::Clean, 0.56),
        (Zone::Excluded, 0.12),
        (Zone::Notified, 0.06),
        (Zone::ShortNotice, 0.06),
        (Zone::OverClaim, 0.08),
        (Zone::PendingFullLoss, 0.05),
        (Zone::LowElevation, 0.04),
        (Zone::Unplanned, 0.01),
        (Zone::IntegrityFail, 0.02),
    ];
    let mut u = rng.unit();
    for (zone, p) in table {
        if u < p {
            return zone;
        }
        u -= p;
    }
    Zone::Clean
}

const WEATHER_MESSAGES: [&str; 3] = [
    "We lost the downlink during the geomagnetic storm and request credit under our SLA.",
    "Contact degraded while aurora activity was reported over the station. Please review for credit.",
    "Space weather alerts were active and our pass failed. Requesting credit.",
];
const PLAIN_MESSAGES: [&str; 3] = [
    "The scheduled contact did not deliver the expected data volume. Please review for a service credit.",
    "Our ops team saw the link drop before LOS. Requesting the SLA credit for this pass.",
    "Telemetry from the pass is incomplete. Please confirm and credit per contract.",
];
const FULL_LOSS_MESSAGES: [&str; 2] = [
    "We received no data at all from this pass and expect a full credit.",
    "The entire contact was lost. Requesting a full refund of the pass fee.",
];

fn round_cents(cents: f64) -> i64 {
    ((cents / 100.0).round() as i64) * 100
}

/// One historical claim in the given situation, with the reviewer's decision.
fn build_case(rng: &mut Rng, zone: Zone, contracts: &[&CustomerContract], station: &StationVolume, days_ago: f64) -> HistoryCase {
    let low_elevation_contracts: Vec<&CustomerContract> =
        contracts.iter().copied().filter(|c| c.min_elevation_deg >= 8.0).collect();
    let contract: &CustomerContract = if zone == Zone::LowElevation {
        *rng.pick(&low_elevation_contracts)
    } else {
        *rng.pick(contracts)
    };
    let fee = round_cents(station.avg_pass_fee_cents as f64 * rng.range(0.7, 1.3));
    let dropped = rng.chance(0.4);
    let mut lost = if dropped { rng.int(90, 100) } else { rng.int(10, 89) };
    let mut kp = rng.range(0.3, (contract.kp_exclusion - 1.3) as f64) as f32;
    let mut maintenance = "none";
    let mut notice = 0;
    let mut integrity = "pass";
    let mut elevation = rng.range(15.0, 85.0);
    let mut msg = if rng.chance(0.08) { *rng.pick(&WEATHER_MESSAGES) } else { *rng.pick(&PLAIN_MESSAGES) };
    let mut over = false;

    match zone {
        Zone::Excluded => {
            kp = rng.range(contract.kp_exclusion as f64, (contract.kp_exclusion + 1.5).min(9.0) as f64) as f32;
            if rng.chance(0.7) {
                msg = rng.pick(&WEATHER_MESSAGES);
            }
        }
        Zone::Notified => {
            maintenance = "notified";
            notice = contract.maintenance_notice_hours + rng.int(0, 96);
        }
        Zone::ShortNotice => {
            maintenance = "short_notice";
            notice = rng.int(4, contract.maintenance_notice_hours - 12);
            msg = rng.pick(&PLAIN_MESSAGES);
        }
        Zone::OverClaim => {
            lost = rng.int(10, (contract.full_credit_lost_pct * 7 / 10).max(11));
            over = true;
            msg = rng.pick(&FULL_LOSS_MESSAGES);
        }
        Zone::PendingFullLoss => {
            integrity = "pending";
            lost = rng.int(10, 24);
            msg = rng.pick(&FULL_LOSS_MESSAGES);
        }
        Zone::LowElevation => {
            elevation = rng.range(2.0, contract.min_elevation_deg - 0.5);
            msg = rng.pick(&PLAIN_MESSAGES);
        }
        Zone::Unplanned => {
            maintenance = "unplanned";
        }
        Zone::IntegrityFail => {
            integrity = "fail";
            lost = rng.int(0, 20);
        }
        Zone::Clean => {}
    }

    let fields = crate::contracts::extract_message_fields(msg);
    let mut f = Features::new(contract, &station.station_id, fee, 0, lost, elevation, kp, maintenance, notice, integrity, fields);
    let credit = f.contract_credit_cents();
    f.claimed_cents = if over || zone == Zone::PendingFullLoss {
        fee
    } else {
        round_cents(credit as f64 * rng.range(0.85, 1.0)).max(100)
    };

    let (mut outcome, mut code, mut text, decisive): (&'static str, &'static str, String, Vec<&'static str>) = match zone {
        Zone::Clean => (APPROVE, "contract_credit", "Provider-side loss confirmed by telemetry; credited per contract formula.".into(), vec!["lost_band", "weather_band", "maintenance"]),
        Zone::Excluded => (DENY, "excused_space_weather", format!("Kp {:.1} at signal loss meets the Kp {:.1} exclusion.", f.kp, f.kp_exclusion), vec!["weather_band"]),
        Zone::Notified => (DENY, "excused_maintenance", format!("Maintenance notified {}h ahead, contract requires {}h.", notice, f.required_notice_hours), vec!["maintenance"]),
        Zone::ShortNotice => (APPROVE, "notice_not_met", format!("Maintenance notice of {}h fell short of the {}h clause, so it is not excused.", notice, f.required_notice_hours), vec!["maintenance", "weather_band", "integrity"]),
        Zone::OverClaim => (PARTIAL, "credit_formula", "Claim exceeds the contract formula; credited the formula amount for the measured loss.".into(), vec!["claim_vs_contract", "weather_band", "maintenance", "integrity"]),
        Zone::PendingFullLoss => {
            if rng.chance(0.55) {
                (APPROVE, "benefit_of_doubt", "Integrity check unresolved; paid the claim given the customer's report.".into(), vec!["integrity", "claim_vs_contract"])
            } else {
                (PARTIAL, "credit_formula", "Integrity check unresolved; paid only the measured loss.".into(), vec!["integrity", "claim_vs_contract"])
            }
        }
        Zone::LowElevation => {
            if rng.chance(0.82) {
                (DENY, "best_effort_elevation", "Pass below the contract's minimum elevation is best effort.".into(), vec!["elevation_band"])
            } else {
                (APPROVE, "goodwill", "Low pass, but the station fault is clear in the log; credited as goodwill.".into(), vec!["elevation_band"])
            }
        }
        Zone::Unplanned => (APPROVE, "station_outage", "Unplanned station outage overlaps the contact.".into(), vec!["maintenance"]),
        Zone::IntegrityFail => (DENY, "data_delivered", "Telemetry shows the data was delivered; integrity failure is customer-side.".into(), vec!["integrity", "lost_band"]),
    };

    let consistent_zone = matches!(zone, Zone::Clean | Zone::Excluded | Zone::Notified);
    if consistent_zone && rng.chance(NOISE_RATE) {
        if outcome == DENY {
            outcome = APPROVE;
            code = "goodwill";
            text = "Long-standing customer; credited as goodwill despite the exclusion.".into();
        } else {
            outcome = DENY;
            code = "duplicate";
            text = "Duplicate of a claim already credited on another ticket.".into();
        }
    }

    let credit_cents = match outcome {
        APPROVE if zone == Zone::PendingFullLoss => f.claimed_cents,
        _ => f.credit_for(outcome),
    };
    HistoryCase {
        features: f,
        outcome,
        credit_cents,
        reason_code: code,
        reason_text: text,
        decisive,
        reviewer: *rng.pick(&REVIEWERS),
        days_ago,
        zone: match zone {
            Zone::Clean => "clean",
            Zone::Excluded => "excluded",
            Zone::Notified => "notified",
            Zone::ShortNotice => "short_notice",
            Zone::OverClaim => "over_claim",
            Zone::PendingFullLoss => "pending_full_loss",
            Zone::LowElevation => "low_elevation",
            Zone::Unplanned => "unplanned",
            Zone::IntegrityFail => "integrity_fail",
        },
        message: msg.to_string(),
    }
}

/// Storm claims just under a Gold contract's exclusion. Rare: one full-loss
/// approval and two small-loss partials, so a reviewer pattern exists but has
/// not yet reached the three decisions a rule needs.
fn near_threshold_cases(contracts: &[&CustomerContract], stations: &[StationVolume]) -> Vec<HistoryCase> {
    let Some(gold) = contracts.iter().find(|c| c.tier == "gold") else { return Vec::new() };
    let Some(station) = stations.first() else { return Vec::new() };
    let storm = |lost: i64, claimed_full: bool| {
        let fields = crate::contracts::extract_message_fields(WEATHER_MESSAGES[0]);
        let fee = station.avg_pass_fee_cents;
        let mut f = Features::new(gold, &station.station_id, fee, 0, lost, 52.0, gold.kp_exclusion - 0.4, "none", 0, "pass", fields);
        f.claimed_cents = if claimed_full { fee } else { f.contract_credit_cents() };
        f
    };
    let full = storm(100, true);
    let small_a = storm(18, true);
    let small_b = storm(22, true);
    vec![
        HistoryCase {
            credit_cents: full.credit_for(APPROVE),
            features: full,
            outcome: APPROVE,
            reason_code: "below_exclusion",
            reason_text: "Kp below the contract's exclusion; full loss is provider-side, credited in full.".into(),
            decisive: vec!["weather_band", "lost_band", "integrity"],
            reviewer: "S. Chen",
            days_ago: 41.0,
            zone: "near_threshold",
            message: WEATHER_MESSAGES[0].into(),
        },
        HistoryCase {
            credit_cents: small_a.credit_for(PARTIAL),
            features: small_a,
            outcome: PARTIAL,
            reason_code: "credit_formula",
            reason_text: "Storm below exclusion; paid the measured loss only.".into(),
            decisive: vec!["weather_band", "lost_band"],
            reviewer: "M. Okafor",
            days_ago: 97.0,
            zone: "near_threshold",
            message: WEATHER_MESSAGES[0].into(),
        },
        HistoryCase {
            credit_cents: small_b.credit_for(PARTIAL),
            features: small_b,
            outcome: PARTIAL,
            reason_code: "credit_formula",
            reason_text: "Storm below exclusion; paid the measured loss only.".into(),
            decisive: vec!["weather_band", "lost_band"],
            reviewer: "J. Wilson",
            days_ago: 133.0,
            zone: "near_threshold",
            message: WEATHER_MESSAGES[0].into(),
        },
    ]
}

/// The full 6-month history, oldest first.
pub fn generate(stations: &[StationVolume], contracts: &[CustomerContract]) -> Vec<HistoryCase> {
    let established: Vec<&CustomerContract> = contracts.iter().filter(|c| c.since_days >= HISTORY_DAYS).collect();
    if established.is_empty() {
        return Vec::new();
    }
    let rate = claim_rate();
    let mut out = Vec::new();
    for station in stations {
        let fee = station.avg_pass_fee_cents.max(1);
        let per_month = (station.monthly_revenue_cents as f64 / fee as f64 * rate).round() as i64;
        for month in 0..6i64 {
            for i in 0..per_month {
                let mut rng = Rng::new(hash(&[str_hash(&station.station_id), month as u64, i as u64]));
                let zone = zone_for(&mut rng);
                let days_ago = HISTORY_DAYS as f64 - (month as f64 * 30.0 + rng.range(0.0, 30.0));
                out.push(build_case(&mut rng, zone, &established, station, days_ago.max(1.0)));
            }
        }
    }
    out.extend(near_threshold_cases(&established, stations));
    out.sort_by(|a, b| b.days_ago.total_cmp(&a.days_ago));
    out
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::contracts::fixture_contracts;

    /// Volumes the pass generator would produce: the contracted daily contacts
    /// spread over the fixture stations at the default pass fee.
    pub fn fixture_volumes() -> Vec<StationVolume> {
        let stations: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/stations.json")).unwrap();
        let config: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/contracts.json")).unwrap();
        let contacts_per_day: f64 = config["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["norad_ids"].as_array().unwrap().len() as f64 * c["contacts_per_satellite_per_day"].as_f64().unwrap())
            .sum();
        let stations = stations.as_array().unwrap();
        let per_station = contacts_per_day * 30.0 / stations.len() as f64;
        stations
            .iter()
            .map(|s| StationVolume {
                station_id: s["id"].as_str().unwrap().to_string(),
                monthly_revenue_cents: (per_station * DEFAULT_PASS_FEE_CENTS as f64) as i64,
                avg_pass_fee_cents: DEFAULT_PASS_FEE_CENTS,
            })
            .collect()
    }

    pub fn fixture_history() -> Vec<HistoryCase> {
        generate(&fixture_volumes(), &fixture_contracts())
    }

    #[test]
    fn history_volume_tracks_pass_revenue() {
        let volumes = fixture_volumes();
        let history = fixture_history();
        let expected: f64 = volumes
            .iter()
            .map(|v| (v.monthly_revenue_cents as f64 / v.avg_pass_fee_cents as f64 * claim_rate()).round() * 6.0)
            .sum();
        assert_eq!(history.len() as f64, expected + 3.0);
        let revenue: i64 = volumes.iter().map(|v| v.monthly_revenue_cents * 6).sum();
        let credits: i64 = history.iter().map(|h| h.credit_cents).sum();
        let share = credits as f64 / revenue as f64;
        assert!((0.002..claim_rate()).contains(&share), "credits are {:.3}% of revenue", share * 100.0);
        assert!(history.iter().all(|h| h.credit_cents <= h.features.pass_fee_cents));
    }

    #[test]
    fn history_is_deterministic_and_spans_six_months() {
        let a = fixture_history();
        let b = fixture_history();
        assert_eq!(a.len(), b.len());
        assert!(a.iter().zip(&b).all(|(x, y)| x.features == y.features && x.outcome == y.outcome));
        assert!(a.iter().all(|h| h.days_ago <= HISTORY_DAYS as f64 && h.days_ago >= 1.0));
        assert!(a.iter().any(|h| h.days_ago > 150.0));
    }

    #[test]
    fn history_has_noise_and_contradiction_zones() {
        let history = fixture_history();
        let zone_outcomes = |zone: &str| {
            let mut o: Vec<&str> = history.iter().filter(|h| h.zone == zone).map(|h| h.outcome).collect();
            o.sort();
            o.dedup();
            o
        };
        assert_eq!(zone_outcomes("pending_full_loss"), [APPROVE, PARTIAL]);
        assert_eq!(zone_outcomes("low_elevation"), [APPROVE, DENY]);
        assert_eq!(zone_outcomes("short_notice"), [APPROVE]);
        assert!(history.iter().any(|h| h.reason_code == "duplicate" || h.reason_code == "goodwill" && h.zone != "low_elevation"));
    }
}

/// Fallback pass fee when a station has no passes yet: a 10-minute contact at
/// the $20/min midpoint of the fixture's narrowband and wideband rates.
pub const DEFAULT_PASS_FEE_CENTS: i64 = 20_000;

// ---------------------------------------------------------------- seeding

use serde_json::json;
use spacetimedb::{ReducerContext, Table, Timestamp};

use crate::authority::cedar_policy_store;
use crate::contracts::{customer_contract, maintenance_log, MaintenanceLog};
use crate::evidence::assess;
use crate::learning::{
    active_policy_set, all_labeled, create_proposal, gate, insert_labeled, audit_decision, mine, mined_rule, parse_policies, policy_proposal,
    replay, AuditDecision, MinedRule, PolicyProposal, ProposalTrigger,
};
use crate::policy::{cedar_rule, policy_replay, policy_version, PolicyReplay, PolicyStatus, PolicyVersion, ReplayStatus};
use crate::{pass, station};

const DAY_MICROS: i64 = 24 * 60 * 60 * 1_000_000;

fn station_volumes(ctx: &ReducerContext) -> Vec<StationVolume> {
    let mut stations: Vec<_> = ctx.db.station().iter().collect();
    stations.sort_by(|a, b| a.id.cmp(&b.id));
    stations
        .into_iter()
        .map(|s| {
            let fees: Vec<i64> = ctx.db.pass().station_id().filter(&s.id).take(500).map(|p| p.revenue_cents).collect();
            StationVolume {
                avg_pass_fee_cents: if fees.is_empty() { DEFAULT_PASS_FEE_CENTS } else { fees.iter().sum::<i64>() / fees.len() as i64 },
                monthly_revenue_cents: s.monthly_revenue_cents,
                station_id: s.id,
            }
        })
        .collect()
}

/// Seeds the 6-month labeled history and station maintenance log, mines it for
/// policies, promotes the mined version, and replays the proposed threshold
/// change. Run after stations, passes, contracts, `init_authority`.
#[spacetimedb::reducer]
pub fn seed_learning_history(ctx: &ReducerContext) {
    seed_history(ctx, true);
}

/// `seed_learning_history` with the mined version left proposed, so the base
/// version stays current until someone promotes the mined one.
#[spacetimedb::reducer]
pub fn seed_learning_history_staged(ctx: &ReducerContext) {
    seed_history(ctx, false);
}

fn seed_history(ctx: &ReducerContext, promote: bool) {
    if ctx.db.audit_decision().iter().next().is_some() {
        log::info!("Learning history already seeded");
        return;
    }
    let contracts: Vec<_> = ctx.db.customer_contract().iter().collect();
    let history = generate(&station_volumes(ctx), &contracts);
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let (base_version, base) = active_policy_set(ctx);

    for (n, station) in ctx.db.station().iter().map(|s| s.id).collect::<Vec<_>>().iter().enumerate() {
        for m in 0..6i64 {
            let start = now - (m * 30 + 4 + n as i64 % 7) * DAY_MICROS;
            ctx.db.maintenance_log().insert(MaintenanceLog {
                id: 0,
                station_id: station.clone(),
                start_time: Timestamp::from_micros_since_unix_epoch(start),
                end_time: Timestamp::from_micros_since_unix_epoch(start + 3 * 60 * 60 * 1_000_000),
                kind: "planned".to_string(),
                notice_hours: 336,
                description: "Monthly antenna and feed maintenance".to_string(),
            });
        }
    }

    for (i, h) in history.iter().enumerate() {
        let f = &h.features;
        let a = assess(f);
        let g = gate(&base, f, &a);
        let decided = now - (h.days_ago * DAY_MICROS as f64) as i64;
        if f.maintenance != "none" {
            let start = decided - 2 * DAY_MICROS;
            ctx.db.maintenance_log().insert(MaintenanceLog {
                id: 0,
                station_id: f.station_id.clone(),
                start_time: Timestamp::from_micros_since_unix_epoch(start),
                end_time: Timestamp::from_micros_since_unix_epoch(start + 2 * 60 * 60 * 1_000_000),
                kind: if f.maintenance == "unplanned" { "unplanned" } else { "planned" }.to_string(),
                notice_hours: f.notice_hours,
                description: match f.maintenance.as_str() {
                    "unplanned" => "Unplanned outage: RF chain fault".to_string(),
                    _ => format!("Planned maintenance, customer notice {}h ahead", f.notice_hours),
                },
            });
        }
        let contract = contracts.iter().find(|c| c.customer_id == f.customer_id);
        let snapshot = json!({
            "case_id": format!("H-{:05}", i + 1),
            "claim_type": f.claim_type,
            "features": f,
            "contract": contract,
            "message": {"body": h.message, "extracted": f.msg},
            "ml": {"failure_prob": a.failure_prob, "model_version": a.model_version, "shap": a.shap},
            "conflicts": a.conflicts,
            "gate": g,
        })
        .to_string();
        insert_labeled(ctx, AuditDecision {
            id: 0,
            source: "history".to_string(),
            case_id: format!("H-{:05}", i + 1),
            decided_at: Timestamp::from_micros_since_unix_epoch(decided),
            reviewer: h.reviewer.to_string(),
            claim_type: f.claim_type.clone(),
            customer_id: f.customer_id.clone(),
            customer_name: contract.map(|c| c.name.clone()).unwrap_or_default(),
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
            ai_recommended: a.recommended.to_string(),
            ai_confidence: g.confidence,
            ml_failure_prob: a.failure_prob as f32,
            escalated: !g.auto,
            outcome: h.outcome.to_string(),
            credit_cents: h.credit_cents,
            reason_code: h.reason_code.to_string(),
            reason_text: h.reason_text.clone(),
            decisive: h.decisive.iter().map(|d| d.to_string()).collect(),
            policy_version: base_version.clone(),
            model_version: a.model_version.clone(),
        }, snapshot);
    }

    let labeled = all_labeled(ctx);
    let escalated: Vec<_> = labeled.iter().filter(|l| !gate(&base, &l.features, &assess(&l.features)).auto).cloned().collect();
    let patterns = mine(escalated.iter(), &labeled);
    log::info!("History: {} decisions, {} escalated under {}, {} minable patterns", labeled.len(), escalated.len(), base_version, patterns.len());
    if let Some(version) = create_proposal(ctx, &patterns, ProposalTrigger { origin: "history_mining", decision_id: None, case_id: "6-month history".to_string() }) {
        let promotable = ctx.db.policy_proposal().version_id().find(&version).map(|p| p.status == "proposed").unwrap_or(false);
        if promote && promotable {
            crate::policy::promote_policy_version(ctx, version);
        }
    }
    replay_threshold_proposal(ctx, &base_version);
}

/// Resets the policy store to the state `seed_learning_history_staged` leaves,
/// without a reseed: the history-mined proposal's base is current again, the
/// mined version and its rules are proposed again, every later policy version is
/// deleted, and Break It reruns under the restored policy. Labeled decisions,
/// decided claims and the ledger are kept, so claims already decided stay decided.
#[spacetimedb::reducer]
pub fn rewind_to_mined_proposal(ctx: &ReducerContext) -> Result<(), String> {
    let mined = ctx
        .db
        .policy_proposal()
        .iter()
        .find(|p| p.origin == "history_mining")
        .ok_or("no history-mined proposal; run seed_learning_history first")?;
    let mined_number = ctx.db.policy_version().id().find(mined.version_id.clone()).map(|v| v.version).ok_or("history-mined version is missing")?;
    if ctx.db.cedar_policy_store().version().find(mined.base_version_id.clone()).is_none() {
        return Err(format!("no Cedar text stored for {}", mined.base_version_id));
    }

    let later: Vec<String> = ctx.db.policy_version().iter().filter(|v| v.version > mined_number).map(|v| v.id).collect();
    for id in &later {
        ctx.db.policy_version().id().delete(id.clone());
        ctx.db.policy_proposal().version_id().delete(id.clone());
        ctx.db.cedar_policy_store().version().delete(id.clone());
        let rules: Vec<String> = ctx.db.cedar_rule().policy_version_id().filter(id).map(|r| r.id).collect();
        for rule in rules {
            ctx.db.cedar_rule().id().delete(rule);
        }
        let learned: Vec<String> = ctx.db.mined_rule().policy_version_id().filter(id).map(|r| r.rule_id).collect();
        for rule in learned {
            ctx.db.mined_rule().rule_id().delete(rule);
        }
        let replays: Vec<u64> = ctx.db.policy_replay().proposed_version_id().filter(id).map(|r| r.id).collect();
        for replay in replays {
            ctx.db.policy_replay().id().delete(replay);
        }
    }

    for v in ctx.db.policy_version().iter().collect::<Vec<_>>() {
        let status = if v.id == mined.base_version_id {
            PolicyStatus::Current
        } else if v.id == mined.version_id {
            PolicyStatus::Proposed
        } else if v.status == PolicyStatus::Current {
            PolicyStatus::Retired
        } else {
            continue;
        };
        ctx.db.policy_version().id().update(PolicyVersion { status, ..v });
    }
    let rules: Vec<MinedRule> = ctx.db.mined_rule().policy_version_id().filter(&mined.version_id).collect();
    for rule in rules {
        ctx.db.mined_rule().rule_id().update(MinedRule { status: "proposed".to_string(), ..rule });
    }
    crate::authority::activate_policy_version(ctx, &mined.base_version_id, "Rewound to before the history-mined proposal");
    let (version_id, base) = (mined.version_id.clone(), mined.base_version_id.clone());
    ctx.db.policy_proposal().version_id().update(PolicyProposal { status: "proposed".to_string(), promoted_at: None, ..mined });

    crate::attack_run::run_all_attacks(ctx)?;
    log::info!("Rewound policies: {} current, {} proposed, {} later version(s) removed", base, version_id, later.len());
    Ok(())
}

/// The seeded v5 proposal lowers the auto-decide threshold to 90%. Replace its
/// placeholder replay with a measured one against the labeled history.
fn replay_threshold_proposal(ctx: &ReducerContext, base_version: &str) {
    let Some(base) = ctx.db.cedar_policy_store().version().find(base_version.to_string()) else { return };
    let text = base.policy_text.replace("confidence_percent >= 95", "confidence_percent >= 90");
    let (Ok(before), Ok(after)) = (parse_policies(&base.policy_text), parse_policies(&text)) else { return };
    let labeled = all_labeled(ctx);
    let m = replay(&labeled, &before, &after);
    let reason = "auto-decides below the 95% confidence floor".to_string();
    if ctx.db.cedar_policy_store().version().find("v5".to_string()).is_none() {
        ctx.db.cedar_policy_store().insert(crate::authority::CedarPolicyStore {
            version: "v5".to_string(),
            policy_text: text,
            created_at: ctx.timestamp,
            is_active: false,
            description: "Lower the auto-decide threshold to 90%".to_string(),
        });
    }
    let old: Vec<u64> = ctx.db.policy_replay().proposed_version_id().filter(&"v5".to_string()).map(|r| r.id).collect();
    for id in old {
        ctx.db.policy_replay().id().delete(id);
    }
    ctx.db.policy_replay().insert(PolicyReplay {
        id: 0,
        proposed_version_id: "v5".to_string(),
        current_version_id: base_version.to_string(),
        status: ReplayStatus::Blocked,
        total_claims: m.cases,
        current_claim: m.cases,
        precision_before: m.precision_before(),
        precision_after: m.precision_after(),
        decisions_changed: m.resolved,
        dollar_impact_cents: m.dollar_impact_cents,
        block_reason: reason.clone(),
        created_at: ctx.timestamp,
        is_playing: false,
        speed_multiplier: 4.0,
    });
    ctx.db.policy_proposal().insert(PolicyProposal {
        version_id: "v5".to_string(),
        base_version_id: base_version.to_string(),
        origin: "threshold_change".to_string(),
        trigger_decision_id: None,
        trigger_case_id: String::new(),
        rule_ids: Vec::new(),
        status: "blocked".to_string(),
        block_reason: reason,
        history_cases: m.history_cases,
        replay_cases: m.cases,
        escalations_before: m.escalated_before,
        escalations_after: m.escalated_after,
        resolved: m.resolved,
        resolved_history: m.resolved_history,
        auto_before: m.auto_before,
        auto_after: m.auto_after,
        correct_before: m.correct_before,
        correct_after: m.correct_after,
        precision_before: m.precision_before(),
        precision_after: m.precision_after(),
        regressions: m.regressions,
        dollar_impact_cents: m.dollar_impact_cents,
        auto_credit_cents: m.auto_credit_cents,
        created_at: ctx.timestamp,
        promoted_at: None,
    });
}
