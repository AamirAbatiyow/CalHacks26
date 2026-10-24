//! Changes to authority (a user's payout limit, a policy's claim cap) are a
//! request and a separate approval. The approver must be an admin, must not be
//! the requester and must not be the user whose limit changes; Cedar
//! (`authority::SEPARATION_OF_DUTIES_POLICY`) and the checks here both enforce it.

use crate::attack_run::{dollars, policy_rule, user_config, PolicyRule, UserConfig, UserRole};
use crate::authority::{evaluate_authority_change, get_active_policy, AuthorityDecision, SEPARATION_OF_DUTIES_POLICY};
use spacetimedb::{Identity, ReducerContext, Table, Timestamp};

pub const PAYOUT_LIMIT: &str = "payout_limit";
pub const CLAIM_CAP: &str = "claim_cap";
pub const PENDING: &str = "pending";
pub const APPLIED: &str = "applied";
pub const WITHDRAWN: &str = "withdrawn";

pub fn withdraw(ctx: &ReducerContext, change_id: u64) {
    if let Some(change) = ctx.db.authority_change().id().find(change_id).filter(|c| c.status == PENDING) {
        ctx.db.authority_change().id().update(AuthorityChange { status: WITHDRAWN.to_string(), decided_at: Some(ctx.timestamp), ..change });
    }
}

#[spacetimedb::table(accessor = authority_change, public)]
#[derive(Clone)]
pub struct AuthorityChange {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// `payout_limit` or `claim_cap`.
    pub kind: String,
    /// User whose payout limit changes; none for a claim cap.
    pub target: Option<Identity>,
    /// Policy whose claim cap changes; empty for a payout limit.
    pub policy_id: String,
    pub value_cents: i64,
    pub requested_by: Identity,
    pub requested_at: Timestamp,
    pub status: String,
    pub approved_by: Option<Identity>,
    pub decided_at: Option<Timestamp>,
    /// Why the last approval attempt was refused, if it was.
    pub refusal: String,
    pub policy_version: String,
}

/// Why an approval was refused: the server-side checks and the Cedar policies that forbade it.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub checks: Vec<String>,
    pub cedar: AuthorityDecision,
}

impl Refusal {
    pub fn message(&self) -> String {
        let cedar = if self.cedar.policies.is_empty() {
            format!("Cedar {}: no permit", self.cedar.policy_version)
        } else {
            format!("Cedar {} forbids: {}", self.cedar.policy_version, self.cedar.policies.join(", "))
        };
        format!("{}; {}", self.checks.join("; "), cedar)
    }
}

fn role_name(role: UserRole) -> &'static str {
    match role {
        UserRole::Customer => "customer",
        UserRole::Operator => "operator",
        UserRole::Admin => "admin",
    }
}

/// Server-side separation of duties, independent of whichever Cedar policy is active.
pub fn separation_checks(approver: Identity, approver_role: Option<UserRole>, requested_by: Identity, target: Option<Identity>) -> Vec<String> {
    let mut checks = Vec::new();
    if target == Some(approver) {
        checks.push("no one may raise their own authority limit".to_string());
    }
    if requested_by == approver {
        checks.push("no one may approve a change they requested".to_string());
    }
    if approver_role != Some(UserRole::Admin) {
        let who = match approver_role {
            Some(UserRole::Operator) => "an operator",
            Some(UserRole::Customer) => "a customer",
            _ => "an unknown user",
        };
        checks.push(format!("only an admin may approve authority changes, not {}", who));
    }
    checks
}

pub fn request(ctx: &ReducerContext, requester: Identity, kind: &str, target: Option<Identity>, policy_id: &str, value_cents: i64) -> Result<u64, String> {
    if ctx.db.user_config().identity().find(requester).is_none() {
        return Err(format!("unknown user {} cannot request an authority change", requester));
    }
    if kind == CLAIM_CAP && !ctx.db.user_config().identity().find(requester).is_some_and(|c| c.can_edit_policies) {
        return Err("no policy-edit permission".to_string());
    }
    match kind {
        PAYOUT_LIMIT if target.and_then(|t| ctx.db.user_config().identity().find(t)).is_none() => {
            return Err("payout limit change for an unknown user".to_string());
        }
        CLAIM_CAP if ctx.db.policy_rule().id().find(policy_id.to_string()).is_none() => {
            return Err(format!("policy {} not found", policy_id));
        }
        PAYOUT_LIMIT | CLAIM_CAP => {}
        other => return Err(format!("unknown authority change {}", other)),
    }
    let row = ctx.db.authority_change().insert(AuthorityChange {
        id: 0,
        kind: kind.to_string(),
        target: if kind == PAYOUT_LIMIT { target } else { None },
        policy_id: if kind == CLAIM_CAP { policy_id.to_string() } else { String::new() },
        value_cents,
        requested_by: requester,
        requested_at: ctx.timestamp,
        status: PENDING.to_string(),
        approved_by: None,
        decided_at: None,
        refusal: String::new(),
        policy_version: String::new(),
    });
    Ok(row.id)
}

/// Approves a pending change if both the server-side checks and Cedar allow it, then applies it.
pub fn approve(ctx: &ReducerContext, approver: Identity, change_id: u64) -> Result<(), Refusal> {
    let refuse = |checks: Vec<String>| Refusal {
        checks,
        cedar: AuthorityDecision { allowed: false, policy_version: String::new(), policies: Vec::new() },
    };
    let Some(change) = ctx.db.authority_change().id().find(change_id) else {
        return Err(refuse(vec![format!("authority change {} not found", change_id)]));
    };
    if change.status != PENDING {
        return Err(refuse(vec![format!("authority change {} is already {}", change_id, change.status)]));
    }
    let role = ctx.db.user_config().identity().find(approver).map(|c| c.role);
    let checks = separation_checks(approver, role, change.requested_by, change.target);
    let (policy_text, policy_version) = get_active_policy(ctx)
        .map(|p| (p.policy_text, p.version))
        .unwrap_or_else(|| (SEPARATION_OF_DUTIES_POLICY.to_string(), "separation-of-duties".to_string()));
    let target = match change.target {
        Some(t) => t.to_hex().to_string(),
        None => format!("policy:{}", change.policy_id),
    };
    let cedar = evaluate_authority_change(
        &policy_text,
        &policy_version,
        change.id,
        &approver.to_hex().to_string(),
        role.map(role_name).unwrap_or(""),
        &change.requested_by.to_hex().to_string(),
        &target,
    );
    if !checks.is_empty() || !cedar.allowed {
        let refusal = Refusal { checks, cedar };
        ctx.db.authority_change().id().update(AuthorityChange { refusal: refusal.message(), policy_version, ..change });
        return Err(refusal);
    }
    match change.kind.as_str() {
        PAYOUT_LIMIT => {
            let user = change.target.and_then(|t| ctx.db.user_config().identity().find(t)).ok_or_else(|| refuse(vec!["target user not found".to_string()]))?;
            ctx.db.user_config().identity().update(UserConfig { payout_limit_cents: change.value_cents, ..user });
        }
        _ => {
            let policy = ctx.db.policy_rule().id().find(change.policy_id.clone()).ok_or_else(|| refuse(vec![format!("policy {} not found", change.policy_id)]))?;
            ctx.db.policy_rule().id().update(PolicyRule {
                max_claim_cents: change.value_cents,
                last_modified_by: approver,
                last_modified_at: ctx.timestamp,
                ..policy
            });
        }
    }
    log::info!("Authority change {} applied: {} {} approved by a second admin", change.id, change.kind, dollars(change.value_cents));
    ctx.db.authority_change().id().update(AuthorityChange {
        status: APPLIED.to_string(),
        approved_by: Some(approver),
        decided_at: Some(ctx.timestamp),
        refusal: String::new(),
        policy_version,
        ..change
    });
    Ok(())
}

#[spacetimedb::reducer]
pub fn request_payout_limit_change(ctx: &ReducerContext, target: Identity, new_limit_cents: i64) -> Result<(), String> {
    request(ctx, ctx.sender(), PAYOUT_LIMIT, Some(target), "", new_limit_cents).map(|_| ())
}

#[spacetimedb::reducer]
pub fn request_claim_cap_change(ctx: &ReducerContext, policy_id: String, new_max_claim_cents: i64) -> Result<(), String> {
    request(ctx, ctx.sender(), CLAIM_CAP, None, &policy_id, new_max_claim_cents).map(|_| ())
}

#[spacetimedb::reducer]
pub fn approve_authority_change(ctx: &ReducerContext, change_id: u64) -> Result<(), String> {
    approve(ctx, ctx.sender(), change_id).map_err(|r| r.message())
}
