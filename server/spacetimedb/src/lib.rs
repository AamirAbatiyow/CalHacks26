use spacetimedb::{ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp};
use std::time::Duration;

use ledger::{ledger_entry, LedgerEntry, LedgerEntryType};

pub mod approvals;
pub mod attack_run;
pub mod authority;
pub mod claim;
pub mod confidence_gate;
pub mod events;
pub mod ledger;
pub mod policy;
pub mod sla;

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

#[spacetimedb::table(accessor = kpi, public)]
pub struct Kpi {
    #[primary_key]
    pub id: String,
    pub billed_this_month_cents: i64,
    pub revenue_at_risk_cents: i64,
    pub credits_paid_cents: i64,
    pub recovered_cents: i64,
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

    ctx.db.kpi().insert(Kpi {
        id: "main".to_string(),
        billed_this_month_cents: 1940000000,
        revenue_at_risk_cents: 41200000,
        credits_paid_cents: 8600000,
        recovered_cents: 13100000,
    });

    ctx.db.sim_tick_schedule().insert(SimTickSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(1000).into()),
    });

    let base_time = ctx.timestamp.to_micros_since_unix_epoch();
    
    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 3600_000_000),
        decision_type: DecisionType::CreditIssued,
        outcome: DecisionOutcome::AutoApproved,
        pass_id: Some(1042),
        station_id: Some("svalsat".to_string()),
        amount_cents: 245000,
        reason: "Pass dropped due to solar interference".to_string(),
        policy_version: "v4".to_string(),
        model_version: "v2".to_string(),
    });

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 7200_000_000),
        decision_type: DecisionType::DisputeResolved,
        outcome: DecisionOutcome::Approved,
        pass_id: Some(1038),
        station_id: Some("trollsat".to_string()),
        amount_cents: 18500,
        reason: "Customer dispute approved after manual review".to_string(),
        policy_version: "v4".to_string(),
        model_version: "v2".to_string(),
    });

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 14400_000_000),
        decision_type: DecisionType::DisputeCreated,
        outcome: DecisionOutcome::Pending,
        pass_id: Some(1055),
        station_id: Some("svalsat".to_string()),
        amount_cents: 32000,
        reason: "Customer reported incomplete data transfer".to_string(),
        policy_version: "v4".to_string(),
        model_version: "v2".to_string(),
    });

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 21600_000_000),
        decision_type: DecisionType::PassRecovered,
        outcome: DecisionOutcome::AutoApproved,
        pass_id: Some(1029),
        station_id: Some("trollsat".to_string()),
        amount_cents: 89000,
        reason: "Backup ground station captured pass data".to_string(),
        policy_version: "v3".to_string(),
        model_version: "v2".to_string(),
    });

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 43200_000_000),
        decision_type: DecisionType::CreditIssued,
        outcome: DecisionOutcome::Denied,
        pass_id: Some(1015),
        station_id: Some("svalsat".to_string()),
        amount_cents: 156000,
        reason: "Claim exceeds policy threshold, escalated".to_string(),
        policy_version: "v3".to_string(),
        model_version: "v2".to_string(),
    });

    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 1800_000_000),
        entry_type: LedgerEntryType::Credit,
        description: "Credit issued for Pass #1042 - solar interference".to_string(),
        reference_id: Some("CR-2026-1042".to_string()),
        amount_cents: -245000,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });

    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 5400_000_000),
        entry_type: LedgerEntryType::Invoice,
        description: "Monthly service invoice - SvalSat".to_string(),
        reference_id: Some("INV-2026-SVB-10".to_string()),
        amount_cents: 4850000,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });

    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 10800_000_000),
        entry_type: LedgerEntryType::Recovery,
        description: "Recovered revenue from backup pass capture".to_string(),
        reference_id: Some("REC-2026-1029".to_string()),
        amount_cents: 89000,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });

    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 18000_000_000),
        entry_type: LedgerEntryType::Credit,
        description: "Credit issued for Pass #1038 - dispute resolution".to_string(),
        reference_id: Some("CR-2026-1038".to_string()),
        amount_cents: -18500,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });

    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 86400_000_000),
        entry_type: LedgerEntryType::Invoice,
        description: "Monthly service invoice - TrollSat".to_string(),
        reference_id: Some("INV-2026-ANT-10".to_string()),
        amount_cents: 3200000,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });

    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(base_time - 172800_000_000),
        entry_type: LedgerEntryType::Recovery,
        description: "Insurance recovery for storm damage claim".to_string(),
        reference_id: Some("REC-2026-INS-07".to_string()),
        amount_cents: 425000,
        dispute_id: None,
        pass_id: None,
        station_id: None,
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

#[spacetimedb::reducer]
pub fn update_kpi(ctx: &ReducerContext, billed: i64, at_risk: i64, credits: i64, recovered: i64) {
    if let Some(kpi) = ctx.db.kpi().id().find("main".to_string()) {
        ctx.db.kpi().id().update(Kpi {
            billed_this_month_cents: billed,
            revenue_at_risk_cents: at_risk,
            credits_paid_cents: credits,
            recovered_cents: recovered,
            ..kpi
        });
    }
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
