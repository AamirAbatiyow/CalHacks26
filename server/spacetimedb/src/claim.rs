use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimGate {
    Auto,
    Approval,
    Escalated,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DataIntegrityStatus {
    Pass,
    Fail,
    Pending,
}

#[spacetimedb::table(accessor = claim, public)]
pub struct Claim {
    #[primary_key]
    pub id: String,
    pub customer_name: String,
    pub amount_claimed_cents: i64,
    pub pass_id: u64,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = claim_pass, public)]
pub struct ClaimPass {
    #[primary_key]
    pub id: u64,
    #[index(btree)]
    pub claim_id: String,
    pub station_lat: f64,
    pub station_lon: f64,
    pub station_name: String,
    pub satellite_norad_id: u32,
    pub satellite_tle1: String,
    pub satellite_tle2: String,
    pub contact_start_time: Timestamp,
    pub signal_lost_time: Timestamp,
    pub contact_end_time: Timestamp,
    pub max_elevation_deg: f64,
}

#[spacetimedb::table(accessor = claim_evidence, public)]
pub struct ClaimEvidence {
    #[primary_key]
    pub claim_id: String,
    pub data_integrity_status: DataIntegrityStatus,
    pub estimated_loss_cents: i64,
    pub missing_evidence_cents: i64,
}

#[spacetimedb::table(accessor = claim_decision, public)]
pub struct ClaimDecision {
    #[primary_key]
    pub claim_id: String,
    pub credit_amount_cents: i64,
    pub confidence_percent: i32,
    pub gate: ClaimGate,
    pub rule: String,
    pub policy_version: String,
    pub model_version: String,
    pub decided_at: Timestamp,
}

#[spacetimedb::table(accessor = claim_outcome, public)]
pub struct ClaimOutcome {
    #[primary_key]
    pub claim_id: String,
    pub credit_memo_sent: bool,
    pub ledger_posted: bool,
    pub completed_at: Option<Timestamp>,
}

#[spacetimedb::table(accessor = claim_weather, public)]
pub struct ClaimWeather {
    #[primary_key]
    pub claim_id: String,
    pub kp_index: f32,
    pub storm_active: bool,
}

#[spacetimedb::reducer]
pub fn seed_claim(
    ctx: &ReducerContext,
    id: String,
    customer_name: String,
    amount_claimed_cents: i64,
    pass_id: u64,
) {
    ctx.db.claim().insert(Claim {
        id,
        customer_name,
        amount_claimed_cents,
        pass_id,
        created_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_pass(
    ctx: &ReducerContext,
    id: u64,
    claim_id: String,
    station_lat: f64,
    station_lon: f64,
    station_name: String,
    satellite_norad_id: u32,
    satellite_tle1: String,
    satellite_tle2: String,
    contact_start_micros: i64,
    signal_lost_micros: i64,
    contact_end_micros: i64,
    max_elevation_deg: f64,
) {
    ctx.db.claim_pass().insert(ClaimPass {
        id,
        claim_id,
        station_lat,
        station_lon,
        station_name,
        satellite_norad_id,
        satellite_tle1,
        satellite_tle2,
        contact_start_time: Timestamp::from_micros_since_unix_epoch(contact_start_micros),
        signal_lost_time: Timestamp::from_micros_since_unix_epoch(signal_lost_micros),
        contact_end_time: Timestamp::from_micros_since_unix_epoch(contact_end_micros),
        max_elevation_deg,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_evidence(
    ctx: &ReducerContext,
    claim_id: String,
    data_integrity_status: u8,
    estimated_loss_cents: i64,
    missing_evidence_cents: i64,
) {
    let status = match data_integrity_status {
        0 => DataIntegrityStatus::Pass,
        1 => DataIntegrityStatus::Fail,
        _ => DataIntegrityStatus::Pending,
    };
    ctx.db.claim_evidence().insert(ClaimEvidence {
        claim_id,
        data_integrity_status: status,
        estimated_loss_cents,
        missing_evidence_cents,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_decision(
    ctx: &ReducerContext,
    claim_id: String,
    credit_amount_cents: i64,
    confidence_percent: i32,
    gate: u8,
    rule: String,
    policy_version: String,
    model_version: String,
) {
    let claim_gate = match gate {
        0 => ClaimGate::Auto,
        1 => ClaimGate::Approval,
        _ => ClaimGate::Escalated,
    };
    ctx.db.claim_decision().insert(ClaimDecision {
        claim_id,
        credit_amount_cents,
        confidence_percent,
        gate: claim_gate,
        rule,
        policy_version,
        model_version,
        decided_at: ctx.timestamp,
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_outcome(
    ctx: &ReducerContext,
    claim_id: String,
    credit_memo_sent: bool,
    ledger_posted: bool,
) {
    ctx.db.claim_outcome().insert(ClaimOutcome {
        claim_id,
        credit_memo_sent,
        ledger_posted,
        completed_at: if credit_memo_sent && ledger_posted {
            Some(ctx.timestamp)
        } else {
            None
        },
    });
}

#[spacetimedb::reducer]
pub fn seed_claim_weather(
    ctx: &ReducerContext,
    claim_id: String,
    kp_index: f32,
    storm_active: bool,
) {
    ctx.db.claim_weather().insert(ClaimWeather {
        claim_id,
        kp_index,
        storm_active,
    });
}

#[spacetimedb::reducer]
pub fn seed_demo_claim(ctx: &ReducerContext) {
    let claim_id = "CLM-10021".to_string();
    let pass_id: u64 = 10021;
    
    let now_micros = ctx.timestamp.to_micros_since_unix_epoch();
    let contact_start = now_micros - 45 * 60 * 1_000_000;
    let signal_lost = now_micros - 32 * 60 * 1_000_000;
    let contact_end = now_micros - 20 * 60 * 1_000_000;

    ctx.db.claim().insert(Claim {
        id: claim_id.clone(),
        customer_name: "Northpoint Orbital".to_string(),
        amount_claimed_cents: 1_820_000,
        pass_id,
        created_at: ctx.timestamp,
    });

    ctx.db.claim_pass().insert(ClaimPass {
        id: pass_id,
        claim_id: claim_id.clone(),
        station_lat: 78.23,
        station_lon: 15.39,
        station_name: "SvalSat".to_string(),
        satellite_norad_id: 43013,
        satellite_tle1: "1 43013U 17073A   24297.84166667  .00000162  00000+0  11961-3 0  9995".to_string(),
        satellite_tle2: "2 43013  98.7420 272.8975 0001477  93.5274 266.6059 14.19569481362839".to_string(),
        contact_start_time: Timestamp::from_micros_since_unix_epoch(contact_start),
        signal_lost_time: Timestamp::from_micros_since_unix_epoch(signal_lost),
        contact_end_time: Timestamp::from_micros_since_unix_epoch(contact_end),
        max_elevation_deg: 12.4,
    });

    ctx.db.claim_evidence().insert(ClaimEvidence {
        claim_id: claim_id.clone(),
        data_integrity_status: DataIntegrityStatus::Pass,
        estimated_loss_cents: 240_000,
        missing_evidence_cents: 158_000,
    });

    ctx.db.claim_decision().insert(ClaimDecision {
        claim_id: claim_id.clone(),
        credit_amount_cents: 115_000,
        confidence_percent: 96,
        gate: ClaimGate::Auto,
        rule: "credit_auto_limit".to_string(),
        policy_version: crate::CURRENT_POLICY_VERSION.to_string(),
        model_version: crate::CURRENT_MODEL_VERSION.to_string(),
        decided_at: ctx.timestamp,
    });

    ctx.db.claim_outcome().insert(ClaimOutcome {
        claim_id: claim_id.clone(),
        credit_memo_sent: true,
        ledger_posted: true,
        completed_at: Some(ctx.timestamp),
    });

    ctx.db.claim_weather().insert(ClaimWeather {
        claim_id,
        kp_index: 6.0,
        storm_active: true,
    });

    log::info!("Demo claim CLM-10021 seeded");
}

#[spacetimedb::reducer]
pub fn update_claim_outcome(
    ctx: &ReducerContext,
    claim_id: String,
    credit_memo_sent: bool,
    ledger_posted: bool,
) {
    if let Some(outcome) = ctx.db.claim_outcome().claim_id().find(claim_id.clone()) {
        ctx.db.claim_outcome().claim_id().update(ClaimOutcome {
            credit_memo_sent,
            ledger_posted,
            completed_at: if credit_memo_sent && ledger_posted {
                Some(ctx.timestamp)
            } else {
                None
            },
            ..outcome
        });
    }
}

#[spacetimedb::reducer]
pub fn approve_claim_decision(ctx: &ReducerContext, claim_id: String) {
    if let Some(decision) = ctx.db.claim_decision().claim_id().find(claim_id.clone()) {
        if decision.gate == ClaimGate::Approval {
            ctx.db.claim_decision().claim_id().update(ClaimDecision {
                gate: ClaimGate::Auto,
                decided_at: ctx.timestamp,
                ..decision
            });
        }
    }
}

#[spacetimedb::reducer]
pub fn escalate_claim_decision(ctx: &ReducerContext, claim_id: String, reason: String) {
    if let Some(decision) = ctx.db.claim_decision().claim_id().find(claim_id.clone()) {
        ctx.db.claim_decision().claim_id().update(ClaimDecision {
            gate: ClaimGate::Escalated,
            decided_at: ctx.timestamp,
            ..decision
        });
        log::info!("Claim {} escalated: {}", claim_id, reason);
    }
}
