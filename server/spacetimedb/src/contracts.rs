//! Third data source: customer contracts and SLA terms, station maintenance logs,
//! and the customers' own dispute messages.

use serde::{Deserialize, Serialize};
use spacetimedb::{ReducerContext, Table, Timestamp};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[spacetimedb::table(accessor = customer_contract, public)]
pub struct CustomerContract {
    #[primary_key]
    pub customer_id: String,
    pub name: String,
    /// platinum | gold | silver | standard
    pub tier: String,
    pub contract_ref: String,
    /// Share of a contact that must be lost for a full-fee credit; smaller losses are pro rata.
    pub full_credit_lost_pct: i64,
    /// Space weather at or above this Kp is an excused event.
    pub kp_exclusion: f32,
    /// Planned maintenance announced at least this far ahead is an excused event.
    pub maintenance_notice_hours: i64,
    /// Passes peaking below this elevation are best effort.
    pub min_elevation_deg: f64,
    pub filing_window_days: i64,
    /// Account age; accounts younger than `NEW_ACCOUNT_DAYS` have no claim history.
    pub since_days: i64,
    pub clause: String,
}

pub const NEW_ACCOUNT_DAYS: i64 = 90;

pub fn fixture_contracts() -> Vec<CustomerContract> {
    serde_json::from_str(include_str!("../../fixtures/sla_contracts.json")).expect("sla_contracts.json")
}

#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = maintenance_log, public)]
pub struct MaintenanceLog {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub station_id: String,
    pub start_time: Timestamp,
    pub end_time: Timestamp,
    /// planned | unplanned
    pub kind: String,
    /// Hours between the customer notice and the start of work; 0 for unplanned outages.
    pub notice_hours: i64,
    pub description: String,
}

#[derive(Clone, Debug)]
#[spacetimedb::table(accessor = claim_message, public)]
pub struct ClaimMessage {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub case_id: String,
    pub received_at: Timestamp,
    /// email | portal | ticket
    pub channel: String,
    pub author: String,
    pub body: String,
}

/// Fields pulled from a customer's free-text message by keyword match. Deterministic
/// on purpose: the text is untrusted input and only ever feeds these flags.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MessageFields {
    pub cites_weather: bool,
    pub claims_full_loss: bool,
    pub mentions_maintenance: bool,
}

pub fn extract_message_fields(body: &str) -> MessageFields {
    let text = body.to_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| text.contains(w));
    MessageFields {
        cites_weather: any(&["storm", "geomagnetic", "aurora", "solar", "space weather", "cme", "kp "]),
        claims_full_loss: any(&["full credit", "entire", "complete loss", "no data", "nothing", "whole pass", "full refund", "100%"]),
        mentions_maintenance: any(&["maintenance", "outage", "downtime", "upgrade"]),
    }
}

#[spacetimedb::reducer]
pub fn seed_contracts(ctx: &ReducerContext) {
    for contract in fixture_contracts() {
        if ctx.db.customer_contract().customer_id().find(&contract.customer_id).is_none() {
            ctx.db.customer_contract().insert(contract);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contracts_fixture_parses_with_distinct_terms() {
        let contracts = fixture_contracts();
        assert_eq!(contracts.len(), 8);
        let mut tiers: Vec<&str> = contracts.iter().map(|c| c.tier.as_str()).collect();
        tiers.sort();
        tiers.dedup();
        assert_eq!(tiers, ["gold", "platinum", "silver", "standard"]);
        assert!(contracts.iter().any(|c| c.since_days < NEW_ACCOUNT_DAYS));
    }

    #[test]
    fn message_fields_are_keyword_flags() {
        let f = extract_message_fields("Our contact dropped during the geomagnetic storm. We request full credit.");
        assert!(f.cites_weather && f.claims_full_loss && !f.mentions_maintenance);
        assert_eq!(extract_message_fields("Downlink was fine but files were corrupted."), MessageFields::default());
    }
}
