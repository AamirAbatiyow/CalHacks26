use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PolicyStatus {
    Proposed,
    Current,
    Retired,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReplayStatus {
    Pending,
    Running,
    Completed,
    Blocked,
}

#[spacetimedb::table(accessor = policy_version, public)]
pub struct PolicyVersion {
    #[primary_key]
    pub id: String,
    pub version: u32,
    pub status: PolicyStatus,
    pub author: String,
    pub created_at: Timestamp,
    pub decision_count: u64,
}

#[spacetimedb::table(accessor = cedar_rule, public)]
pub struct CedarRule {
    #[primary_key]
    pub id: String,
    #[index(btree)]
    pub policy_version_id: String,
    pub name: String,
    pub description: String,
    pub cedar_code: String,
    pub enabled: bool,
    pub order_index: u32,
}

#[spacetimedb::table(accessor = policy_replay, public)]
pub struct PolicyReplay {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub proposed_version_id: String,
    #[index(btree)]
    pub current_version_id: String,
    pub status: ReplayStatus,
    pub total_claims: u32,
    pub current_claim: u32,
    pub precision_before: f32,
    pub precision_after: f32,
    pub decisions_changed: u32,
    pub dollar_impact_cents: i64,
    pub block_reason: String,
    pub created_at: Timestamp,
    pub is_playing: bool,
    pub speed_multiplier: f32,
}

#[spacetimedb::reducer]
pub fn seed_policy_version(
    ctx: &ReducerContext,
    id: String,
    version: u32,
    status: u8,
    author: String,
    created_at_micros: i64,
    decision_count: u64,
) {
    let policy_status = match status {
        0 => PolicyStatus::Proposed,
        1 => PolicyStatus::Current,
        _ => PolicyStatus::Retired,
    };
    ctx.db.policy_version().insert(PolicyVersion {
        id,
        version,
        status: policy_status,
        author,
        created_at: Timestamp::from_micros_since_unix_epoch(created_at_micros),
        decision_count,
    });
}

#[spacetimedb::reducer]
pub fn seed_cedar_rule(
    ctx: &ReducerContext,
    id: String,
    policy_version_id: String,
    name: String,
    description: String,
    cedar_code: String,
    enabled: bool,
    order_index: u32,
) {
    ctx.db.cedar_rule().insert(CedarRule {
        id,
        policy_version_id,
        name,
        description,
        cedar_code,
        enabled,
        order_index,
    });
}

#[spacetimedb::reducer]
pub fn start_replay(
    ctx: &ReducerContext,
    proposed_version_id: String,
    current_version_id: String,
    total_claims: u32,
) {
    for existing in ctx.db.policy_replay().proposed_version_id().filter(&proposed_version_id) {
        ctx.db.policy_replay().id().delete(existing.id);
    }

    ctx.db.policy_replay().insert(PolicyReplay {
        id: 0,
        proposed_version_id,
        current_version_id,
        status: ReplayStatus::Running,
        total_claims,
        current_claim: 0,
        precision_before: 98.1,
        precision_after: 98.1,
        decisions_changed: 0,
        dollar_impact_cents: 0,
        block_reason: String::new(),
        created_at: ctx.timestamp,
        is_playing: true,
        speed_multiplier: 4.0,
    });
}

#[spacetimedb::reducer]
pub fn advance_replay(ctx: &ReducerContext, replay_id: u64, claims_to_advance: u32) {
    if let Some(replay) = ctx.db.policy_replay().id().find(replay_id) {
        if replay.status != ReplayStatus::Running || !replay.is_playing {
            return;
        }

        let new_claim = (replay.current_claim + claims_to_advance).min(replay.total_claims);
        let progress = new_claim as f32 / replay.total_claims as f32;
        
        let precision_after = 98.1 - (progress * 1.7);
        let decisions_changed = (progress * 37.0) as u32;
        let dollar_impact = (progress * 5420000.0) as i64;

        let (new_status, block_reason) = if new_claim >= replay.total_claims {
            if precision_after < replay.precision_before {
                (ReplayStatus::Blocked, "precision regression".to_string())
            } else {
                (ReplayStatus::Completed, String::new())
            }
        } else {
            (ReplayStatus::Running, String::new())
        };

        ctx.db.policy_replay().id().update(PolicyReplay {
            current_claim: new_claim,
            precision_after,
            decisions_changed,
            dollar_impact_cents: dollar_impact,
            is_playing: new_status == ReplayStatus::Running,
            status: new_status,
            block_reason,
            ..replay
        });
    }
}

#[spacetimedb::reducer]
pub fn set_replay_playing(ctx: &ReducerContext, replay_id: u64, playing: bool) {
    if let Some(replay) = ctx.db.policy_replay().id().find(replay_id) {
        ctx.db.policy_replay().id().update(PolicyReplay {
            is_playing: playing,
            ..replay
        });
    }
}

#[spacetimedb::reducer]
pub fn set_replay_speed(ctx: &ReducerContext, replay_id: u64, speed: f32) {
    if let Some(replay) = ctx.db.policy_replay().id().find(replay_id) {
        ctx.db.policy_replay().id().update(PolicyReplay {
            speed_multiplier: speed.clamp(1.0, 16.0),
            ..replay
        });
    }
}

#[spacetimedb::reducer]
pub fn toggle_rule(ctx: &ReducerContext, rule_id: String) {
    if let Some(rule) = ctx.db.cedar_rule().id().find(rule_id) {
        ctx.db.cedar_rule().id().update(CedarRule {
            enabled: !rule.enabled,
            ..rule
        });
    }
}

#[spacetimedb::reducer]
pub fn create_policy_version(
    ctx: &ReducerContext,
    new_id: String,
    new_version: u32,
    author: String,
    source_version_id: String,
) {
    if let Some(current) = ctx.db.policy_version().id().find(source_version_id.clone()) {
        ctx.db.policy_version().id().update(PolicyVersion {
            status: PolicyStatus::Retired,
            ..current
        });
    }

    ctx.db.policy_version().insert(PolicyVersion {
        id: new_id.clone(),
        version: new_version,
        status: PolicyStatus::Current,
        author,
        created_at: ctx.timestamp,
        decision_count: 0,
    });

    for rule in ctx.db.cedar_rule().policy_version_id().filter(&source_version_id) {
        ctx.db.cedar_rule().insert(CedarRule {
            id: format!("{}-{}", new_id, rule.order_index),
            policy_version_id: new_id.clone(),
            ..rule
        });
    }
}

#[spacetimedb::reducer]
pub fn promote_policy_version(ctx: &ReducerContext, version_id: String) {
    for replay in ctx.db.policy_replay().proposed_version_id().filter(&version_id) {
        if replay.status == ReplayStatus::Blocked {
            log::warn!("Cannot promote blocked version {}", version_id);
            return;
        }
    }

    for version in ctx.db.policy_version().iter() {
        if version.status == PolicyStatus::Current {
            ctx.db.policy_version().id().update(PolicyVersion {
                status: PolicyStatus::Retired,
                ..version
            });
        }
    }

    if let Some(version) = ctx.db.policy_version().id().find(version_id) {
        ctx.db.policy_version().id().update(PolicyVersion {
            status: PolicyStatus::Current,
            ..version
        });
    }
}

pub fn seed_initial_policies(ctx: &ReducerContext) {
    let now = ctx.timestamp.to_micros_since_unix_epoch();
    let day_micros: i64 = 24 * 60 * 60 * 1_000_000;

    ctx.db.policy_version().insert(PolicyVersion {
        id: "v5".to_string(),
        version: 5,
        status: PolicyStatus::Proposed,
        author: "AI".to_string(),
        created_at: ctx.timestamp,
        decision_count: 0,
    });

    ctx.db.policy_version().insert(PolicyVersion {
        id: "v4".to_string(),
        version: 4,
        status: PolicyStatus::Current,
        author: "Sarah Chen".to_string(),
        created_at: Timestamp::from_micros_since_unix_epoch(now - 3 * day_micros),
        decision_count: 1847,
    });

    ctx.db.policy_version().insert(PolicyVersion {
        id: "v3".to_string(),
        version: 3,
        status: PolicyStatus::Retired,
        author: "System".to_string(),
        created_at: Timestamp::from_micros_since_unix_epoch(now - 4 * day_micros),
        decision_count: 12453,
    });

    ctx.db.policy_version().insert(PolicyVersion {
        id: "v2".to_string(),
        version: 2,
        status: PolicyStatus::Retired,
        author: "James Wilson".to_string(),
        created_at: Timestamp::from_micros_since_unix_epoch(now - 4 * day_micros),
        decision_count: 8921,
    });

    ctx.db.policy_version().insert(PolicyVersion {
        id: "v1".to_string(),
        version: 1,
        status: PolicyStatus::Retired,
        author: "Initial".to_string(),
        created_at: Timestamp::from_micros_since_unix_epoch(now - 5 * day_micros),
        decision_count: 45678,
    });

    let rules = [
        ("Auto-approve under $500", "Automatically approve credits under $500 for verified customers", 
         r#"permit(
  principal,
  action == Action::"approve_credit",
  resource
) when {
  resource.amount_cents < 50000 &&
  principal.verified == true
};"#),
        ("Block high-value during storms", "Require manual review for high-value passes during geomagnetic storms",
         r#"forbid(
  principal,
  action == Action::"auto_approve",
  resource
) when {
  context.kp_index >= 7 &&
  resource.amount_cents > 100000
};"#),
        ("Escalate repeated disputes", "Escalate if customer has 3+ disputes in 30 days",
         r#"permit(
  principal,
  action == Action::"escalate",
  resource
) when {
  principal.dispute_count_30d >= 3
};"#),
        ("AI confidence threshold", "Auto-approve when AI confidence exceeds 95%",
         r#"permit(
  principal,
  action == Action::"auto_approve",
  resource
) when {
  context.ai_confidence >= 0.95
};"#),
    ];

    for version_id in ["v1", "v2", "v3", "v4", "v5"] {
        let rule_count = match version_id {
            "v1" => 1,
            "v2" => 2,
            "v3" => 3,
            "v4" | "v5" => 4,
            _ => 4,
        };

        for (i, (name, desc, code)) in rules.iter().enumerate().take(rule_count) {
            ctx.db.cedar_rule().insert(CedarRule {
                id: format!("{}-r{}", version_id, i + 1),
                policy_version_id: version_id.to_string(),
                name: name.to_string(),
                description: desc.to_string(),
                cedar_code: code.to_string(),
                enabled: true,
                order_index: i as u32,
            });
        }
    }

    ctx.db.cedar_rule().insert(CedarRule {
        id: "v5-r5".to_string(),
        policy_version_id: "v5".to_string(),
        name: "Lower AI threshold".to_string(),
        description: "Auto-approve when AI confidence exceeds 90% (proposed change)".to_string(),
        cedar_code: r#"permit(
  principal,
  action == Action::"auto_approve",
  resource
) when {
  context.ai_confidence >= 0.90
};"#.to_string(),
        enabled: true,
        order_index: 4,
    });

    ctx.db.policy_replay().insert(PolicyReplay {
        id: 0,
        proposed_version_id: "v5".to_string(),
        current_version_id: "v4".to_string(),
        status: ReplayStatus::Running,
        total_claims: 1240,
        current_claim: 812,
        precision_before: 98.1,
        precision_after: 96.4,
        decisions_changed: 37,
        dollar_impact_cents: 5420000,
        block_reason: String::new(),
        created_at: ctx.timestamp,
        is_playing: true,
        speed_multiplier: 4.0,
    });

    log::info!("Seeded initial policy versions and rules");
}
