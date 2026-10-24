//! Authority module for Ground Truth - AWS Cedar policy enforcement in SpacetimeDB.
//!
//! This module provides:
//! - Versioned Cedar policy storage
//! - Actor identity management (AI analyst vs human approvers)
//! - Policy evaluation for all authorization decisions

use cedar_policy::{
    Authorizer, Context, Decision, Entities, EntityId, EntityTypeName, EntityUid, PolicySet,
    Request,
};
use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};
use std::str::FromStr;

/// Actor types in the system
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ActorType {
    /// AI billing analyst with limited authority
    AiAnalyst,
    /// Human approver with elevated authority
    HumanApprover,
    /// System administrator with full authority
    SystemAdmin,
}

/// Authorization decision from Cedar evaluation
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuthzDecision {
    Allow,
    Deny,
}

/// Stores versioned Cedar policies
#[spacetimedb::table(accessor = cedar_policy_store, public)]
pub struct CedarPolicyStore {
    #[primary_key]
    pub version: String,
    pub policy_text: String,
    pub created_at: Timestamp,
    pub is_active: bool,
    pub description: String,
}

/// Actor identities in the system
#[spacetimedb::table(accessor = actor_identity, public)]
pub struct ActorIdentity {
    #[primary_key]
    pub identity_id: String,
    pub actor_type: ActorType,
    pub display_name: String,
    pub can_edit_policies: bool,
    pub can_escalate: bool,
    pub created_at: Timestamp,
    pub is_active: bool,
}

/// Permission caps for actor types
#[spacetimedb::table(accessor = actor_permission_cap, public)]
pub struct ActorPermissionCap {
    #[primary_key]
    pub actor_type_id: u8,
    pub can_edit_policies: bool,
    pub can_approve_escalations: bool,
}

/// Authorization log for audit trail
#[spacetimedb::table(accessor = authorization_log, public)]
pub struct AuthorizationLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub timestamp: Timestamp,
    pub actor_id: String,
    pub action: String,
    pub resource: String,
    pub decision: AuthzDecision,
    pub policy_version: String,
    pub reason: String,
}

const DEFAULT_CEDAR_POLICY: &str = r#"
// Ground Truth Cedar Policy v4
// Defines authorization rules for the AI billing analyst system

// AI Analyst permissions - automatic decisions are gated on confidence only
@id("auto-decide-95")
permit(
    principal == GroundTruth::Actor::"ai_analyst",
    action == GroundTruth::Action::"auto_approve",
    resource
) when {
    context.confidence_percent >= 95
};

permit(
    principal == GroundTruth::Actor::"ai_analyst",
    action == GroundTruth::Action::"recommend_approval",
    resource
);

permit(
    principal == GroundTruth::Actor::"ai_analyst",
    action == GroundTruth::Action::"escalate",
    resource
);

permit(
    principal == GroundTruth::Actor::"ai_analyst",
    action == GroundTruth::Action::"view_claim",
    resource
);

// AI Analyst forbidden from editing policies
forbid(
    principal == GroundTruth::Actor::"ai_analyst",
    action == GroundTruth::Action::"edit_policy",
    resource
);

// Human Approver permissions - elevated authority
permit(
    principal == GroundTruth::Actor::"human_approver",
    action in [
        GroundTruth::Action::"approve",
        GroundTruth::Action::"deny",
        GroundTruth::Action::"escalate",
        GroundTruth::Action::"view_claim",
        GroundTruth::Action::"approve_escalation"
    ],
    resource
);

// Human Approver cannot edit policies
forbid(
    principal == GroundTruth::Actor::"human_approver",
    action == GroundTruth::Action::"edit_policy",
    resource
);

// System Admin permissions - full authority
permit(
    principal == GroundTruth::Actor::"system_admin",
    action,
    resource
);
"#;

const CEDAR_SCHEMA: &str = r#"
namespace GroundTruth {
    entity Actor;
    entity Claim {
        amount_cents: Long,
    };
    entity Policy;
    
    action auto_approve appliesTo {
        principal: Actor,
        resource: Claim,
        context: {
            confidence_percent: Long,
        }
    };
    action recommend_approval appliesTo {
        principal: Actor,
        resource: Claim,
    };
    action approve appliesTo {
        principal: Actor,
        resource: Claim,
    };
    action deny appliesTo {
        principal: Actor,
        resource: Claim,
    };
    action escalate appliesTo {
        principal: Actor,
        resource: Claim,
    };
    action approve_escalation appliesTo {
        principal: Actor,
        resource: Claim,
    };
    action view_claim appliesTo {
        principal: Actor,
        resource: Claim,
    };
    action edit_policy appliesTo {
        principal: Actor,
        resource: Policy,
    };
}
"#;

/// Result of authorization check
pub struct AuthzResult {
    pub decision: AuthzDecision,
    pub policy_version: String,
    pub reason: String,
}

/// Evaluates a Cedar policy authorization request.
/// Returns AuthzResult with decision, policy version, and reason.
pub fn evaluate_authorization(
    policy_text: &str,
    policy_version: &str,
    actor_id: &str,
    action: &str,
    resource_type: &str,
    resource_id: &str,
    amount_cents: i64,
    confidence_percent: i64,
) -> AuthzResult {
    let authorizer = Authorizer::new();

    let policy_set = match PolicySet::from_str(policy_text) {
        Ok(ps) => ps,
        Err(e) => {
            return AuthzResult {
                decision: AuthzDecision::Deny,
                policy_version: policy_version.to_string(),
                reason: format!("Policy parse error: {}", e),
            };
        }
    };

    let principal = EntityUid::from_type_name_and_id(
        EntityTypeName::from_str("GroundTruth::Actor").unwrap(),
        EntityId::from_str(actor_id).unwrap(),
    );

    let action_uid = EntityUid::from_type_name_and_id(
        EntityTypeName::from_str("GroundTruth::Action").unwrap(),
        EntityId::from_str(action).unwrap(),
    );

    let resource = EntityUid::from_type_name_and_id(
        EntityTypeName::from_str(&format!("GroundTruth::{}", resource_type)).unwrap(),
        EntityId::from_str(resource_id).unwrap(),
    );

    let context_json = format!(
        r#"{{"confidence_percent": {}, "amount_cents": {}}}"#,
        confidence_percent, amount_cents
    );
    let context = match Context::from_json_str(&context_json, None) {
        Ok(c) => c,
        Err(e) => {
            return AuthzResult {
                decision: AuthzDecision::Deny,
                policy_version: policy_version.to_string(),
                reason: format!("Invalid context: {}", e),
            };
        }
    };

    let entities_json = format!(
        r#"[
            {{"uid": {{"type": "GroundTruth::Actor", "id": "{}"}}, "attrs": {{}}, "parents": []}},
            {{"uid": {{"type": "GroundTruth::{}", "id": "{}"}}, "attrs": {{"amount_cents": {}}}, "parents": []}}
        ]"#,
        actor_id, resource_type, resource_id, amount_cents
    );
    let entities = match Entities::from_json_str(&entities_json, None) {
        Ok(e) => e,
        Err(e) => {
            return AuthzResult {
                decision: AuthzDecision::Deny,
                policy_version: policy_version.to_string(),
                reason: format!("Invalid entities: {}", e),
            };
        }
    };

    let request = match Request::new(principal, action_uid, resource, context, None) {
        Ok(r) => r,
        Err(e) => {
            return AuthzResult {
                decision: AuthzDecision::Deny,
                policy_version: policy_version.to_string(),
                reason: format!("Invalid request: {}", e),
            };
        }
    };

    let response = authorizer.is_authorized(&request, &policy_set, &entities);

    let decision = match response.decision() {
        Decision::Allow => AuthzDecision::Allow,
        Decision::Deny => AuthzDecision::Deny,
    };

    let reason = if decision == AuthzDecision::Allow {
        "Authorized by policy".to_string()
    } else {
        let diagnostics = response.diagnostics();
        let errors: Vec<String> = diagnostics.errors().map(|e| e.to_string()).collect();
        if errors.is_empty() {
            "Denied by policy - no matching permit rule".to_string()
        } else {
            format!("Denied: {}", errors.join("; "))
        }
    };

    AuthzResult {
        decision,
        policy_version: policy_version.to_string(),
        reason,
    }
}

/// Initialize authority system with default policies and actors
#[spacetimedb::reducer]
pub fn init_authority(ctx: &ReducerContext) {
    let version = crate::policy::current_policy_version_id(ctx)
        .unwrap_or_else(|| crate::CURRENT_POLICY_VERSION.to_string());
    ctx.db.cedar_policy_store().insert(CedarPolicyStore {
        version,
        policy_text: DEFAULT_CEDAR_POLICY.to_string(),
        created_at: ctx.timestamp,
        is_active: true,
        description: "Initial Ground Truth authorization policy".to_string(),
    });

    ctx.db.actor_permission_cap().insert(ActorPermissionCap {
        actor_type_id: 0,
        can_edit_policies: false,
        can_approve_escalations: false,
    });

    ctx.db.actor_permission_cap().insert(ActorPermissionCap {
        actor_type_id: 1,
        can_edit_policies: false,
        can_approve_escalations: true,
    });

    ctx.db.actor_permission_cap().insert(ActorPermissionCap {
        actor_type_id: 2,
        can_edit_policies: true,
        can_approve_escalations: true,
    });

    ctx.db.actor_identity().insert(ActorIdentity {
        identity_id: "ai_analyst".to_string(),
        actor_type: ActorType::AiAnalyst,
        display_name: "Ground Truth AI Analyst".to_string(),
        can_edit_policies: false,
        can_escalate: true,
        created_at: ctx.timestamp,
        is_active: true,
    });

    log::info!("Authority system initialized with Cedar policies");
}

/// Register a new actor identity
#[spacetimedb::reducer]
pub fn register_actor(
    ctx: &ReducerContext,
    identity_id: String,
    actor_type: u8,
    display_name: String,
) {
    let atype = match actor_type {
        0 => ActorType::AiAnalyst,
        1 => ActorType::HumanApprover,
        _ => ActorType::SystemAdmin,
    };

    let (can_edit, can_escalate) = match atype {
        ActorType::AiAnalyst => (false, true),
        ActorType::HumanApprover => (false, true),
        ActorType::SystemAdmin => (true, true),
    };

    ctx.db.actor_identity().insert(ActorIdentity {
        identity_id,
        actor_type: atype,
        display_name,
        can_edit_policies: can_edit,
        can_escalate,
        created_at: ctx.timestamp,
        is_active: true,
    });
}

/// Add a new policy version (only system admins)
#[spacetimedb::reducer]
pub fn add_policy_version(
    ctx: &ReducerContext,
    caller_id: String,
    version: String,
    policy_text: String,
    description: String,
) {
    if let Some(actor) = ctx.db.actor_identity().identity_id().find(&caller_id) {
        if !actor.can_edit_policies {
            log::error!(
                "Actor {} attempted to edit policy but lacks permission",
                caller_id
            );
            ctx.db.authorization_log().insert(AuthorizationLog {
                id: 0,
                timestamp: ctx.timestamp,
                actor_id: caller_id,
                action: "edit_policy".to_string(),
                resource: format!("policy:{}", version),
                decision: AuthzDecision::Deny,
                policy_version: "N/A".to_string(),
                reason: "Actor lacks edit_policy permission".to_string(),
            });
            return;
        }
    } else {
        log::error!("Unknown actor {} attempted to edit policy", caller_id);
        return;
    }

    for policy in ctx.db.cedar_policy_store().iter() {
        if policy.is_active {
            ctx.db.cedar_policy_store().version().update(CedarPolicyStore {
                is_active: false,
                ..policy
            });
        }
    }

    ctx.db.cedar_policy_store().insert(CedarPolicyStore {
        version: version.clone(),
        policy_text,
        created_at: ctx.timestamp,
        is_active: true,
        description,
    });

    ctx.db.authorization_log().insert(AuthorizationLog {
        id: 0,
        timestamp: ctx.timestamp,
        actor_id: caller_id,
        action: "edit_policy".to_string(),
        resource: format!("policy:{}", version),
        decision: AuthzDecision::Allow,
        policy_version: version,
        reason: "Policy updated by authorized admin".to_string(),
    });

    log::info!("Policy version updated");
}

/// Get the current active policy version
pub fn get_active_policy(ctx: &ReducerContext) -> Option<CedarPolicyStore> {
    ctx.db.cedar_policy_store().iter().find(|p| p.is_active)
}

/// Makes `version` the only active Cedar policy so authorization results are
/// stamped with the version the Policies page marks Current. A version the
/// store has not seen yet starts from the previously active policy text.
pub fn activate_policy_version(ctx: &ReducerContext, version: &str, description: &str) {
    let source_text = get_active_policy(ctx)
        .map(|p| p.policy_text)
        .unwrap_or_else(|| DEFAULT_CEDAR_POLICY.to_string());

    let others: Vec<CedarPolicyStore> = ctx
        .db
        .cedar_policy_store()
        .iter()
        .filter(|p| p.is_active && p.version != version)
        .collect();
    for policy in others {
        ctx.db.cedar_policy_store().version().update(CedarPolicyStore {
            is_active: false,
            ..policy
        });
    }

    match ctx.db.cedar_policy_store().version().find(version.to_string()) {
        Some(existing) if existing.is_active => {}
        Some(existing) => {
            ctx.db.cedar_policy_store().version().update(CedarPolicyStore {
                is_active: true,
                ..existing
            });
        }
        None => {
            ctx.db.cedar_policy_store().insert(CedarPolicyStore {
                version: version.to_string(),
                policy_text: source_text,
                created_at: ctx.timestamp,
                is_active: true,
                description: description.to_string(),
            });
        }
    }
}

/// Version label of the active Cedar policy, if any.
pub fn active_policy_version(ctx: &ReducerContext) -> Option<String> {
    get_active_policy(ctx).map(|p| p.version)
}

/// Check if an actor can perform an action on a resource
pub fn check_authorization(
    ctx: &ReducerContext,
    actor_id: &str,
    action: &str,
    resource_type: &str,
    resource_id: &str,
    amount_cents: i64,
    confidence_percent: i64,
) -> AuthzResult {
    let policy = match get_active_policy(ctx) {
        Some(p) => p,
        None => {
            return AuthzResult {
                decision: AuthzDecision::Deny,
                policy_version: "none".to_string(),
                reason: "No active policy found".to_string(),
            };
        }
    };

    let result = evaluate_authorization(
        &policy.policy_text,
        &policy.version,
        actor_id,
        action,
        resource_type,
        resource_id,
        amount_cents,
        confidence_percent,
    );

    ctx.db.authorization_log().insert(AuthorizationLog {
        id: 0,
        timestamp: ctx.timestamp,
        actor_id: actor_id.to_string(),
        action: action.to_string(),
        resource: format!("{}:{}", resource_type, resource_id),
        decision: result.decision,
        policy_version: result.policy_version.clone(),
        reason: result.reason.clone(),
    });

    result
}

/// Expose the default Cedar policy text for testing/reference
pub fn get_default_policy_text() -> &'static str {
    DEFAULT_CEDAR_POLICY
}

/// Expose the Cedar schema for reference
pub fn get_cedar_schema() -> &'static str {
    CEDAR_SCHEMA
}
