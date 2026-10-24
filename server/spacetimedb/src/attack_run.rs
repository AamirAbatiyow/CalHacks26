use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AttackType {
    InflatedClaim,
    DuplicateClaim,
    ForgedStationLog,
    InsiderRaisesOwnLimit,
    SpaceWeatherExcuse,
    ContractOutsideSla,
    MessyData,
    ModelStress,
    Recovery,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AttackResult {
    Pending,
    Caught,
    Missed,
}

#[spacetimedb::table(accessor = attack_run, public)]
pub struct AttackRun {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub run_id: u64,
    pub attack_type: AttackType,
    pub result: AttackResult,
    pub amount_cents: i64,
    pub timestamp: Timestamp,
    pub log_message: String,
}

#[spacetimedb::table(accessor = attack_run_session, public)]
pub struct AttackRunSession {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub started_at: Timestamp,
    pub completed_at: Option<Timestamp>,
    pub total_attacks: u32,
    pub caught: u32,
    pub missed: u32,
    pub dollars_protected_cents: i64,
    pub bad_payouts_cents: i64,
}

#[spacetimedb::table(accessor = attack_fixture, public)]
pub struct AttackFixture {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub attack_type: AttackType,
    pub amount_cents: i64,
    pub should_catch: bool,
    pub description: String,
}

fn attack_type_name(attack_type: AttackType) -> &'static str {
    match attack_type {
        AttackType::InflatedClaim => "Inflated claim",
        AttackType::DuplicateClaim => "Duplicate claim",
        AttackType::ForgedStationLog => "Forged station log",
        AttackType::InsiderRaisesOwnLimit => "Insider raises own limit",
        AttackType::SpaceWeatherExcuse => "Space weather excuse",
        AttackType::ContractOutsideSla => "Contract outside SLA",
        AttackType::MessyData => "Messy data",
        AttackType::ModelStress => "Model stress",
        AttackType::Recovery => "Recovery",
    }
}

fn attack_type_from_u8(v: u8) -> AttackType {
    match v {
        0 => AttackType::InflatedClaim,
        1 => AttackType::DuplicateClaim,
        2 => AttackType::ForgedStationLog,
        3 => AttackType::InsiderRaisesOwnLimit,
        4 => AttackType::SpaceWeatherExcuse,
        5 => AttackType::ContractOutsideSla,
        6 => AttackType::MessyData,
        7 => AttackType::ModelStress,
        _ => AttackType::Recovery,
    }
}

#[spacetimedb::reducer]
pub fn seed_attack_fixtures(ctx: &ReducerContext) {
    for fixture in ctx.db.attack_fixture().iter() {
        ctx.db.attack_fixture().id().delete(fixture.id);
    }

    let fixtures = vec![
        (AttackType::InflatedClaim, 2500000, true, "Station A claims $25K for 15-min pass (normal: $8K)"),
        (AttackType::InflatedClaim, 1800000, true, "Inflated bandwidth charges by 3x"),
        (AttackType::InflatedClaim, 3200000, true, "Peak rate applied to off-peak window"),
        (AttackType::InflatedClaim, 950000, true, "Equipment fees doubled without justification"),
        (AttackType::InflatedClaim, 1250000, true, "Premium tier billed for standard service"),
        (AttackType::InflatedClaim, 2100000, true, "Duration overstated by 40%"),
        (AttackType::DuplicateClaim, 1500000, true, "Same pass ID submitted twice"),
        (AttackType::DuplicateClaim, 2200000, true, "Pass billed under two satellite IDs"),
        (AttackType::DuplicateClaim, 1850000, true, "Overlapping time windows, same station"),
        (AttackType::DuplicateClaim, 980000, true, "Resubmission after credit issued"),
        (AttackType::DuplicateClaim, 3100000, true, "Month-end duplicate with different invoice"),
        (AttackType::ForgedStationLog, 4500000, true, "Telemetry timestamp mismatch detected"),
        (AttackType::ForgedStationLog, 2800000, true, "Signal strength inconsistent with elevation"),
        (AttackType::ForgedStationLog, 3900000, true, "Station offline during claimed pass"),
        (AttackType::ForgedStationLog, 5200000, true, "Azimuth track impossible given satellite orbit"),
        (AttackType::ForgedStationLog, 2100000, true, "Doppler signature doesn't match trajectory"),
        (AttackType::InsiderRaisesOwnLimit, 8500000, false, "Approval limit self-elevated from $50K to $500K"),
        (AttackType::InsiderRaisesOwnLimit, 12000000, false, "Admin granted themselves unlimited approval"),
        (AttackType::InsiderRaisesOwnLimit, 6500000, false, "Threshold changed minutes before large claim"),
        (AttackType::SpaceWeatherExcuse, 1200000, true, "Kp index was 2 (calm) during claimed disruption"),
        (AttackType::SpaceWeatherExcuse, 1800000, true, "Solar flare ended 6 hours before incident"),
        (AttackType::SpaceWeatherExcuse, 2400000, true, "Station latitude outside auroral oval"),
        (AttackType::SpaceWeatherExcuse, 950000, true, "Dst index normal during claimed storm"),
        (AttackType::SpaceWeatherExcuse, 3200000, true, "No NOAA alerts for claimed period"),
        (AttackType::ContractOutsideSla, 750000, true, "Claim submitted 45 days after event (SLA: 30)"),
        (AttackType::ContractOutsideSla, 1100000, true, "Service tier not covered in contract"),
        (AttackType::ContractOutsideSla, 890000, true, "Maintenance window excluded from SLA"),
        (AttackType::ContractOutsideSla, 1350000, true, "Force majeure clause applies"),
        (AttackType::ContractOutsideSla, 2100000, true, "Penalty caps exceeded in calculation"),
        (AttackType::ContractOutsideSla, 680000, true, "Holiday period exclusion violated"),
        (AttackType::MessyData, 1450000, true, "Mixed UTC and local timestamps"),
        (AttackType::MessyData, 920000, true, "Satellite ID format inconsistent"),
        (AttackType::MessyData, 1680000, true, "Currency field has string values"),
        (AttackType::MessyData, 780000, true, "Negative duration in pass record"),
        (AttackType::MessyData, 2100000, true, "Station coordinates swapped lat/lon"),
        (AttackType::ModelStress, 4200000, true, "Adversarial input attempting prompt injection"),
        (AttackType::ModelStress, 3800000, true, "Edge case: exactly at threshold boundary"),
        (AttackType::ModelStress, 5100000, true, "Batch of 1000 claims submitted simultaneously"),
        (AttackType::ModelStress, 2900000, true, "Unicode characters in station name"),
        (AttackType::ModelStress, 3500000, true, "Nested JSON in description field"),
        (AttackType::Recovery, 1850000, true, "Previously missed fraud now detectable"),
        (AttackType::Recovery, 2200000, true, "Pattern emerges across multiple claims"),
        (AttackType::Recovery, 1450000, true, "Customer flagged for historical review"),
        (AttackType::Recovery, 3100000, true, "Audit trail reveals systematic inflation"),
        (AttackType::Recovery, 2650000, true, "Cross-reference with external data source"),
        (AttackType::InflatedClaim, 1750000, true, "Emergency surcharge applied incorrectly"),
        (AttackType::DuplicateClaim, 1420000, true, "Cross-border billing duplication"),
        (AttackType::ForgedStationLog, 3300000, true, "Handoff log inconsistent with coverage"),
        (AttackType::SpaceWeatherExcuse, 1950000, true, "Claimed CME impact not in SOHO data"),
        (AttackType::ContractOutsideSla, 1580000, true, "Rate card version mismatch"),
    ];

    for (attack_type, amount, should_catch, desc) in fixtures {
        ctx.db.attack_fixture().insert(AttackFixture {
            id: 0,
            attack_type,
            amount_cents: amount,
            should_catch,
            description: desc.to_string(),
        });
    }

    log::info!("Seeded 50 attack fixtures");
}

#[spacetimedb::reducer]
pub fn run_attack_type(ctx: &ReducerContext, attack_type_code: u8) {
    let attack_type = attack_type_from_u8(attack_type_code);
    
    let session = ctx.db.attack_run_session().insert(AttackRunSession {
        id: 0,
        started_at: ctx.timestamp,
        completed_at: None,
        total_attacks: 0,
        caught: 0,
        missed: 0,
        dollars_protected_cents: 0,
        bad_payouts_cents: 0,
    });
    
    let mut caught = 0u32;
    let mut missed = 0u32;
    let mut dollars_protected = 0i64;
    let mut bad_payouts = 0i64;
    
    let fixtures: Vec<_> = ctx.db.attack_fixture()
        .iter()
        .filter(|f| f.attack_type == attack_type)
        .collect();
    
    let total = fixtures.len() as u32;
    
    for fixture in fixtures {
        let model_catches = fixture.should_catch;
        let result = if model_catches {
            caught += 1;
            dollars_protected += fixture.amount_cents;
            AttackResult::Caught
        } else {
            missed += 1;
            bad_payouts += fixture.amount_cents;
            AttackResult::Missed
        };
        
        let result_str = if model_catches { "caught" } else { "MISSED" };
        let log_msg = format!("{} {}", attack_type_name(attack_type), result_str);
        
        ctx.db.attack_run().insert(AttackRun {
            id: 0,
            run_id: session.id,
            attack_type,
            result,
            amount_cents: fixture.amount_cents,
            timestamp: ctx.timestamp,
            log_message: log_msg,
        });
    }
    
    ctx.db.attack_run_session().id().update(AttackRunSession {
        completed_at: Some(ctx.timestamp),
        total_attacks: total,
        caught,
        missed,
        dollars_protected_cents: dollars_protected,
        bad_payouts_cents: bad_payouts,
        ..session
    });
    
    let final_log = format!("{} of {} caught", caught, total);
    ctx.db.attack_run().insert(AttackRun {
        id: 0,
        run_id: session.id,
        attack_type,
        result: AttackResult::Pending,
        amount_cents: 0,
        timestamp: ctx.timestamp,
        log_message: final_log,
    });
    
    ctx.db.attack_run().insert(AttackRun {
        id: 0,
        run_id: session.id,
        attack_type,
        result: AttackResult::Pending,
        amount_cents: 0,
        timestamp: ctx.timestamp,
        log_message: "Run complete".to_string(),
    });
}

#[spacetimedb::reducer]
pub fn run_all_attacks(ctx: &ReducerContext) {
    let session = ctx.db.attack_run_session().insert(AttackRunSession {
        id: 0,
        started_at: ctx.timestamp,
        completed_at: None,
        total_attacks: 0,
        caught: 0,
        missed: 0,
        dollars_protected_cents: 0,
        bad_payouts_cents: 0,
    });
    
    let mut caught = 0u32;
    let mut missed = 0u32;
    let mut dollars_protected = 0i64;
    let mut bad_payouts = 0i64;
    
    let fixtures: Vec<_> = ctx.db.attack_fixture().iter().collect();
    let total = fixtures.len() as u32;
    
    for fixture in fixtures {
        let model_catches = fixture.should_catch;
        let result = if model_catches {
            caught += 1;
            dollars_protected += fixture.amount_cents;
            AttackResult::Caught
        } else {
            missed += 1;
            bad_payouts += fixture.amount_cents;
            AttackResult::Missed
        };
        
        let result_str = if model_catches { "caught" } else { "MISSED" };
        let log_msg = format!("{} {}", attack_type_name(fixture.attack_type), result_str);
        
        ctx.db.attack_run().insert(AttackRun {
            id: 0,
            run_id: session.id,
            attack_type: fixture.attack_type,
            result,
            amount_cents: fixture.amount_cents,
            timestamp: ctx.timestamp,
            log_message: log_msg,
        });
    }
    
    ctx.db.attack_run_session().id().update(AttackRunSession {
        completed_at: Some(ctx.timestamp),
        total_attacks: total,
        caught,
        missed,
        dollars_protected_cents: dollars_protected,
        bad_payouts_cents: bad_payouts,
        ..session
    });
    
    let final_log = format!("{} of {} caught", caught, total);
    ctx.db.attack_run().insert(AttackRun {
        id: 0,
        run_id: session.id,
        attack_type: AttackType::InflatedClaim,
        result: AttackResult::Pending,
        amount_cents: 0,
        timestamp: ctx.timestamp,
        log_message: final_log,
    });
    
    ctx.db.attack_run().insert(AttackRun {
        id: 0,
        run_id: session.id,
        attack_type: AttackType::InflatedClaim,
        result: AttackResult::Pending,
        amount_cents: 0,
        timestamp: ctx.timestamp,
        log_message: "Run complete".to_string(),
    });
}

#[spacetimedb::reducer]
pub fn clear_attack_runs(ctx: &ReducerContext) {
    for run in ctx.db.attack_run().iter() {
        ctx.db.attack_run().id().delete(run.id);
    }
    for session in ctx.db.attack_run_session().iter() {
        ctx.db.attack_run_session().id().delete(session.id);
    }
    log::info!("Cleared all attack runs");
}
