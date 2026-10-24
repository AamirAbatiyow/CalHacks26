#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
MODULE="${SPACETIMEDB_MODULE:-ground-truth}"
SERVER="${SPACETIMEDB_SERVER:-local}"
SPACETIME="${SPACETIME:-$(command -v spacetime || echo "$HOME/.local/bin/spacetime")}"

echo "Seeding SpacetimeDB module: $MODULE on server: $SERVER"

# Get current time in microseconds for pass offsets
NOW_MICROS=$(($(date +%s) * 1000000))

# Pass history: contracted satellites' real contacts over the last 30 days and next
# 24 hours, the hand-written passes and the Claim page pass, all priced at AWS Ground
# Station rates (fixtures/contracts.json). Station revenue is summed from these passes.
echo "Generating pass history (about 30s)..."
GENERATED="$(mktemp)"
trap 'rm -f "$GENERATED"' EXIT
node "$SCRIPT_DIR/scripts/generate-passes.mjs" "$FIXTURES_DIR" "$NOW_MICROS" > "$GENERATED"

# Seed stations
echo "Seeding stations..."
jq -c '.stations[]' "$GENERATED" | while read -r station; do
  id=$(echo "$station" | jq -r '.id')
  name=$(echo "$station" | jq -r '.name')
  lat=$(echo "$station" | jq -r '.latitude')
  lon=$(echo "$station" | jq -r '.longitude')
  alt=$(echo "$station" | jq -r '.altitude_m')
  revenue=$(echo "$station" | jq -r '.monthly_revenue_cents')

  "$SPACETIME" call "$MODULE" seed_station --server "$SERVER" -- "\"$id\"" "\"$name\"" "$lat" "$lon" "$alt" "$revenue" || true
done

# Seed satellites
echo "Seeding satellites..."
jq -c '.[]' "$FIXTURES_DIR/satellites.json" | while read -r sat; do
  norad_id=$(echo "$sat" | jq -r '.norad_id')
  name=$(echo "$sat" | jq -r '.name')
  tle1=$(echo "$sat" | jq -r '.tle_line1')
  tle2=$(echo "$sat" | jq -r '.tle_line2')
  operator=$(echo "$sat" | jq -r '.operator')

  "$SPACETIME" call "$MODULE" seed_satellite --server "$SERVER" -- "$norad_id" "\"$name\"" "\"$tle1\"" "\"$tle2\"" "\"$operator\"" || true
done

# Seed passes in batches
echo "Seeding $(jq '.passes | length' "$GENERATED") passes..."
jq -c '.passes | _nwise(400)' "$GENERATED" | while read -r batch; do
  "$SPACETIME" call "$MODULE" seed_passes --server "$SERVER" -- "$batch" > /dev/null || true
done

# Seed space weather
echo "Seeding space weather..."
jq -c '.[]' "$FIXTURES_DIR/space_weather.json" | while read -r weather; do
  offset_mins=$(echo "$weather" | jq -r '.offset_minutes')
  kp=$(echo "$weather" | jq -r '.kp_index')
  flare=$(echo "$weather" | jq -r '.flare_class')
  dst=$(echo "$weather" | jq -r '.dst_index')
  
  timestamp_micros=$((NOW_MICROS + offset_mins * 60 * 1000000))
  
  "$SPACETIME" call "$MODULE" seed_space_weather --server "$SERVER" -- "$timestamp_micros" "$kp" "$flare" "$dst" || true
done

# Audit trail + ledger, referencing the passes seeded above
echo "Seeding finance history..."
"$SPACETIME" call "$MODULE" seed_finance_history --server "$SERVER" || true
SETTLEMENT=$(jq -c '.settlement + {norad_ids: [.contracts[].norad_ids[]]}' "$FIXTURES_DIR/contracts.json")
"$SPACETIME" call "$MODULE" settle_pass_history --server "$SERVER" -- "$SETTLEMENT" || true

# Cedar authority + confidence gate
echo "Initializing authority..."
"$SPACETIME" call "$MODULE" init_authority --server "$SERVER" || true
"$SPACETIME" call "$MODULE" init_confidence_config --server "$SERVER" || true
"$SPACETIME" call "$MODULE" register_actor --server "$SERVER" -- '"ops_reviewer"' 1 '"Ops Reviewer"' || true

# Claim detail (CLM-10021): a real NOAA-20 pass over SvalSat during the fixture storm,
# billed like every other pass. The customer claims the whole pass; the model's loss
# estimate is the share of the contact without downlink, half of which station
# telemetry corroborates. Credit, gate, rule and policy version are derived by the
# module from the evidence, the confidence gate and the active Cedar policy.
echo "Seeding claims..."
claim_pass() { jq -r ".claim_pass.$1" "$GENERATED"; }
contact_us=$(( $(claim_pass end_micros) - $(claim_pass start_micros) ))
gap_us=$(( $(claim_pass end_micros) - $(claim_pass signal_lost_micros) ))
claim_revenue=$(claim_pass revenue_cents)
est_loss=$(( claim_revenue * gap_us / contact_us ))
unverified=$(( est_loss / 2 ))
"$SPACETIME" call "$MODULE" seed_claim --server "$SERVER" -- '"CLM-10021"' '"Northpoint Orbital"' "$claim_revenue" 10021 || true
"$SPACETIME" call "$MODULE" seed_claim_pass --server "$SERVER" -- 10021 '"CLM-10021"' "$(claim_pass latitude)" "$(claim_pass longitude)" "\"$(claim_pass station_name)\"" "$(claim_pass norad_id)" "\"$(claim_pass tle1)\"" "\"$(claim_pass tle2)\"" "$(claim_pass start_micros)" "$(claim_pass signal_lost_micros)" "$(claim_pass end_micros)" "$(claim_pass max_elevation_deg)" || true
"$SPACETIME" call "$MODULE" seed_claim_evidence --server "$SERVER" -- '"CLM-10021"' 0 "$est_loss" "$unverified" || true
"$SPACETIME" call "$MODULE" seed_claim_weather --server "$SERVER" -- '"CLM-10021"' || true
"$SPACETIME" call "$MODULE" seed_claim_decision --server "$SERVER" -- '"CLM-10021"' 96 '"v2"' || true
"$SPACETIME" call "$MODULE" seed_claim_outcome --server "$SERVER" -- '"CLM-10021"' false false || true

contact_min=$(( contact_us / 60000000 ))
gap_min=$(( gap_us / 60000000 ))
lost_offset_min=$(( ($(claim_pass signal_lost_micros) - NOW_MICROS) / 60000000 ))
claim_kp=$(jq --argjson t "$lost_offset_min" 'min_by((.offset_minutes - $t) | fabs) | .kp_index' "$FIXTURES_DIR/space_weather.json")
claim_reason() { "$SPACETIME" call "$MODULE" seed_claim_reason --server "$SERVER" -- '"CLM-10021"' "\"$1\"" "\"$2\"" "$3" || true; }
claim_reason "Downlink lost mid-contact" "$gap_min of $contact_min min without telemetry" 1.12
claim_reason "Geomagnetic storm at signal loss" "Kp $claim_kp" 0.64
claim_reason "Data integrity check" "passed" 0.41
claim_reason "Max elevation" "$(claim_pass max_elevation_deg) deg" 0.18
claim_reason "Unverified share of loss" "\$$(( unverified / 100 )) of \$$(( est_loss / 100 ))" -0.37

# Approvals: claims the confidence gate escalated for human review, each over the
# customer's open passes and sized from their billed revenue
echo "Seeding escalated claims..."
jq -c '.[]' "$FIXTURES_DIR/claims.json" | while read -r claim; do
  customer=$(echo "$claim" | jq '.customer_name')
  norad_ids=$(jq -c --argjson name "$customer" '[.contracts[] | select(.customer == $name) | .norad_ids[]]' "$FIXTURES_DIR/contracts.json")
  "$SPACETIME" call "$MODULE" seed_escalated_claim --server "$SERVER" -- \
    "$customer" \
    "$norad_ids" \
    "$(echo "$claim" | jq '.selection')" \
    "$(echo "$claim" | jq '.pass_count')" \
    "$(echo "$claim" | jq '.lookback_hours')" \
    "$(echo "$claim" | jq '.claimed_pct')" \
    "$(echo "$claim" | jq '.proposed_pct')" \
    "$(echo "$claim" | jq '.confidence_pct')" \
    "$(echo "$claim" | jq '.escalation_reason')" \
    "$(echo "$claim" | jq '.policy_version')" \
    "$(echo "$claim" | jq '.model_version')" || true
done

# SLA terms (fixtures/sla_terms.json), six months of labeled human decisions (mined into the
# promoted learned policy), then live claims analyzed against all three sources.
# Escalated ones land in Approvals with their full evidence.
echo "Seeding contracts, decision history and incoming claims..."
"$SPACETIME" call "$MODULE" seed_contracts --server "$SERVER" || true
"$SPACETIME" call "$MODULE" seed_learning_history --server "$SERVER" || true
"$SPACETIME" call "$MODULE" seed_incoming_claims --server "$SERVER" || true

# Break It: attack fixtures plus one measured run
echo "Seeding attack fixtures..."
"$SPACETIME" call "$MODULE" seed_attack_fixtures --server "$SERVER" || true
"$SPACETIME" call "$MODULE" run_all_attacks --server "$SERVER" || true

# Decision architecture: SLA terms System 1/2 read, station maintenance windows, and
# six months of human-labeled decisions the worker trains System 1 on and mines for
# policy proposals. Start the worker (cd worker && npm start) after seeding.
echo "Seeding SLA terms and decision history..."
jq -c '.[]' "$FIXTURES_DIR/sla_terms.json" | while read -r c; do
  "$SPACETIME" call "$MODULE" seed_contract_term --server "$SERVER" -- \
    "$(echo "$c" | jq '.customer')" "$(echo "$c" | jq '.contract_id')" "$(echo "$c" | jq '.tier')" \
    "$(echo "$c" | jq '.sla_clause')" "$(echo "$c" | jq '.credit_pct')" "$(echo "$c" | jq '.max_credit_cents')" \
    "$(echo "$c" | jq '.weather_exclusion')" "$(echo "$c" | jq '.claim_window_days')" > /dev/null || true
done
"$SPACETIME" call "$MODULE" seed_decision_world --server "$SERVER" || true
WORKER_DIR="$SCRIPT_DIR/../worker"
if [ -d "$WORKER_DIR/node_modules" ]; then
  (cd "$WORKER_DIR" && STDB_MODULE="$MODULE" npm run --silent seed-history) || true
else
  echo "Skipping labeled history: run 'npm install' in worker/ and then 'npm run seed-history' there."
fi

echo "Seeding complete!"
