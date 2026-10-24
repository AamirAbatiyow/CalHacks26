#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
MODULE="${SPACETIMEDB_MODULE:-ground-truth}"
SERVER="${SPACETIMEDB_SERVER:-local}"

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
  
  spacetime call "$MODULE" seed_station "\"$id\"" "\"$name\"" "$lat" "$lon" "$alt" "$revenue" --server "$SERVER" || true
done

# Seed satellites
echo "Seeding satellites..."
jq -c '.[]' "$FIXTURES_DIR/satellites.json" | while read -r sat; do
  norad_id=$(echo "$sat" | jq -r '.norad_id')
  name=$(echo "$sat" | jq -r '.name')
  tle1=$(echo "$sat" | jq -r '.tle_line1')
  tle2=$(echo "$sat" | jq -r '.tle_line2')
  operator=$(echo "$sat" | jq -r '.operator')
  
  spacetime call "$MODULE" seed_satellite "$norad_id" "\"$name\"" "\"$tle1\"" "\"$tle2\"" "\"$operator\"" --server "$SERVER" || true
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
  
  spacetime call "$MODULE" seed_pass "$sat_id" "\"$station_id\"" "$start_micros" "$end_micros" "$status" "$max_el" "$revenue" --server "$SERVER" || true
done

# Seed space weather
echo "Seeding space weather..."
jq -c '.[]' "$FIXTURES_DIR/space_weather.json" | while read -r weather; do
  offset_mins=$(echo "$weather" | jq -r '.offset_minutes')
  kp=$(echo "$weather" | jq -r '.kp_index')
  flare=$(echo "$weather" | jq -r '.flare_class')
  dst=$(echo "$weather" | jq -r '.dst_index')
  
  timestamp_micros=$((NOW_MICROS + offset_mins * 60 * 1000000))
  
  spacetime call "$MODULE" seed_space_weather "$timestamp_micros" "$kp" "$flare" "$dst" --server "$SERVER" || true
done

echo "Seeding complete!"
