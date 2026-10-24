#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
MODULE="${SPACETIMEDB_MODULE:-ground-truth}"
SERVER="${SPACETIMEDB_SERVER:-local}"
SPACETIME="${SPACETIME:-$(command -v spacetime || echo "$HOME/.local/bin/spacetime")}"

echo "Seeding SpacetimeDB module: $MODULE on server: $SERVER"

# Seed stations
echo "Seeding stations..."
jq -c '.[]' "$FIXTURES_DIR/stations.json" | while read -r station; do
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

# Get current time in microseconds for pass offsets
NOW_MICROS=$(($(date +%s) * 1000000))

# Seed passes
echo "Seeding passes..."
jq -c '.[]' "$FIXTURES_DIR/passes.json" | while read -r pass; do
  sat_id=$(echo "$pass" | jq -r '.satellite_id')
  station_id=$(echo "$pass" | jq -r '.station_id')
  offset_mins=$(echo "$pass" | jq -r '.start_offset_minutes')
  duration_mins=$(echo "$pass" | jq -r '.duration_minutes')
  status=$(echo "$pass" | jq -r '.status')
  max_el=$(echo "$pass" | jq -r '.max_elevation_deg')
  revenue=$(echo "$pass" | jq -r '.revenue_cents')
  
  start_micros=$((NOW_MICROS + offset_mins * 60 * 1000000))
  end_micros=$((start_micros + duration_mins * 60 * 1000000))
  
  "$SPACETIME" call "$MODULE" seed_pass --server "$SERVER" -- "$sat_id" "\"$station_id\"" "$start_micros" "$end_micros" "$status" "$max_el" "$revenue" || true
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

# Cedar authority + confidence gate
echo "Initializing authority..."
"$SPACETIME" call "$MODULE" init_authority --server "$SERVER" || true
"$SPACETIME" call "$MODULE" init_confidence_config --server "$SERVER" || true
"$SPACETIME" call "$MODULE" register_actor --server "$SERVER" -- '"ops_reviewer"' 1 '"Ops Reviewer"' || true

# Claim detail (CLM-10021): a real NOAA-20 pass over SvalSat from the last few hours
echo "Seeding claims..."
if CLAIM_PASS=$(node "$SCRIPT_DIR/scripts/find-claim-pass.mjs" "$FIXTURES_DIR/satellites.json" "$FIXTURES_DIR/stations.json" 43013 svalsat 2>/dev/null); then
  claim_pass() { echo "$CLAIM_PASS" | jq -r ".$1"; }
  "$SPACETIME" call "$MODULE" seed_claim --server "$SERVER" -- '"CLM-10021"' '"Northpoint Orbital"' 1820000 10021 || true
  "$SPACETIME" call "$MODULE" seed_claim_pass --server "$SERVER" -- 10021 '"CLM-10021"' "$(claim_pass latitude)" "$(claim_pass longitude)" "\"$(claim_pass station_name)\"" "$(claim_pass norad_id)" "\"$(claim_pass tle1)\"" "\"$(claim_pass tle2)\"" "$(claim_pass start_micros)" "$(claim_pass signal_lost_micros)" "$(claim_pass end_micros)" "$(claim_pass max_elevation_deg)" || true
  "$SPACETIME" call "$MODULE" seed_claim_evidence --server "$SERVER" -- '"CLM-10021"' 0 240000 158000 || true
  "$SPACETIME" call "$MODULE" seed_claim_decision --server "$SERVER" -- '"CLM-10021"' 115000 96 0 '"credit_auto_limit"' '"v4"' '"v2"' || true
  "$SPACETIME" call "$MODULE" seed_claim_outcome --server "$SERVER" -- '"CLM-10021"' true true || true
  "$SPACETIME" call "$MODULE" seed_claim_weather --server "$SERVER" -- '"CLM-10021"' 6.0 true || true
else
  "$SPACETIME" call "$MODULE" seed_demo_claim --server "$SERVER" || true
fi

# Approvals: claims the confidence gate escalated for human review
echo "Seeding escalated claims..."
jq -c '.[]' "$FIXTURES_DIR/claims.json" | while read -r claim; do
  "$SPACETIME" call "$MODULE" seed_escalated_claim --server "$SERVER" -- \
    "$(echo "$claim" | jq '.customer_name')" \
    "$(echo "$claim" | jq '.amount_claimed_cents')" \
    "$(echo "$claim" | jq '.proposed_amount_cents')" \
    "$(echo "$claim" | jq '.confidence_pct')" \
    "$(echo "$claim" | jq '.escalation_reason')" \
    "$(echo "$claim" | jq '.policy_version')" \
    "$(echo "$claim" | jq '.model_version')" || true
done

# Break It: answer-key fixtures plus one completed run
echo "Seeding attack fixtures..."
"$SPACETIME" call "$MODULE" seed_attack_fixtures --server "$SERVER" || true
"$SPACETIME" call "$MODULE" run_all_attacks --server "$SERVER" || true

echo "Seeding complete!"
