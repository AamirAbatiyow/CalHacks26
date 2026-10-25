//! ERP handoff for the ledger. The ledger is append-only, so whether an entry has
//! been handed to the ERP lives in `erp_posting`, one row per ledger entry, and each
//! submission is recorded in `erp_batch`. Submitting never edits the books.
//!
//! The target is an ERP sandbox: reducers cannot make network calls, so the module
//! validates and maps each entry and assigns the ERP document number itself. A real
//! connector would be a client like the worker that sends `erp_posting` rows using
//! `idempotency_key` and reports back through a reducer.

use std::collections::{BTreeSet, HashMap};

use spacetimedb::{Identity, ReducerContext, SpacetimeType, Table, Timestamp};

use crate::ledger::{ledger_entry, LedgerEntry, LedgerEntryType};

pub const ERP_TARGET: &str = "ERP sandbox";
/// Largest batch one call accepts; the seeded ledger is about 3,600 entries.
pub const MAX_BATCH: usize = 10_000;

#[derive(SpacetimeType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ErpStatus {
    Submitted,
    Failed,
}

/// Hand-off state of one ledger entry. No row means the entry is still pending.
#[spacetimedb::table(accessor = erp_posting, public)]
#[derive(Clone)]
pub struct ErpPosting {
    #[primary_key]
    pub ledger_entry_id: u64,
    /// Sent with every attempt so the ERP applies an entry at most once.
    #[unique]
    pub idempotency_key: String,
    pub status: ErpStatus,
    /// The batch of the latest attempt.
    #[index(btree)]
    pub batch_id: u64,
    pub document_type: String,
    /// The ledger reference, used as the ERP's external document number.
    pub external_id: String,
    pub erp_document_id: Option<String>,
    pub debit_account: String,
    pub credit_account: String,
    pub amount_cents: i64,
    pub attempts: u32,
    pub error: Option<String>,
    pub updated_at: Timestamp,
}

/// One submission: who sent what, when, and how it went.
#[spacetimedb::table(accessor = erp_batch, public)]
#[derive(Clone)]
pub struct ErpBatch {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Chosen by the client per click; repeating a request id does nothing.
    #[unique]
    pub request_id: String,
    pub batch_ref: String,
    pub submitted_at: Timestamp,
    pub submitted_by: Identity,
    pub submitted_by_name: String,
    pub target: String,
    pub requested: u32,
    pub posted: u32,
    pub failed: u32,
    /// Already submitted in an earlier batch, so not sent again.
    pub skipped: u32,
    /// Signed sum of the entries posted in this batch, as on the ledger.
    pub posted_net_cents: i64,
    pub invoice_cents: i64,
    pub credit_cents: i64,
    pub recovery_cents: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErpMapping {
    pub document_type: &'static str,
    pub prefix: &'static str,
    pub debit_account: &'static str,
    pub credit_account: &'static str,
}

/// How each ledger entry type lands in the ERP. Recoveries are revenue already
/// invoiced, so they post as a statistical journal with no GL impact.
pub fn mapping(entry_type: LedgerEntryType) -> ErpMapping {
    match entry_type {
        LedgerEntryType::Invoice => ErpMapping {
            document_type: "Customer invoice",
            prefix: "INV",
            debit_account: "1200 Accounts receivable",
            credit_account: "4000 Pass revenue",
        },
        LedgerEntryType::Credit => ErpMapping {
            document_type: "Credit memo",
            prefix: "CM",
            debit_account: "4100 SLA credits (contra-revenue)",
            credit_account: "1200 Accounts receivable",
        },
        LedgerEntryType::Recovery => ErpMapping {
            document_type: "Statistical journal",
            prefix: "SJ",
            debit_account: "9100 Recovered pass revenue (stat)",
            credit_account: "9199 Statistical offset",
        },
    }
}

pub fn idempotency_key(ledger_entry_id: u64) -> String {
    format!("gt-ledger-{}", ledger_entry_id)
}

pub fn erp_document_id(entry_type: LedgerEntryType, ledger_entry_id: u64) -> String {
    format!("{}-{:06}", mapping(entry_type).prefix, ledger_entry_id)
}

/// Checks the ERP would make. `posted_refs` maps external ids already in the ERP
/// to the ledger entry that posted them. Returns the external id on success.
pub fn validate(entry: &LedgerEntry, posted_refs: &HashMap<String, u64>) -> Result<String, String> {
    if entry.amount_cents == 0 {
        return Err("Zero amount: nothing to post".into());
    }
    let sign_ok = match entry.entry_type {
        LedgerEntryType::Credit => entry.amount_cents < 0,
        LedgerEntryType::Invoice | LedgerEntryType::Recovery => entry.amount_cents > 0,
    };
    if !sign_ok {
        return Err(format!("Sign does not match a {:?} entry", entry.entry_type));
    }
    let Some(reference) = entry.reference_id.as_deref().map(str::trim).filter(|r| !r.is_empty()) else {
        return Err("No document number: the ERP needs an external ID to deduplicate".into());
    };
    if entry.station_id.as_deref().map_or(true, |s| s.trim().is_empty()) {
        return Err("No station: the ERP needs a location for the GL line".into());
    }
    if let Some(&other) = posted_refs.get(reference) {
        if other != entry.id {
            return Err(format!("Document number {} already posted from ledger entry #{}", reference, other));
        }
    }
    Ok(reference.to_string())
}

/// Checks separation of duties: the submitter must not have approved any credit
/// in the batch. Returns the reference IDs of credits that would violate SoD.
pub fn sod_violations(entries: &[LedgerEntry], submitter: Identity) -> Vec<String> {
    entries
        .iter()
        .filter(|e| e.entry_type == LedgerEntryType::Credit && e.approved_by == Some(submitter))
        .filter_map(|e| e.reference_id.clone())
        .collect()
}

/// Sends ledger entries to the ERP in one batch. Entries already submitted are
/// skipped, failed ones are retried, and an unknown entry id rejects the whole call.
/// Separation of duties: rejects if the submitter approved any credit in the batch.
#[spacetimedb::reducer]
pub fn submit_to_erp(
    ctx: &ReducerContext,
    request_id: String,
    ledger_entry_ids: Vec<u64>,
    submitted_by_name: String,
) -> Result<(), String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("A request id is required".into());
    }
    if ctx.db.erp_batch().request_id().find(&request_id).is_some() {
        return Ok(());
    }
    let ids: BTreeSet<u64> = ledger_entry_ids.into_iter().collect();
    if ids.is_empty() {
        return Err("Select at least one ledger entry".into());
    }
    if ids.len() > MAX_BATCH {
        return Err(format!("At most {} entries per batch", MAX_BATCH));
    }
    let entries: Vec<LedgerEntry> = ids
        .iter()
        .map(|id| ctx.db.ledger_entry().id().find(id).ok_or_else(|| format!("No ledger entry #{}", id)))
        .collect::<Result<_, _>>()?;

    let sod = sod_violations(&entries, ctx.sender());
    if !sod.is_empty() {
        return Err(format!(
            "Separation of duties: you approved {} and cannot also submit {} to the ERP. A different user must submit.",
            if sod.len() == 1 { sod[0].clone() } else { format!("{} credits", sod.len()) },
            if sod.len() == 1 { "it" } else { "them" }
        ));
    }

    let mut posted_refs: HashMap<String, u64> = ctx
        .db
        .erp_posting()
        .iter()
        .filter(|p| p.status == ErpStatus::Submitted)
        .map(|p| (p.external_id, p.ledger_entry_id))
        .collect();

    let name = submitted_by_name.trim();
    let batch = ctx.db.erp_batch().insert(ErpBatch {
        id: 0,
        request_id,
        batch_ref: format!("ERP-B-{:05}", ctx.db.erp_batch().count() + 1),
        submitted_at: ctx.timestamp,
        submitted_by: ctx.sender(),
        submitted_by_name: if name.is_empty() { "finance.ops".into() } else { name.chars().take(64).collect() },
        target: ERP_TARGET.into(),
        requested: entries.len() as u32,
        posted: 0,
        failed: 0,
        skipped: 0,
        posted_net_cents: 0,
        invoice_cents: 0,
        credit_cents: 0,
        recovery_cents: 0,
    });
    let mut totals = batch.clone();

    for entry in &entries {
        let previous = ctx.db.erp_posting().ledger_entry_id().find(entry.id);
        if previous.as_ref().is_some_and(|p| p.status == ErpStatus::Submitted) {
            totals.skipped += 1;
            continue;
        }
        let map = mapping(entry.entry_type);
        let result = validate(entry, &posted_refs);
        let posting = ErpPosting {
            ledger_entry_id: entry.id,
            idempotency_key: idempotency_key(entry.id),
            status: if result.is_ok() { ErpStatus::Submitted } else { ErpStatus::Failed },
            batch_id: batch.id,
            document_type: map.document_type.into(),
            external_id: result.as_ref().cloned().unwrap_or_else(|_| entry.reference_id.clone().unwrap_or_default()),
            erp_document_id: result.as_ref().ok().map(|_| erp_document_id(entry.entry_type, entry.id)),
            debit_account: map.debit_account.into(),
            credit_account: map.credit_account.into(),
            amount_cents: entry.amount_cents,
            attempts: previous.as_ref().map_or(0, |p| p.attempts) + 1,
            error: result.as_ref().err().cloned(),
            updated_at: ctx.timestamp,
        };
        match &result {
            Ok(external_id) => {
                posted_refs.insert(external_id.clone(), entry.id);
                totals.posted += 1;
                totals.posted_net_cents += entry.amount_cents;
                match entry.entry_type {
                    LedgerEntryType::Invoice => totals.invoice_cents += entry.amount_cents,
                    LedgerEntryType::Credit => totals.credit_cents += entry.amount_cents,
                    LedgerEntryType::Recovery => totals.recovery_cents += entry.amount_cents,
                }
            }
            Err(_) => totals.failed += 1,
        }
        if previous.is_some() {
            ctx.db.erp_posting().ledger_entry_id().update(posting);
        } else {
            ctx.db.erp_posting().insert(posting);
        }
    }

    log::info!(
        "{} by {}: {} posted, {} failed, {} skipped",
        totals.batch_ref, totals.submitted_by_name, totals.posted, totals.failed, totals.skipped
    );
    ctx.db.erp_batch().id().update(totals);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64, entry_type: LedgerEntryType, amount_cents: i64, reference: Option<&str>, station: Option<&str>) -> LedgerEntry {
        LedgerEntry {
            id,
            created_at: Timestamp::from_micros_since_unix_epoch(0),
            entry_type,
            description: String::new(),
            reference_id: reference.map(String::from),
            amount_cents,
            dispute_id: None,
            pass_id: None,
            station_id: station.map(String::from),
            approved_by: None,
        }
    }

    #[test]
    fn valid_entries_post_under_their_reference() {
        let none = HashMap::new();
        let credit = entry(7, LedgerEntryType::Credit, -2_300_00, Some("CR-CLM-20001"), Some("svalsat"));
        assert_eq!(validate(&credit, &none), Ok("CR-CLM-20001".to_string()));
        let invoice = entry(8, LedgerEntryType::Invoice, 10_000_00, Some(" INV-2026-SVALSAT "), Some("svalsat"));
        assert_eq!(validate(&invoice, &none), Ok("INV-2026-SVALSAT".to_string()));
    }

    #[test]
    fn the_erp_rejects_what_it_cannot_post() {
        let none = HashMap::new();
        let no_ref = entry(1, LedgerEntryType::Credit, -100, None, Some("svalsat"));
        assert!(validate(&no_ref, &none).unwrap_err().starts_with("No document number"));
        let no_station = entry(2, LedgerEntryType::Credit, -100, Some("CR-1"), None);
        assert!(validate(&no_station, &none).unwrap_err().starts_with("No station"));
        let zero = entry(3, LedgerEntryType::Invoice, 0, Some("INV-1"), Some("svalsat"));
        assert!(validate(&zero, &none).unwrap_err().starts_with("Zero amount"));
        let wrong_sign = entry(4, LedgerEntryType::Credit, 100, Some("CR-4"), Some("svalsat"));
        assert!(validate(&wrong_sign, &none).unwrap_err().starts_with("Sign does not match"));
    }

    #[test]
    fn a_document_number_posts_once() {
        let posted = HashMap::from([("CR-2026-11".to_string(), 5u64)]);
        let same_entry = entry(5, LedgerEntryType::Credit, -100, Some("CR-2026-11"), Some("svalsat"));
        assert!(validate(&same_entry, &posted).is_ok());
        let other_entry = entry(9, LedgerEntryType::Credit, -100, Some("CR-2026-11"), Some("svalsat"));
        assert_eq!(
            validate(&other_entry, &posted),
            Err("Document number CR-2026-11 already posted from ledger entry #5".to_string())
        );
    }

    #[test]
    fn mapping_balances_and_ids_are_stable() {
        for t in [LedgerEntryType::Invoice, LedgerEntryType::Credit, LedgerEntryType::Recovery] {
            let m = mapping(t);
            assert_ne!(m.debit_account, m.credit_account);
        }
        assert_eq!(mapping(LedgerEntryType::Credit).credit_account, mapping(LedgerEntryType::Invoice).debit_account);
        assert_eq!(erp_document_id(LedgerEntryType::Credit, 42), "CM-000042");
        assert_eq!(idempotency_key(42), "gt-ledger-42");
    }
}
