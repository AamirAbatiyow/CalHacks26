#!/bin/bash
# Clears a Ground Truth database and reseeds it from the fixtures.
#
#   ./reseed.sh <database> <server> --yes
#   ./reseed.sh ground-truth-aamir maincloud --yes
#
# Republishes the current module with --delete-data=always, which drops every row
# and recreates the schema in one step, so no table is left half-cleared or with a
# stale schema. Then runs seed.sh and prints the figures to check. Connected
# clients (web, worker) are disconnected by the republish; the worker reconnects
# on its own.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPACETIME="${SPACETIME:-$(command -v spacetime || echo "$HOME/.local/bin/spacetime")}"
DB="${1:-}"
SERVER="${2:-}"
CONFIRM="${3:-}"

if [ -z "$DB" ] || [ -z "$SERVER" ] || [ "$CONFIRM" != "--yes" ]; then
  echo "usage: $0 <database> <server> --yes" >&2
  echo "This DELETES all data in <database> on <server> and reseeds it." >&2
  exit 2
fi

# server/spacetime.local.json pins the database name; refuse a mismatch rather than
# silently seeding a different database than the one named on the command line.
PINNED=$(jq -r '.database // empty' "$SCRIPT_DIR/spacetime.local.json" 2>/dev/null || true)
if [ -n "$PINNED" ] && [ "$PINNED" != "$DB" ]; then
  echo "server/spacetime.local.json pins database '$PINNED' but you asked for '$DB'." >&2
  echo "Edit spacetime.local.json (or remove it) so both agree, then rerun." >&2
  exit 2
fi

for tool in jq node npm; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done
[ -d "$SCRIPT_DIR/scripts/node_modules" ] || (cd "$SCRIPT_DIR/scripts" && npm ci --silent)
[ -d "$SCRIPT_DIR/../web/node_modules" ] || (cd "$SCRIPT_DIR/../web" && npm ci --silent)
[ -d "$SCRIPT_DIR/../worker/node_modules" ] || (cd "$SCRIPT_DIR/../worker" && npm ci --silent)

echo "Building module..."
(cd "$SCRIPT_DIR/spacetimedb" && "$SPACETIME" build)

echo "Republishing $DB on $SERVER with all data cleared..."
(cd "$SCRIPT_DIR/spacetimedb" && "$SPACETIME" publish "$DB" --server "$SERVER" --delete-data=always --yes)

(cd "$SCRIPT_DIR" && SPACETIMEDB_MODULE="$DB" SPACETIMEDB_SERVER="$SERVER" ./seed.sh)

echo
echo "Seeded figures:"
q() { "$SPACETIME" sql "$DB" --server "$SERVER" "$1" 2>/dev/null | grep -v WARNING; }
q "SELECT * FROM kpi"
q "SELECT COUNT(*) AS passes FROM pass"
q "SELECT COUNT(*) AS ledger_entries FROM ledger_entry"
q "SELECT COUNT(*) AS labeled_decisions FROM labeled_decision"
q "SELECT COUNT(*) AS audit_decisions FROM audit_decision"
