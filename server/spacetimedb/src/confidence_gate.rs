//! Confidence Gate module for Ground Truth.
//!
//! Routes every decision on AI confidence alone; the claim amount never gates:
//! - >= 95% confidence: automatic approval (if authorized by Cedar)
//! - < 95% confidence: escalates to a human in the Approvals queue

use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

use crate::authority::{check_authorization, AuthzDecision};
use crate::kpis::sync_kpis;
use crate::ledger::post_credit;
use crate::{decision_record, DecisionOutcome, DecisionRecord, DecisionType};

pub const CONFIDENCE_AUTO_APPROVE_THRESHOLD: i64 = 95;

/// Decision route determined by confidence gate
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecisionRoute {
    /// Confidence >= 95%: can be auto-approved
    AutoApprove,
    /// Confidence < 95%: escalated to human review
    Escalated,
}

/// Priority level for approval queue
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ApprovalPriority {
    Low,
    Medium,
    High,
    Critical,
}

/// Approval queue for claims requiring human review
#[derive(Clone)]
#[spacetimedb::table(accessor = approval_queue, public)]
pub struct ApprovalQueue {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub claim_id: u64,
    pub pass_id: Option<u64>,
    pub station_id: Option<String>,
    pub amount_cents: i64,
    pub confidence_percent: i64,
    pub route: DecisionRoute,
    pub priority: ApprovalPriority,
    pub ai_recommendation: String,
    pub model_version: String,
    pub policy_version: String,
    pub created_at: Timestamp,
    pub assigned_to: Option<String>,
    pub status: ApprovalQueueStatus,
}

/// Status of items in the approval queue
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ApprovalQueueStatus {
    Pending,
    InReview,
    Approved,
    Denied,
    Cancelled,
}

/// Configuration for confidence gate thresholds (can be adjusted by admins)
#[spacetimedb::table(accessor = confidence_config, public)]
pub struct ConfidenceConfig {
    #[primary_key]
    pub id: u32,
    pub auto_approve_threshold: i64,
    pub updated_at: Timestamp,
}

/// Determines the decision route from confidence alone
pub fn determine_route(confidence_percent: i64) -> DecisionRoute {
    if confidence_percent >= CONFIDENCE_AUTO_APPROVE_THRESHOLD {
        DecisionRoute::AutoApprove
    } else {
        DecisionRoute::Escalated
    }
}

/// Determines priority based on amount and confidence
fn determine_priority(amount_cents: i64, confidence_percent: i64) -> ApprovalPriority {
    if amount_cents > 100000 {
        ApprovalPriority::Critical
    } else if amount_cents > 50000 {
        ApprovalPriority::High
    } else if confidence_percent < 60 {
        ApprovalPriority::High
    } else if amount_cents > 20000 {
        ApprovalPriority::Medium
    } else {
        ApprovalPriority::Low
    }
}

/// Initialize confidence gate configuration
#[spacetimedb::reducer]
pub fn init_confidence_config(ctx: &ReducerContext) {
    ctx.db.confidence_config().insert(ConfidenceConfig {
        id: 0,
        auto_approve_threshold: CONFIDENCE_AUTO_APPROVE_THRESHOLD,
        updated_at: ctx.timestamp,
    });

    log::info!("Confidence gate configuration initialized");
}

/// Process a claim through the confidence gate
/// Returns the decision outcome and optionally adds to approval queue
#[spacetimedb::reducer]
pub fn process_claim_decision(
    ctx: &ReducerContext,
    actor_id: String,
    claim_id: u64,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    confidence_percent: i64,
    ai_recommendation: String,
    model_version: String,
) {
    let route = determine_route(confidence_percent);

    let (outcome, policy_version) = match route {
        DecisionRoute::AutoApprove => {
            let authz = check_authorization(
                ctx,
                &actor_id,
                "auto_approve",
                "Claim",
                &claim_id.to_string(),
                amount_cents,
                confidence_percent,
            );

            if authz.decision == AuthzDecision::Allow {
                log::info!(
                    "Claim {} auto-approved by {} (confidence: {}%, amount: {})",
                    claim_id,
                    actor_id,
                    confidence_percent,
                    amount_cents
                );
                (DecisionOutcome::AutoApproved, authz.policy_version)
            } else {
                log::info!(
                    "Claim {} escalated - auto-approve denied: {}",
                    claim_id,
                    authz.reason
                );
                let priority = determine_priority(amount_cents, confidence_percent);
                ctx.db.approval_queue().insert(ApprovalQueue {
                    id: 0,
                    claim_id,
                    pass_id,
                    station_id: station_id.clone(),
                    amount_cents,
                    confidence_percent,
                    route: DecisionRoute::Escalated,
                    priority,
                    ai_recommendation: ai_recommendation.clone(),
                    model_version: model_version.clone(),
                    policy_version: authz.policy_version.clone(),
                    created_at: ctx.timestamp,
                    assigned_to: None,
                    status: ApprovalQueueStatus::Pending,
                });
                (DecisionOutcome::Escalated, authz.policy_version)
            }
        }
        DecisionRoute::Escalated => {
            let authz = check_authorization(
                ctx,
                &actor_id,
                "recommend_approval",
                "Claim",
                &claim_id.to_string(),
                amount_cents,
                confidence_percent,
            );

            let priority = determine_priority(amount_cents, confidence_percent);
            ctx.db.approval_queue().insert(ApprovalQueue {
                id: 0,
                claim_id,
                pass_id,
                station_id: station_id.clone(),
                amount_cents,
                confidence_percent,
                route,
                priority,
                ai_recommendation: ai_recommendation.clone(),
                model_version: model_version.clone(),
                policy_version: authz.policy_version.clone(),
                created_at: ctx.timestamp,
                assigned_to: None,
                status: ApprovalQueueStatus::Pending,
            });

            log::info!(
                "Claim {} escalated (confidence: {}%)",
                claim_id,
                confidence_percent
            );

            (DecisionOutcome::Escalated, authz.policy_version)
        }
    };

    if outcome == DecisionOutcome::AutoApproved {
        post_credit(
            ctx,
            pass_id,
            station_id.clone(),
            format!("CR-AUTO-{}", claim_id),
            format!("Credit auto-approved for claim {} at {}% confidence", claim_id, confidence_percent),
            amount_cents,
        );
    }

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: DecisionType::DisputeCreated,
        outcome,
        pass_id,
        station_id,
        amount_cents,
        reason: ai_recommendation,
        policy_version,
        model_version,
    });
    sync_kpis(ctx);
}

/// Human approver processes a queued claim
#[spacetimedb::reducer]
pub fn human_approve_claim(
    ctx: &ReducerContext,
    approver_id: String,
    queue_id: u64,
    approved: bool,
    reason: String,
) {
    let queue_item = match ctx.db.approval_queue().id().find(queue_id) {
        Some(item) => item,
        None => {
            log::error!("Queue item {} not found", queue_id);
            return;
        }
    };

    if queue_item.status != ApprovalQueueStatus::Pending
        && queue_item.status != ApprovalQueueStatus::InReview
    {
        log::error!("Queue item {} is not pending approval", queue_id);
        return;
    }

    let action = if approved { "approve" } else { "deny" };
    let authz = check_authorization(
        ctx,
        &approver_id,
        action,
        "Claim",
        &queue_item.claim_id.to_string(),
        queue_item.amount_cents,
        queue_item.confidence_percent,
    );

    if authz.decision != AuthzDecision::Allow {
        log::error!(
            "Approver {} not authorized to {} claim: {}",
            approver_id,
            action,
            authz.reason
        );
        return;
    }

    let (outcome, status) = if approved {
        (DecisionOutcome::Approved, ApprovalQueueStatus::Approved)
    } else {
        (DecisionOutcome::Denied, ApprovalQueueStatus::Denied)
    };

    ctx.db.approval_queue().id().update(ApprovalQueue {
        status,
        assigned_to: Some(approver_id.clone()),
        ..queue_item.clone()
    });

    if approved {
        post_credit(
            ctx,
            queue_item.pass_id,
            queue_item.station_id.clone(),
            format!("CR-REV-{}", queue_item.claim_id),
            format!("Credit approved for claim {} by {}", queue_item.claim_id, approver_id),
            queue_item.amount_cents,
        );
    }

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: DecisionType::DisputeResolved,
        outcome,
        pass_id: queue_item.pass_id,
        station_id: queue_item.station_id.clone(),
        amount_cents: queue_item.amount_cents,
        reason,
        policy_version: authz.policy_version,
        model_version: queue_item.model_version.clone(),
    });
    sync_kpis(ctx);

    log::info!(
        "Claim {} {} by human approver {}",
        queue_item.claim_id,
        if approved { "approved" } else { "denied" },
        approver_id
    );
}

/// AI analyst requests escalation (for complex cases)
#[spacetimedb::reducer]
pub fn escalate_claim(
    ctx: &ReducerContext,
    actor_id: String,
    claim_id: u64,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    confidence_percent: i64,
    escalation_reason: String,
    model_version: String,
) {
    let authz = check_authorization(
        ctx,
        &actor_id,
        "escalate",
        "Claim",
        &claim_id.to_string(),
        amount_cents,
        confidence_percent,
    );

    if authz.decision != AuthzDecision::Allow {
        log::error!(
            "Actor {} not authorized to escalate claim: {}",
            actor_id,
            authz.reason
        );
        return;
    }

    let priority = ApprovalPriority::High;
    ctx.db.approval_queue().insert(ApprovalQueue {
        id: 0,
        claim_id,
        pass_id,
        station_id: station_id.clone(),
        amount_cents,
        confidence_percent,
        route: DecisionRoute::Escalated,
        priority,
        ai_recommendation: escalation_reason.clone(),
        model_version: model_version.clone(),
        policy_version: authz.policy_version.clone(),
        created_at: ctx.timestamp,
        assigned_to: None,
        status: ApprovalQueueStatus::Pending,
    });

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: DecisionType::DisputeCreated,
        outcome: DecisionOutcome::Escalated,
        pass_id,
        station_id,
        amount_cents,
        reason: escalation_reason,
        policy_version: authz.policy_version,
        model_version,
    });

    log::info!("Claim {} escalated by {}", claim_id, actor_id);
}

/// Issue credit for an approved claim
#[spacetimedb::reducer]
pub fn issue_credit(
    ctx: &ReducerContext,
    actor_id: String,
    claim_id: u64,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    confidence_percent: i64,
    reason: String,
    model_version: String,
) {
    let route = determine_route(confidence_percent);

    let authz = if route == DecisionRoute::AutoApprove {
        check_authorization(
            ctx,
            &actor_id,
            "auto_approve",
            "Claim",
            &claim_id.to_string(),
            amount_cents,
            confidence_percent,
        )
    } else {
        check_authorization(
            ctx,
            &actor_id,
            "approve",
            "Claim",
            &claim_id.to_string(),
            amount_cents,
            confidence_percent,
        )
    };

    if authz.decision != AuthzDecision::Allow {
        log::error!(
            "Actor {} not authorized to issue credit: {}",
            actor_id,
            authz.reason
        );

        ctx.db.decision_record().insert(DecisionRecord {
            id: 0,
            created_at: ctx.timestamp,
            decision_type: DecisionType::CreditIssued,
            outcome: DecisionOutcome::Denied,
            pass_id,
            station_id,
            amount_cents,
            reason: format!("Authorization denied: {}", authz.reason),
            policy_version: authz.policy_version,
            model_version,
        });
        return;
    }

    let outcome = if route == DecisionRoute::AutoApprove {
        DecisionOutcome::AutoApproved
    } else {
        DecisionOutcome::Approved
    };

    post_credit(
        ctx,
        pass_id,
        station_id.clone(),
        format!("CR-{}", claim_id),
        format!("Credit issued for claim {}", claim_id),
        amount_cents,
    );

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: DecisionType::CreditIssued,
        outcome,
        pass_id,
        station_id,
        amount_cents,
        reason,
        policy_version: authz.policy_version,
        model_version,
    });
    sync_kpis(ctx);

    log::info!(
        "Credit of ${} issued for claim {} by {}",
        amount_cents / 100,
        claim_id,
        actor_id
    );
}

/// Deny a claim
#[spacetimedb::reducer]
pub fn deny_claim(
    ctx: &ReducerContext,
    actor_id: String,
    claim_id: u64,
    pass_id: Option<u64>,
    station_id: Option<String>,
    amount_cents: i64,
    confidence_percent: i64,
    reason: String,
    model_version: String,
) {
    let authz = check_authorization(
        ctx,
        &actor_id,
        "deny",
        "Claim",
        &claim_id.to_string(),
        amount_cents,
        confidence_percent,
    );

    if authz.decision != AuthzDecision::Allow {
        log::error!(
            "Actor {} not authorized to deny claim: {}",
            actor_id,
            authz.reason
        );
        return;
    }

    ctx.db.decision_record().insert(DecisionRecord {
        id: 0,
        created_at: ctx.timestamp,
        decision_type: DecisionType::DisputeResolved,
        outcome: DecisionOutcome::Denied,
        pass_id,
        station_id,
        amount_cents,
        reason,
        policy_version: authz.policy_version,
        model_version,
    });
    sync_kpis(ctx);

    log::info!("Claim {} denied by {}", claim_id, actor_id);
}

/// Get pending approvals (only escalated items)
pub fn get_pending_approvals(ctx: &ReducerContext) -> Vec<ApprovalQueue> {
    ctx.db
        .approval_queue()
        .iter()
        .filter(|q| q.status == ApprovalQueueStatus::Pending)
        .collect()
}
