use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

use crate::kpis::sync_kpis;

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LedgerEntryType {
    Credit,
    Invoice,
    Recovery,
}

/// Append-only ledger shared by Finance and SLA dispute handling.
/// Amounts are from the operator's books: invoices and recoveries are positive,
/// credits paid out to customers are negative.
#[spacetimedb::table(accessor = ledger_entry, public)]
pub struct LedgerEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub created_at: Timestamp,
    pub entry_type: LedgerEntryType,
    pub description: String,
    pub reference_id: Option<String>,
    pub amount_cents: i64,
    pub dispute_id: Option<u64>,
    pub pass_id: Option<u64>,
    pub station_id: Option<String>,
}

fn entry_type_from_u8(entry_type: u8) -> LedgerEntryType {
    match entry_type {
        0 => LedgerEntryType::Credit,
        1 => LedgerEntryType::Invoice,
        _ => LedgerEntryType::Recovery,
    }
}

/// Posts a credit paid out to a customer. Every approved or auto-approved
/// decision that moves money goes through here, so the credits-paid KPI and the
/// Ledger page always agree with the audit trail.
pub fn post_credit(
    ctx: &ReducerContext,
    pass_id: Option<u64>,
    station_id: Option<String>,
    reference_id: String,
    description: String,
    amount_cents: i64,
) {
    if amount_cents <= 0 {
        return;
    }
    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: ctx.timestamp,
        entry_type: LedgerEntryType::Credit,
        description,
        reference_id: Some(reference_id),
        amount_cents: -amount_cents,
        dispute_id: None,
        pass_id,
        station_id,
    });
}

/// Total credits (as a positive number of cents) paid out against a station.
pub fn station_credits_cents(ctx: &ReducerContext, station_id: &str) -> i64 {
    ctx.db
        .ledger_entry()
        .iter()
        .filter(|e| e.entry_type == LedgerEntryType::Credit && e.station_id.as_deref() == Some(station_id))
        .map(|e| -e.amount_cents)
        .sum()
}

#[spacetimedb::reducer]
pub fn record_ledger_entry(
    ctx: &ReducerContext,
    entry_type: u8,
    description: String,
    reference_id: Option<String>,
    amount_cents: i64,
) {
    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: ctx.timestamp,
        entry_type: entry_type_from_u8(entry_type),
        description,
        reference_id,
        amount_cents,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });
    sync_kpis(ctx);
}

#[spacetimedb::reducer]
pub fn seed_ledger_entry(
    ctx: &ReducerContext,
    entry_type: u8,
    description: String,
    reference_id: Option<String>,
    amount_cents: i64,
    timestamp_micros: i64,
) {
    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(timestamp_micros),
        entry_type: entry_type_from_u8(entry_type),
        description,
        reference_id,
        amount_cents,
        dispute_id: None,
        pass_id: None,
        station_id: None,
    });
    sync_kpis(ctx);
}
