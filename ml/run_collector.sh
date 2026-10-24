#!/usr/bin/env bash
# Keep the SatNOGS collector (and its scheduled retrain) running; restart on crash.
# Usage: ml/run_collector.sh            (foreground loop; run under tmux/nohup/systemd)
set -u
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
while true; do
  "$PY" -m ml.satnogs_fetcher daemon "$@"
  code=$?
  echo "[$(date -u +%FT%TZ)] collector exited with $code; restarting in 60s" >> data/raw/satnogs_store/collector.log
  sleep 60
done
