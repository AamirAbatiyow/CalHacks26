use spacetimedb::{ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp};
use std::time::Duration;

use ledger::{ledger_entry, LedgerEntry, LedgerEntryType};

pub mod approvals;
pub mod attack_run;
pub mod authority;
pub mod claim;
pub mod confidence_gate;
pub mod events;
pub mod kpis;
pub mod ledger;
pub mod ml;
pub mod policy;
pub mod settlement;
pub mod sla;

#[cfg(test)]
mod attack_tests;
#[cfg(test)]
mod authority_tests;
#[cfg(test)]
mod tests;

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PassStatus {
    Scheduled,
    Active,
    Ok,
    Dropped,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FlareClass {
    None,
    C,
    M,
    X,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecisionType {
    DisputeCreated,
    DisputeResolved,
    CreditIssued,
    PassDropped,
    PassRecovered,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecisionOutcome {
    Pending,
    Approved,
    Denied,
    AutoApproved,
    Escalated,
}

#[spacetimedb::table(accessor = station, public)]
pub struct Station {
    #[primary_key]
    pub id: String,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_m: f64,
    pub monthly_revenue_cents: i64,
}

#[spacetimedb::table(accessor = satellite, public)]
pub struct Satellite {
    #[primary_key]
    pub norad_id: u32,
    pub name: String,
    pub tle_line1: String,
    pub tle_line2: String,
    pub operator: String,
}

#[spacetimedb::table(accessor = pass, public)]
pub struct Pass {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub satellite_id: u32,
    #[index(btree)]
    pub station_id: String,
    pub start_time: Timestamp,
    pub end_time: Timestamp,
    pub status: PassStatus,
    pub max_elevation_deg: f64,
    pub revenue_cents: i64,
}

#[spacetimedb::table(accessor = space_weather, public)]
pub struct SpaceWeather {
    #[primary_key]
    pub timestamp: Timestamp,
    pub kp_index: f32,
    pub flare_class: FlareClass,
    pub dst_index: i32,
}

#[spacetimedb::table(accessor = sim_clock, public)]
pub struct SimClock {
    #[primary_key]
    pub id: u32,
    pub current_time: Timestamp,
    pub speed_multiplier: f32,
    pub is_playing: bool,
    pub real_time_anchor: Timestamp,
    pub sim_time_anchor: Timestamp,
}

/// Derived from pass, ledger, decision, dispute and escalation rows by `kpis::sync_kpis`.
#[derive(Clone, PartialEq, Debug)]
#[spacetimedb::table(accessor = kpi, public)]
pub struct Kpi {
    #[primary_key]
    pub id: String,
    pub billed_this_month_cents: i64,
    pub revenue_at_risk_cents: i64,
    pub credits_paid_cents: i64,
    pub recovered_cents: i64,
    pub leakage_avoided_cents: i64,
    pub review_cost_saved_cents: i64,
}

#[spacetimedb::table(accessor = decision_record, public)]
pub struct DecisionRecord {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub created_at: Timestamp,
    pub decision_type: DecisionType,
    pub outcome: DecisionOutcome,
    pub pass_id: Option<u64>,
    pub station_id: Option<String>,
    pub amount_cents: i64,
    pub reason: String,
    pub policy_version: String,
    pub model_version: String,
}

#[spacetimedb::table(accessor = sim_tick_schedule, scheduled(sim_tick), public)]
pub struct SimTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.sim_clock().insert(SimClock {
        id: 0,
        current_time: ctx.timestamp,
        speed_multiplier: 1.0,
        is_playing: true,
        real_time_anchor: ctx.timestamp,
        sim_time_anchor: ctx.timestamp,
    });

    kpis::sync_kpis(ctx);

    ctx.db.sim_tick_schedule().insert(SimTickSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(1000).into()),
    });

    policy::seed_initial_policies(ctx);
    
    log::info!("Ground Truth module initialized");
}

#[spacetimedb::reducer]
pub fn sim_tick(ctx: &ReducerContext, _timer: SimTickSchedule) {
    if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        if clock.is_playing {
            let elapsed_real = ctx.timestamp.duration_since(clock.real_time_anchor)
                .unwrap_or(Duration::ZERO);
            let elapsed_sim_micros = (elapsed_real.as_micros() as f64 * clock.speed_multiplier as f64) as i64;
            let new_sim_time = Timestamp::from_micros_since_unix_epoch(
                clock.sim_time_anchor.to_micros_since_unix_epoch() + elapsed_sim_micros
            );

            for pass in ctx.db.pass().iter() {
                let was_before_start = pass.start_time > clock.current_time;
                let is_after_start = pass.start_time <= new_sim_time;
                let is_before_end = new_sim_time < pass.end_time;
                
                if was_before_start && is_after_start && is_before_end {
                    if pass.status == PassStatus::Scheduled {
                        ctx.db.pass().id().update(Pass {
                            status: PassStatus::Active,
                            ..pass
                        });
                    }
                } else if pass.status == PassStatus::Active && new_sim_time >= pass.end_time {
                    ctx.db.pass().id().update(Pass {
                        status: PassStatus::Ok,
                        ..pass
                    });
                }
            }

            ctx.db.sim_clock().id().update(SimClock {
                current_time: new_sim_time,
                real_time_anchor: ctx.timestamp,
                sim_time_anchor: new_sim_time,
                ..clock
            });
        }
    }
    kpis::sync_kpis(ctx);
}

#[spacetimedb::reducer]
pub fn set_playback_speed(ctx: &ReducerContext, speed: f32) {
    if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        ctx.db.sim_clock().id().update(SimClock {
            speed_multiplier: speed.clamp(0.0, 16.0),
            real_time_anchor: ctx.timestamp,
            sim_time_anchor: clock.current_time,
            ..clock
        });
    }
}

#[spacetimedb::reducer]
pub fn set_playback_playing(ctx: &ReducerContext, playing: bool) {
    if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        ctx.db.sim_clock().id().update(SimClock {
            is_playing: playing,
            real_time_anchor: ctx.timestamp,
            sim_time_anchor: clock.current_time,
            ..clock
        });
    }
}

#[spacetimedb::reducer]
pub fn seek_to_time(ctx: &ReducerContext, timestamp_micros: i64) {
    if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        let new_time = Timestamp::from_micros_since_unix_epoch(timestamp_micros);
        ctx.db.sim_clock().id().update(SimClock {
            current_time: new_time,
            real_time_anchor: ctx.timestamp,
            sim_time_anchor: new_time,
            ..clock
        });
    }
}

#[spacetimedb::reducer]
pub fn go_live(ctx: &ReducerContext) {
    if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        ctx.db.sim_clock().id().update(SimClock {
            current_time: ctx.timestamp,
            speed_multiplier: 1.0,
            is_playing: true,
            real_time_anchor: ctx.timestamp,
            sim_time_anchor: ctx.timestamp,
            ..clock
        });
    }
}

#[spacetimedb::reducer]
pub fn seed_station(ctx: &ReducerContext, id: String, name: String, lat: f64, lon: f64, alt: f64, revenue: i64) {
    ctx.db.station().insert(Station {
        id,
        name,
        latitude: lat,
        longitude: lon,
        altitude_m: alt,
        monthly_revenue_cents: revenue,
    });
}

#[spacetimedb::reducer]
pub fn seed_satellite(ctx: &ReducerContext, norad_id: u32, name: String, tle1: String, tle2: String, operator: String) {
    ctx.db.satellite().insert(Satellite {
        norad_id,
        name,
        tle_line1: tle1,
        tle_line2: tle2,
        operator,
    });
}

#[spacetimedb::reducer]
pub fn seed_pass(ctx: &ReducerContext, sat_id: u32, station_id: String, start_micros: i64, end_micros: i64, status: u8, max_el: f64, revenue: i64) {
    let pass_status = match status {
        0 => PassStatus::Scheduled,
        1 => PassStatus::Active,
        2 => PassStatus::Ok,
        _ => PassStatus::Dropped,
    };
    ctx.db.pass().insert(Pass {
        id: 0,
        satellite_id: sat_id,
        station_id,
        start_time: Timestamp::from_micros_since_unix_epoch(start_micros),
        end_time: Timestamp::from_micros_since_unix_epoch(end_micros),
        status: pass_status,
        max_elevation_deg: max_el,
        revenue_cents: revenue,
    });
    kpis::sync_kpis(ctx);
}

/// One row of a `seed_passes` batch; fields match `seed_pass`.
#[derive(SpacetimeType, Clone, Debug)]
pub struct PassSeed {
    pub sat_id: u32,
    pub station_id: String,
    pub start_micros: i64,
    pub end_micros: i64,
    pub status: u8,
    pub max_el: f64,
    pub revenue: i64,
}

/// Bulk form of `seed_pass` for the generated pass history (tens of thousands of rows).
#[spacetimedb::reducer]
pub fn seed_passes(ctx: &ReducerContext, passes: Vec<PassSeed>) {
    for p in passes {
        ctx.db.pass().insert(Pass {
            id: 0,
            satellite_id: p.sat_id,
            station_id: p.station_id,
            start_time: Timestamp::from_micros_since_unix_epoch(p.start_micros),
            end_time: Timestamp::from_micros_since_unix_epoch(p.end_micros),
            status: match p.status {
                0 => PassStatus::Scheduled,
                1 => PassStatus::Active,
                2 => PassStatus::Ok,
                _ => PassStatus::Dropped,
            },
            max_elevation_deg: p.max_el,
            revenue_cents: p.revenue,
        });
    }
    kpis::sync_kpis(ctx);
}

#[spacetimedb::reducer]
pub fn seed_space_weather(ctx: &ReducerContext, timestamp_micros: i64, kp: f32, flare: u8, dst: i32) {
    let flare_class = match flare {
        1 => FlareClass::C,
        2 => FlareClass::M,
        3 => FlareClass::X,
        _ => FlareClass::None,
    };
    ctx.db.space_weather().insert(SpaceWeather {
        timestamp: Timestamp::from_micros_since_unix_epoch(timestamp_micros),
        kp_index: kp,
        flare_class,
        dst_index: dst,
    });
}

pub const CURRENT_POLICY_VERSION: &str = "v4";
pub const CURRENT_MODEL_VERSION: &str = "v2";

/// Seeds the audit trail and ledger against passes that already exist, so every
/// pass number on the Audit and Ledger pages points at a real `pass` row and the
/// credits-paid / recovered KPIs equal the ledger totals. Run after `seed_pass`.
#[spacetimedb::reducer]
pub fn seed_finance_history(ctx: &ReducerContext) {
    if ctx.db.ledger_entry().iter().next().is_some() {
        log::info!("Ledger already seeded, skipping finance history");
        return;
    }

    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let minute: i64 = 60 * 1_000_000;
    let mut past: Vec<Pass> = ctx
        .db
        .pass()
        .iter()
        .filter(|p| p.end_time.to_micros_since_unix_epoch() < now)
        .collect();
    past.sort_by_key(|p| p.start_time);
    let dropped: Vec<&Pass> = past.iter().filter(|p| p.status == PassStatus::Dropped).collect();
    let completed: Vec<&Pass> = past.iter().filter(|p| p.status == PassStatus::Ok).collect();

    let decide = |pass: &Pass, after_min: i64, decision_type, outcome, amount_cents: i64, reason: String| {
        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: Timestamp::from_micros_since_unix_epoch(
                pass.end_time.to_micros_since_unix_epoch() + after_min * minute,
            ),
            decision_type,
            outcome,
            pass_id: Some(pass.id),
            station_id: Some(pass.station_id.clone()),
            amount_cents,
            reason,
            policy_version: CURRENT_POLICY_VERSION.to_string(),
            model_version: CURRENT_MODEL_VERSION.to_string(),
        });
    };
    let post = |pass: Option<&Pass>, at_micros: i64, entry_type, description: String, reference: String, amount_cents: i64| {
        ctx.db.ledger_entry().insert(LedgerEntry {
            id: 0,
            created_at: Timestamp::from_micros_since_unix_epoch(at_micros),
            entry_type,
            description,
            reference_id: Some(reference),
            amount_cents,
            dispute_id: None,
            pass_id: pass.map(|p| p.id),
            station_id: pass.map(|p| p.station_id.clone()),
        });
    };
    let after = |pass: &Pass, min: i64| pass.end_time.to_micros_since_unix_epoch() + min * minute;

    // Every amount is a share of the revenue of the pass it refers to, so no
    // credit, recovery or claim can exceed what that pass was billed.
    let share = |pass: &Pass, percent: i64| pass.revenue_cents * percent / 100;

    let credits: [(Option<&&Pass>, DecisionType, DecisionOutcome, i64, &str); 6] = [
        (dropped.first(), DecisionType::CreditIssued, DecisionOutcome::Approved, 100, "Pass dropped with no downlink; full SLA credit approved after review"),
        (completed.get(3), DecisionType::DisputeResolved, DecisionOutcome::Approved, 50, "Customer dispute approved after manual review; half the pass credited"),
        (completed.get(9), DecisionType::DisputeResolved, DecisionOutcome::Approved, 20, "Partial credit for degraded link quality"),
        (completed.get(15), DecisionType::CreditIssued, DecisionOutcome::AutoApproved, 5, "Short contact under SLA minimum; auto-approved at 97% confidence"),
        (completed.get(17), DecisionType::CreditIssued, DecisionOutcome::AutoApproved, 5, "Short contact under SLA minimum; auto-approved at 97% confidence"),
        (completed.get(24), DecisionType::CreditIssued, DecisionOutcome::AutoApproved, 5, "Short contact under SLA minimum; auto-approved at 96% confidence"),
    ];
    for (pass, decision_type, outcome, percent, reason) in credits {
        if let Some(pass) = pass {
            let amount = share(pass, percent);
            decide(pass, 25, decision_type, outcome, amount, reason.to_string());
            post(Some(*pass), after(pass, 30), LedgerEntryType::Credit,
                format!("Credit issued for Pass #{}", pass.id), format!("CR-2026-{}", pass.id), -amount);
        }
    }

    if let Some(pass) = dropped.get(1) {
        let amount = share(pass, 100);
        decide(pass, 40, DecisionType::PassRecovered, DecisionOutcome::Approved, amount,
            "Backup ground station captured pass data".to_string());
        post(Some(*pass), after(pass, 45), LedgerEntryType::Recovery,
            format!("Recovered revenue from backup capture of Pass #{}", pass.id), format!("REC-2026-{}", pass.id), amount);
    }

    // Open and denied items: audit only, no money moved. The third dropped pass
    // is left unresolved and, with the open dispute, makes up revenue at risk.
    if let Some(pass) = completed.get(6) {
        decide(pass, 35, DecisionType::DisputeCreated, DecisionOutcome::Pending, share(pass, 100),
            "Customer reported incomplete data transfer".to_string());
    }
    if let Some(pass) = completed.get(12) {
        decide(pass, 50, DecisionType::CreditIssued, DecisionOutcome::Denied, share(pass, 100),
            "Full refund claimed but telemetry confirms complete downlink; denied after review".to_string());
    }

    // One invoice per station for the passes billed so far, so the ledger's
    // invoices total the "Billed this month" KPI.
    let mut billed: Vec<(String, i64)> = Vec::new();
    for pass in ctx.db.pass().iter().filter(|p| p.status != PassStatus::Scheduled) {
        match billed.iter_mut().find(|(id, _)| *id == pass.station_id) {
            Some((_, total)) => *total += pass.revenue_cents,
            None => billed.push((pass.station_id.clone(), pass.revenue_cents)),
        }
    }
    billed.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (i, (station_id, total)) in billed.into_iter().enumerate() {
        let name = ctx.db.station().id().find(&station_id).map(|s| s.name).unwrap_or_else(|| station_id.clone());
        ctx.db.ledger_entry().insert(LedgerEntry {
            id: 0,
            created_at: Timestamp::from_micros_since_unix_epoch(now - (60 + 10 * i as i64) * minute),
            entry_type: LedgerEntryType::Invoice,
            description: format!("Pass revenue invoice - {}", name),
            reference_id: Some(format!("INV-2026-{}", station_id.to_uppercase())),
            amount_cents: total,
            dispute_id: None,
            pass_id: None,
            station_id: Some(station_id),
        });
    }

    kpis::sync_kpis(ctx);
}

#[spacetimedb::reducer]
pub fn record_decision(
    ctx: &ReducerContext,
    decision_type: u8,
    outcome: u8,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    reason: String,
    policy_version: String,
    model_version: String,
) {
    let dtype = match decision_type {
        0 => DecisionType::DisputeCreated,
        1 => DecisionType::DisputeResolved,
        2 => DecisionType::CreditIssued,
        3 => DecisionType::PassDropped,
        _ => DecisionType::PassRecovered,
    };
    let doutcome = match outcome {
        0 => DecisionOutcome::Pending,
        1 => DecisionOutcome::Approved,
        2 => DecisionOutcome::Denied,
        3 => DecisionOutcome::AutoApproved,
        _ => DecisionOutcome::Escalated,
    };
    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: dtype,
        outcome: doutcome,
        pass_id,
        station_id,
        amount_cents,
        reason,
        policy_version,
        model_version,
    });
}

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(_ctx: &ReducerContext) {
    log::info!("Client connected");
}

#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(_ctx: &ReducerContext) {
    log::info!("Client disconnected");
}
