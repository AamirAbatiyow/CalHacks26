use spacetimedb::{ReducerContext, SpacetimeType, Table, Timestamp};

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum LedgerEntryType {
    Credit,
    Invoice,
    Recovery,
}

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
}

#[spacetimedb::reducer]
pub fn record_ledger_entry(
    ctx: &ReducerContext,
    entry_type: u8,
    description: String,
    reference_id: Option<String>,
    amount_cents: i64,
) {
    let etype = match entry_type {
        0 => LedgerEntryType::Credit,
        1 => LedgerEntryType::Invoice,
        _ => LedgerEntryType::Recovery,
    };
    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: ctx.timestamp,
        entry_type: etype,
        description,
        reference_id,
        amount_cents,
    });
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
    let etype = match entry_type {
        0 => LedgerEntryType::Credit,
        1 => LedgerEntryType::Invoice,
        _ => LedgerEntryType::Recovery,
    };
    ctx.db.ledger_entry().insert(LedgerEntry {
        id: 0,
        created_at: Timestamp::from_micros_since_unix_epoch(timestamp_micros),
        entry_type: etype,
        description,
        reference_id,
        amount_cents,
    });
}
