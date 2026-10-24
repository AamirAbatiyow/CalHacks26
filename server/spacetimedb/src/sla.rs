//! SLA Deadline Management for AWS Ground Station Disputes
//! 
//! This module handles:
//! - Dispute filing with automatic SLA deadline scheduling
//! - Auto-escalation when deadlines expire
//! - SLA credit application to the append-only ledger
//!
//! AWS Ground Station SLA terms reference:
//! - Response deadline: 72 hours from dispute filing
//! - Credit calculation: Based on monthly revenue and affected pass value

use spacetimedb::{ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp};
use std::time::Duration;

use crate::events::{EventType, record_event};

/// SLA tier determines response deadlines and credit percentages
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum SlaTier {
    Standard,    // 72-hour response, 10% credit
    Premium,     // 48-hour response, 15% credit
    Enterprise,  // 24-hour response, 25% credit
}

/// Dispute status tracking
#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisputeStatus {
    Filed,
    UnderReview,
    Approved,
    Denied,
    Escalated,
    CreditApplied,
    Expired,
}

/// A dispute filed against a pass failure or service issue
#[spacetimedb::table(accessor = dispute, public)]
#[derive(Clone)]
pub struct Dispute {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub pass_id: u64,
    pub station_id: String,
    pub filed_at: Timestamp,
    pub deadline_at: Timestamp,
    pub status: DisputeStatus,
    pub sla_tier: SlaTier,
    /// Amount in cents (convert to dollars for display: cents / 100.0)
    pub claim_amount_cents: i64,
    /// Amount actually credited in cents
    pub credit_amount_cents: i64,
    pub reason: String,
    pub resolution_notes: String,
    pub resolved_at: Option<Timestamp>,
}

/// Scheduled SLA deadline check - triggers auto-escalation/credit
#[spacetimedb::table(accessor = sla_deadline_schedule, scheduled(check_sla_deadline), public)]
pub struct SlaDeadlineSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub dispute_id: u64,
}

/// Ledger entry for all financial transactions (append-only)
#[spacetimedb::table(accessor = ledger_entry, public)]
pub struct LedgerEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub created_at: Timestamp,
    pub dispute_id: Option<u64>,
    pub pass_id: Option<u64>,
    pub station_id: String,
    pub entry_type: LedgerEntryType,
    /// Amount in cents (positive = credit to customer, negative = charge)
    pub amount_cents: i64,
    pub description: String,
    pub running_balance_cents: i64,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LedgerEntryType {
    PassRevenue,
    SlaCredit,
    ManualAdjustment,
    EscalationCredit,
    AutoApprovalCredit,
}

/// Audit log for all SLA-related actions (append-only)
#[spacetimedb::table(accessor = audit_log, public)]
pub struct AuditLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub timestamp: Timestamp,
    pub action: AuditAction,
    pub dispute_id: Option<u64>,
    pub actor: String,
    pub details: String,
    pub previous_state: String,
    pub new_state: String,
}

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuditAction {
    DisputeFiled,
    DisputeReviewed,
    DisputeApproved,
    DisputeDenied,
    DisputeEscalated,
    CreditIssued,
    DeadlineExpired,
    ManualOverride,
}

/// Get the response deadline duration based on SLA tier
fn get_deadline_duration(tier: SlaTier) -> Duration {
    match tier {
        SlaTier::Standard => Duration::from_secs(72 * 60 * 60),   // 72 hours
        SlaTier::Premium => Duration::from_secs(48 * 60 * 60),    // 48 hours
        SlaTier::Enterprise => Duration::from_secs(24 * 60 * 60), // 24 hours
    }
}

/// Get the credit percentage based on SLA tier
fn get_credit_percentage(tier: SlaTier) -> f64 {
    match tier {
        SlaTier::Standard => 0.10,    // 10%
        SlaTier::Premium => 0.15,     // 15%
        SlaTier::Enterprise => 0.25,  // 25%
    }
}

/// Get current ledger balance for a station
fn get_station_balance(ctx: &ReducerContext, station_id: &str) -> i64 {
    ctx.db.ledger_entry()
        .iter()
        .filter(|e| e.station_id == station_id)
        .map(|e| e.amount_cents)
        .sum()
}

/// File a new dispute and schedule its SLA deadline
#[spacetimedb::reducer]
pub fn file_dispute(
    ctx: &ReducerContext,
    pass_id: u64,
    station_id: String,
    sla_tier: u8,
    claim_amount_cents: i64,
    reason: String,
) {
    let tier = match sla_tier {
        1 => SlaTier::Premium,
        2 => SlaTier::Enterprise,
        _ => SlaTier::Standard,
    };
    
    let deadline_duration = get_deadline_duration(tier);
    let deadline_at = Timestamp::from_micros_since_unix_epoch(
        ctx.timestamp.to_micros_since_unix_epoch() + deadline_duration.as_micros() as i64
    );
    
    // Insert the dispute
    let dispute = ctx.db.dispute().insert(Dispute {
        id: 0,
        pass_id,
        station_id: station_id.clone(),
        filed_at: ctx.timestamp,
        deadline_at,
        status: DisputeStatus::Filed,
        sla_tier: tier,
        claim_amount_cents,
        credit_amount_cents: 0,
        reason: reason.clone(),
        resolution_notes: String::new(),
        resolved_at: None,
    });
    
    // Schedule the deadline check
    ctx.db.sla_deadline_schedule().insert(SlaDeadlineSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(deadline_at),
        dispute_id: dispute.id,
    });
    
    // Record audit log
    ctx.db.audit_log().insert(AuditLog {
        id: 0,
        timestamp: ctx.timestamp,
        action: AuditAction::DisputeFiled,
        dispute_id: Some(dispute.id),
        actor: "system".to_string(),
        details: format!(
            "Dispute filed for pass {} - claim: ${:.2} - reason: {}",
            pass_id,
            claim_amount_cents as f64 / 100.0,
            reason
        ),
        previous_state: "none".to_string(),
        new_state: "Filed".to_string(),
    });
    
    // Record event for playback
    record_event(
        ctx,
        EventType::DisputeFiled,
        Some(dispute.id),
        Some(pass_id),
        Some(station_id),
        claim_amount_cents,
        format!("Dispute filed: {}", reason),
    );
    
    log::info!("Dispute {} filed for pass {} with deadline at {:?}", dispute.id, pass_id, deadline_at);
}

/// Scheduled reducer: Check if SLA deadline has expired
#[spacetimedb::reducer]
pub fn check_sla_deadline(ctx: &ReducerContext, timer: SlaDeadlineSchedule) {
    if let Some(dispute) = ctx.db.dispute().id().find(timer.dispute_id) {
        // Only process if dispute is still pending (Filed or UnderReview)
        if dispute.status == DisputeStatus::Filed || dispute.status == DisputeStatus::UnderReview {
            log::info!("SLA deadline expired for dispute {} - auto-escalating", dispute.id);
            
            // Calculate credit amount based on SLA tier
            let credit_percentage = get_credit_percentage(dispute.sla_tier);
            let credit_amount = (dispute.claim_amount_cents as f64 * credit_percentage) as i64;
            
            // Get current balance for running total
            let current_balance = get_station_balance(ctx, &dispute.station_id);
            let new_balance = current_balance + credit_amount;
            
            // Update dispute to escalated with auto-credit
            ctx.db.dispute().id().update(Dispute {
                status: DisputeStatus::Escalated,
                credit_amount_cents: credit_amount,
                resolution_notes: format!(
                    "Auto-escalated: SLA deadline expired. Credit of ${:.2} ({:.0}% of claim) auto-applied.",
                    credit_amount as f64 / 100.0,
                    credit_percentage * 100.0
                ),
                resolved_at: Some(ctx.timestamp),
                ..dispute.clone()
            });
            
            // Create ledger entry for the credit
            ctx.db.ledger_entry().insert(LedgerEntry {
                id: 0,
                created_at: ctx.timestamp,
                dispute_id: Some(dispute.id),
                pass_id: Some(dispute.pass_id),
                station_id: dispute.station_id.clone(),
                entry_type: LedgerEntryType::EscalationCredit,
                amount_cents: credit_amount,
                description: format!(
                    "SLA escalation credit for dispute {} (deadline expired)",
                    dispute.id
                ),
                running_balance_cents: new_balance,
            });
            
            // Record audit log
            ctx.db.audit_log().insert(AuditLog {
                id: 0,
                timestamp: ctx.timestamp,
                action: AuditAction::DeadlineExpired,
                dispute_id: Some(dispute.id),
                actor: "system".to_string(),
                details: format!(
                    "SLA deadline expired - auto-escalated with ${:.2} credit",
                    credit_amount as f64 / 100.0
                ),
                previous_state: format!("{:?}", dispute.status),
                new_state: "Escalated".to_string(),
            });
            
            // Record event for playback
            record_event(
                ctx,
                EventType::DeadlineExpired,
                Some(dispute.id),
                Some(dispute.pass_id),
                Some(dispute.station_id.clone()),
                credit_amount,
                format!("SLA deadline expired - auto-credit applied: ${:.2}", credit_amount as f64 / 100.0),
            );
            
            record_event(
                ctx,
                EventType::CreditIssued,
                Some(dispute.id),
                Some(dispute.pass_id),
                Some(dispute.station_id),
                credit_amount,
                format!("Escalation credit issued: ${:.2}", credit_amount as f64 / 100.0),
            );
        }
    }
}

/// Approve a dispute and issue the full claimed credit
#[spacetimedb::reducer]
pub fn approve_dispute(ctx: &ReducerContext, dispute_id: u64, notes: String) {
    if let Some(dispute) = ctx.db.dispute().id().find(dispute_id) {
        if dispute.status != DisputeStatus::Filed && dispute.status != DisputeStatus::UnderReview {
            log::warn!("Cannot approve dispute {} - status is {:?}", dispute_id, dispute.status);
            return;
        }
        
        let credit_amount = dispute.claim_amount_cents;
        let current_balance = get_station_balance(ctx, &dispute.station_id);
        let new_balance = current_balance + credit_amount;
        
        ctx.db.dispute().id().update(Dispute {
            status: DisputeStatus::Approved,
            credit_amount_cents: credit_amount,
            resolution_notes: notes.clone(),
            resolved_at: Some(ctx.timestamp),
            ..dispute.clone()
        });
        
        ctx.db.ledger_entry().insert(LedgerEntry {
            id: 0,
            created_at: ctx.timestamp,
            dispute_id: Some(dispute.id),
            pass_id: Some(dispute.pass_id),
            station_id: dispute.station_id.clone(),
            entry_type: LedgerEntryType::SlaCredit,
            amount_cents: credit_amount,
            description: format!("SLA credit for approved dispute {}", dispute.id),
            running_balance_cents: new_balance,
        });
        
        ctx.db.audit_log().insert(AuditLog {
            id: 0,
            timestamp: ctx.timestamp,
            action: AuditAction::DisputeApproved,
            dispute_id: Some(dispute.id),
            actor: "operator".to_string(),
            details: format!("Dispute approved with full credit: ${:.2}. Notes: {}", 
                credit_amount as f64 / 100.0, notes),
            previous_state: format!("{:?}", dispute.status),
            new_state: "Approved".to_string(),
        });
        
        record_event(
            ctx,
            EventType::DisputeResolved,
            Some(dispute.id),
            Some(dispute.pass_id),
            Some(dispute.station_id.clone()),
            credit_amount,
            format!("Dispute approved: ${:.2}", credit_amount as f64 / 100.0),
        );
        
        record_event(
            ctx,
            EventType::CreditIssued,
            Some(dispute.id),
            Some(dispute.pass_id),
            Some(dispute.station_id),
            credit_amount,
            format!("SLA credit issued: ${:.2}", credit_amount as f64 / 100.0),
        );
        
        log::info!("Dispute {} approved with credit ${:.2}", dispute_id, credit_amount as f64 / 100.0);
    }
}

/// Deny a dispute
#[spacetimedb::reducer]
pub fn deny_dispute(ctx: &ReducerContext, dispute_id: u64, notes: String) {
    if let Some(dispute) = ctx.db.dispute().id().find(dispute_id) {
        if dispute.status != DisputeStatus::Filed && dispute.status != DisputeStatus::UnderReview {
            log::warn!("Cannot deny dispute {} - status is {:?}", dispute_id, dispute.status);
            return;
        }
        
        ctx.db.dispute().id().update(Dispute {
            status: DisputeStatus::Denied,
            credit_amount_cents: 0,
            resolution_notes: notes.clone(),
            resolved_at: Some(ctx.timestamp),
            ..dispute.clone()
        });
        
        ctx.db.audit_log().insert(AuditLog {
            id: 0,
            timestamp: ctx.timestamp,
            action: AuditAction::DisputeDenied,
            dispute_id: Some(dispute.id),
            actor: "operator".to_string(),
            details: format!("Dispute denied. Notes: {}", notes),
            previous_state: format!("{:?}", dispute.status),
            new_state: "Denied".to_string(),
        });
        
        record_event(
            ctx,
            EventType::DisputeResolved,
            Some(dispute.id),
            Some(dispute.pass_id),
            Some(dispute.station_id),
            0,
            format!("Dispute denied: {}", notes),
        );
        
        log::info!("Dispute {} denied", dispute_id);
    }
}

/// Manually issue a credit (outside of dispute process)
#[spacetimedb::reducer]
pub fn issue_manual_credit(
    ctx: &ReducerContext,
    station_id: String,
    pass_id: Option<u64>,
    amount_cents: i64,
    description: String,
) {
    let current_balance = get_station_balance(ctx, &station_id);
    let new_balance = current_balance + amount_cents;
    
    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: ctx.timestamp,
        dispute_id: None,
        pass_id,
        station_id: station_id.clone(),
        entry_type: LedgerEntryType::ManualAdjustment,
        amount_cents,
        description: description.clone(),
        running_balance_cents: new_balance,
    });
    
    ctx.db.audit_log().insert(AuditLog {
        id: 0,
        timestamp: ctx.timestamp,
        action: AuditAction::ManualOverride,
        dispute_id: None,
        actor: "operator".to_string(),
        details: format!("Manual credit issued: ${:.2} - {}", amount_cents as f64 / 100.0, description),
        previous_state: format!("balance: ${:.2}", current_balance as f64 / 100.0),
        new_state: format!("balance: ${:.2}", new_balance as f64 / 100.0),
    });
    
    record_event(
        ctx,
        EventType::CreditIssued,
        None,
        pass_id,
        Some(station_id),
        amount_cents,
        format!("Manual credit: ${:.2} - {}", amount_cents as f64 / 100.0, description),
    );
    
    log::info!("Manual credit of ${:.2} issued", amount_cents as f64 / 100.0);
}

/// Get the current total credits for a station (helper for UI)
#[spacetimedb::reducer]
pub fn get_station_credits(ctx: &ReducerContext, station_id: String) {
    let balance = get_station_balance(ctx, &station_id);
    log::info!("Station {} balance: ${:.2}", station_id, balance as f64 / 100.0);
}
