//! Event-Sourced Playback System
//!
//! This module provides an append-only event log that enables:
//! - Time-travel playback to any past state
//! - Subscription queries for UI timeline/playback bar
//! - Dispute markers on the timeline
//! - State reconstruction without separate storage
//!
//! ## Frontend Usage
//!
//! ### Subscription Query (Recommended)
//! Subscribe to the `EventLog` table to receive all events:
//! ```typescript
//! // Subscribe to all events
//! spacetimedb.subscribe("SELECT * FROM EventLog ORDER BY sim_timestamp ASC");
//! 
//! // Events are automatically pushed when new ones are added
//! EventLog.onInsert((event) => {
//!   timeline.addMarker(event);
//!   if (event.event_type === 'DisputeFiled' || event.event_type === 'DisputeResolved') {
//!     disputeMarkers.add(event);
//!   }
//! });
//! ```
//!
//! ### State Reconstruction at Time T
//! ```typescript
//! // Call the reducer to get state at a specific time
//! const micros = targetDate.getTime() * 1000;
//! spacetimedb.call("reconstruct_state_at", [micros]);
//!
//! // Or filter events client-side:
//! const eventsAtTimeT = allEvents.filter(e => e.sim_timestamp_micros <= targetMicros);
//! const state = reconstructFromEvents(eventsAtTimeT);
//! ```
//!
//! ### Playback Bar Integration
//! ```typescript
//! // Get dispute markers for timeline
//! const disputeMarkers = allEvents
//!   .filter(e => e.event_type === 'DisputeFiled')
//!   .map(e => ({
//!     time: e.sim_timestamp_micros,
//!     disputeId: e.dispute_id,
//!     type: 'dispute',
//!     amount: e.amount_cents / 100 // Convert cents to dollars
//!   }));
//!
//! // Speed control (existing): set_playback_speed(speed)
//! // Play/Pause (existing): set_playback_playing(bool)
//! // Seek (existing): seek_to_time(micros)
//! // Go Live (existing): go_live()
//! ```

use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};
use crate::sim_clock;

/// Event types for the timeline
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EventType {
    // Pass events
    PassScheduled,
    PassStarted,
    PassCompleted,
    PassDropped,
    PassRecovered,
    
    // Dispute events
    DisputeFiled,
    DisputeResolved,
    DeadlineExpired,
    
    // Financial events
    CreditIssued,
    RevenueRecorded,
    
    // System events
    WeatherAlert,
    StationStatusChange,
}

/// Append-only event log for state reconstruction and playback
/// 
/// This table is the single source of truth for timeline playback.
/// All state changes are recorded here with simulation timestamps.
#[spacetimedb::table(accessor = event_log, public)]
pub struct EventLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    
    /// Wall-clock time when event was recorded
    pub recorded_at: Timestamp,
    
    /// Simulation time when event occurred (for playback timeline)
    pub sim_timestamp: Timestamp,
    
    /// Microseconds since epoch (for easier client-side filtering)
    #[index(btree)]
    pub sim_timestamp_micros: i64,
    
    pub event_type: EventType,
    
    /// Related dispute ID (if applicable)
    pub dispute_id: Option<u64>,
    
    /// Related pass ID (if applicable)
    pub pass_id: Option<u64>,
    
    /// Related station ID (if applicable)
    pub station_id: Option<String>,
    
    /// Amount in cents (for financial events)
    /// Convert to dollars for display: amount_cents / 100.0
    pub amount_cents: i64,
    
    /// Human-readable description
    pub description: String,
    
    /// Serialized state snapshot (for complex state changes)
    pub state_snapshot: String,
}

/// State snapshot at a point in time (computed, not stored)
#[derive(SpacetimeType, Clone, Debug)]
pub struct TimelineState {
    pub timestamp_micros: i64,
    pub total_credits_cents: i64,
    pub active_disputes: u32,
    pub resolved_disputes: u32,
    pub passes_completed: u32,
    pub passes_dropped: u32,
    pub revenue_cents: i64,
}

/// Helper to record an event in the log
pub fn record_event(
    ctx: &ReducerContext,
    event_type: EventType,
    dispute_id: Option<u64>,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    description: String,
) {
    // Get current sim time
    let sim_time = if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        clock.current_time
    } else {
        ctx.timestamp
    };
    
    ctx.db.event_log().insert(EventLog {
        id: 0,
        recorded_at: ctx.timestamp,
        sim_timestamp: sim_time,
        sim_timestamp_micros: sim_time.to_micros_since_unix_epoch(),
        event_type,
        dispute_id,
        pass_id,
        station_id,
        amount_cents,
        description,
        state_snapshot: String::new(),
    });
}

/// Record an event with a state snapshot
pub fn record_event_with_snapshot(
    ctx: &ReducerContext,
    event_type: EventType,
    dispute_id: Option<u64>,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    description: String,
    state_snapshot: String,
) {
    let sim_time = if let Some(clock) = ctx.db.sim_clock().id().find(0) {
        clock.current_time
    } else {
        ctx.timestamp
    };
    
    ctx.db.event_log().insert(EventLog {
        id: 0,
        recorded_at: ctx.timestamp,
        sim_timestamp: sim_time,
        sim_timestamp_micros: sim_time.to_micros_since_unix_epoch(),
        event_type,
        dispute_id,
        pass_id,
        station_id,
        amount_cents,
        description,
        state_snapshot,
    });
}

/// Get all events in a time range (for UI timeline queries)
/// Returns events ordered by simulation timestamp
#[spacetimedb::reducer]
pub fn get_events_in_range(ctx: &ReducerContext, start_micros: i64, end_micros: i64) {
    let count = ctx.db.event_log()
        .iter()
        .filter(|e| e.sim_timestamp_micros >= start_micros && e.sim_timestamp_micros <= end_micros)
        .count();
    
    log::info!("Found {} events between {} and {}", count, start_micros, end_micros);
}

/// Get dispute markers for the timeline
#[spacetimedb::reducer]
pub fn get_dispute_markers(ctx: &ReducerContext) {
    let markers: Vec<_> = ctx.db.event_log()
        .iter()
        .filter(|e| matches!(e.event_type, EventType::DisputeFiled | EventType::DisputeResolved | EventType::DeadlineExpired))
        .collect();
    
    log::info!("Found {} dispute markers", markers.len());
    for marker in markers {
        log::info!(
            "  Dispute marker: {:?} at {} - ${:.2}",
            marker.event_type,
            marker.sim_timestamp_micros,
            marker.amount_cents as f64 / 100.0
        );
    }
}

/// Reconstruct aggregate state at a specific simulation time
/// This enables the playback bar to show state at any past time
#[spacetimedb::reducer]
pub fn reconstruct_state_at(ctx: &ReducerContext, timestamp_micros: i64) {
    let mut total_credits_cents: i64 = 0;
    let mut active_disputes: u32 = 0;
    let mut resolved_disputes: u32 = 0;
    let mut passes_completed: u32 = 0;
    let mut passes_dropped: u32 = 0;
    let mut revenue_cents: i64 = 0;
    
    for event in ctx.db.event_log().iter() {
        if event.sim_timestamp_micros > timestamp_micros {
            continue;
        }
        
        match event.event_type {
            EventType::DisputeFiled => {
                active_disputes += 1;
            }
            EventType::DisputeResolved | EventType::DeadlineExpired => {
                if active_disputes > 0 {
                    active_disputes -= 1;
                }
                resolved_disputes += 1;
            }
            EventType::CreditIssued => {
                total_credits_cents += event.amount_cents;
            }
            EventType::PassCompleted => {
                passes_completed += 1;
            }
            EventType::PassDropped => {
                passes_dropped += 1;
            }
            EventType::RevenueRecorded => {
                revenue_cents += event.amount_cents;
            }
            _ => {}
        }
    }
    
    log::info!(
        "State at {}: credits=${:.2}, active_disputes={}, resolved={}, passes_completed={}, dropped={}, revenue=${:.2}",
        timestamp_micros,
        total_credits_cents as f64 / 100.0,
        active_disputes,
        resolved_disputes,
        passes_completed,
        passes_dropped,
        revenue_cents as f64 / 100.0
    );
}

/// Get the timeline bounds (earliest and latest event times)
#[spacetimedb::reducer]
pub fn get_timeline_bounds(ctx: &ReducerContext) {
    let mut min_time: Option<i64> = None;
    let mut max_time: Option<i64> = None;
    
    for event in ctx.db.event_log().iter() {
        match min_time {
            None => min_time = Some(event.sim_timestamp_micros),
            Some(t) if event.sim_timestamp_micros < t => min_time = Some(event.sim_timestamp_micros),
            _ => {}
        }
        match max_time {
            None => max_time = Some(event.sim_timestamp_micros),
            Some(t) if event.sim_timestamp_micros > t => max_time = Some(event.sim_timestamp_micros),
            _ => {}
        }
    }
    
    log::info!(
        "Timeline bounds: start={:?}, end={:?}",
        min_time,
        max_time
    );
}

/// Record a pass event (to be called from the main sim_tick)
#[spacetimedb::reducer]
pub fn record_pass_event(
    ctx: &ReducerContext,
    pass_id: u64,
    station_id: String,
    event_type: u8,
    revenue_cents: i64,
    description: String,
) {
    let etype = match event_type {
        0 => EventType::PassScheduled,
        1 => EventType::PassStarted,
        2 => EventType::PassCompleted,
        3 => EventType::PassDropped,
        4 => EventType::PassRecovered,
        _ => EventType::PassCompleted,
    };
    
    record_event(
        ctx,
        etype,
        None,
        Some(pass_id),
        Some(station_id),
        revenue_cents,
        description,
    );
}

/// Record a weather alert event
#[spacetimedb::reducer]
pub fn record_weather_alert(
    ctx: &ReducerContext,
    station_id: String,
    alert_description: String,
) {
    record_event(
        ctx,
        EventType::WeatherAlert,
        None,
        None,
        Some(station_id),
        0,
        alert_description,
    );
}
