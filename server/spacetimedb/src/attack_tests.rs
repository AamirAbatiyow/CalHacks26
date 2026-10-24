//! Break It: every catalog attack is replayed against the seed fixtures the
//! module is actually seeded with, through the same planning and detection code.

use crate::attack_run::*;
use spacetimedb::Identity;

const NOW: i64 = 1_800_000_000_000_000;
const MINUTE: i64 = 60_000_000;
const HOUR: i64 = 60 * MINUTE;

fn seeded_passes() -> Vec<PassFacts> {
    let raw: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../fixtures/passes.json")).unwrap();
    raw.iter()
        .enumerate()
        .map(|(i, p)| {
            let start = NOW + p["start_offset_minutes"].as_i64().unwrap() * MINUTE;
            PassFacts {
                id: i as u64 + 1,
                satellite_id: p["satellite_id"].as_u64().unwrap() as u32,
                station_id: p["station_id"].as_str().unwrap().to_string(),
                start_micros: start,
                end_micros: start + p["duration_minutes"].as_i64().unwrap() * MINUTE,
                revenue_cents: p["revenue_cents"].as_i64().unwrap(),
            }
        })
        .collect()
}

fn seeded_weather() -> Vec<WeatherFacts> {
    let raw: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../fixtures/space_weather.json")).unwrap();
    raw.iter()
        .map(|w| WeatherFacts {
            at_micros: NOW + w["offset_minutes"].as_i64().unwrap() * MINUTE,
            kp_index: w["kp_index"].as_f64().unwrap() as f32,
            has_flare: w["flare_class"].as_u64().unwrap() != 0,
        })
        .collect()
}

fn attacker() -> Identity {
    Identity::from_byte_array([7; 32])
}

/// Flags the module would raise for a catalog claim attack on freshly seeded data.
fn replay(spec: &FixtureSpec, passes: &[PassFacts], weather: &[WeatherFacts]) -> Vec<Flag> {
    let plan = plan_claim(spec.amount_cents, spec.params, passes).unwrap();
    let (prior, filed_micros) = plan_filing(&plan, attacker(), sibling_identity(attacker(), 0xD0D0), NOW);
    let priors: Vec<PriorClaim> = prior.into_iter().collect();
    assess_claim(
        &ClaimInput {
            owner: attacker(),
            pass_id: plan.pass_id,
            station_id: &plan.station_id,
            amount_cents: plan.amount_cents,
            reason: plan.reason,
            filed_micros,
        },
        passes.iter().find(|p| p.id == plan.pass_id),
        weather,
        &priors,
    )
}

fn claim_specs() -> impl Iterator<Item = &'static FixtureSpec> {
    CATALOG.iter().filter(|s| s.attack_type != AttackType::InsiderRaisesOwnLimit)
}

#[test]
fn every_claim_attack_uses_a_real_seeded_pass_and_station() {
    let passes = seeded_passes();
    let stations: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../fixtures/stations.json")).unwrap();
    let station_ids: Vec<&str> = stations.iter().map(|s| s["id"].as_str().unwrap()).collect();
    for spec in claim_specs() {
        let plan = plan_claim(spec.amount_cents, spec.params, &passes)
            .unwrap_or_else(|e| panic!("{}: {}", spec.description, e));
        assert!(station_ids.contains(&plan.station_id.as_str()), "{}: unknown station {}", spec.description, plan.station_id);
        assert!(plan.amount_cents > 0, "{}: no claim amount", spec.description);
        if !spec.params.contains("pass=missing") {
            assert!(passes.iter().any(|p| p.id == plan.pass_id), "{}", spec.description);
        }
    }
}

#[test]
fn only_the_targeted_check_can_fire() {
    let passes = seeded_passes();
    let weather = seeded_weather();
    for spec in claim_specs() {
        let targets = targeted_checks(spec.attack_type);
        for flag in replay(spec, &passes, &weather) {
            assert!(
                targets.contains(&flag.check),
                "{}: off-target {:?} ({})",
                spec.description,
                flag.check,
                flag.detail
            );
        }
    }
}

#[test]
fn catalog_has_hard_cases_the_detector_misses() {
    let passes = seeded_passes();
    let weather = seeded_weather();
    let mut caught = 0;
    let mut missed = Vec::new();
    for spec in claim_specs() {
        if replay(spec, &passes, &weather).is_empty() {
            missed.push(spec.description);
        } else {
            caught += 1;
        }
    }
    assert!(caught > 0);
    assert!(!missed.is_empty(), "every claim attack was caught; the catalog has no hard cases");
}

fn claim<'a>(pass: &'a PassFacts, amount_cents: i64, reason: &'a str, filed_micros: i64) -> ClaimInput<'a> {
    ClaimInput {
        owner: attacker(),
        pass_id: pass.id,
        station_id: &pass.station_id,
        amount_cents,
        reason,
        filed_micros,
    }
}

#[test]
fn pass_multiple_is_exclusive() {
    let passes = seeded_passes();
    let pass = passes.iter().find(|p| p.revenue_cents == 260_000).unwrap();
    assert!(assess_claim(&claim(pass, 780_000, "Dropped", NOW), Some(pass), &[], &[]).is_empty());
    let flags = assess_claim(&claim(pass, 780_001, "Dropped", NOW), Some(pass), &[], &[]);
    assert_eq!(flags.len(), 1);
    assert_eq!(flags[0].check, Check::Inflated);
}

#[test]
fn duplicate_window_is_24_hours_and_per_owner() {
    let passes = seeded_passes();
    let pass = &passes[0];
    let prior = |owner, filed_micros| PriorClaim { owner, pass_id: pass.id, filed_micros };
    let dup = |priors: &[PriorClaim], filed| {
        assess_claim(&claim(pass, pass.revenue_cents, "Dropped", filed), Some(pass), &[], priors)
            .iter()
            .any(|f| f.check == Check::Duplicate)
    };
    assert!(dup(&[prior(attacker(), NOW)], NOW + 23 * HOUR));
    assert!(!dup(&[prior(attacker(), NOW)], NOW + 24 * HOUR));
    assert!(!dup(&[prior(sibling_identity(attacker(), 1), NOW)], NOW));
}

#[test]
fn weather_excuse_is_matched_to_the_pass_window() {
    let passes = seeded_passes();
    let weather = seeded_weather();
    let excuse = |sat: u32, station: &str| {
        let pass = passes.iter().find(|p| p.satellite_id == sat && p.station_id == station).unwrap();
        assess_claim(&claim(pass, pass.revenue_cents, "Solar flare outage", NOW), Some(pass), &weather, &[])
            .iter()
            .any(|f| f.check == Check::WeatherExcuse)
    };
    assert!(excuse(46984, "aws-ohio"), "calm-weather pass should be flagged");
    assert!(!excuse(36508, "svalsat"), "pass during the Kp 6 storm is supported");
}

#[test]
fn dollar_amounts_are_grouped() {
    assert_eq!(dollars(995_000), "$9,950.00");
    assert_eq!(dollars(10_000_000), "$100,000.00");
    assert_eq!(dollars(5), "$0.05");
    assert_eq!(dollars(-123_456), "-$1,234.56");
}

#[test]
fn only_admins_may_raise_their_own_limit() {
    assert!(!may_raise_own_limit(UserRole::Customer));
    assert!(!may_raise_own_limit(UserRole::Operator));
    assert!(may_raise_own_limit(UserRole::Admin));
}
