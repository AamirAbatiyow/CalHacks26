#!/usr/bin/env python3
"""
Compatibility shim: SatNOGS fetching now lives in `ml/satnogs_fetcher.py`.

The three earlier fetchers (this per-slice fetcher from PR #12, the block
fetcher `fetch_uniform` from PR #17 and the random-window natural fetcher from
PR #18) are merged into one resumable, cached, rate-limit-aware collector with a
single on-disk store. This module keeps the old import surface
(`WINDOW_DIR`, `load_window_observations`, `fetch_kp_history`) for
`datasets.load_window` and `verify_labels`, and forwards the CLI:

    python -m ml.fetch_labeled --window 2026-10-24T00:00 2026-10-24T06:00
      -> python -m ml.satnogs_fetcher window 2026-10-24T00 2026-10-24T06
"""

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import satnogs_fetcher as sf

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
WINDOW_DIR = RAW_DIR / "satnogs_window"
KP_FILE = RAW_DIR / "kp_gfz.json"


def load_window_observations() -> list:
    """Legacy slice files plus the unified store, deduplicated by id (store wins)."""
    obs = {}
    for path in sorted(WINDOW_DIR.glob("*_*.json")) if WINDOW_DIR.exists() else []:
        payload = json.load(open(path))
        for o in payload["observations"]:
            o["fetched_at"] = payload.get("fetched_at")
            obs.setdefault(o["id"], o)
    for o in sf.iter_store_observations():
        obs[o["id"]] = o
    return list(obs.values())


def fetch_kp_history(start_day: datetime) -> Path:
    """Refresh Kp in the unified store and mirror it to the legacy `kp_gfz.json` layout."""
    sess = sf.RateLimitedSession(sf.load_state())
    sf.refresh_kp(sess, days_back=max(10, (datetime.now(timezone.utc) - start_day).days + 2))
    kp = json.load(open(sf.KP_FILE))["kp"]
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with open(KP_FILE, "w") as f:
        json.dump({"datetime": list(kp), "kp": [v["kp"] for v in kp.values()]}, f)
    return KP_FILE


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--window", nargs=2, metavar=("START", "END"), help="YYYY-MM-DDTHH:MM UTC")
    p.add_argument("--start", help="first UTC day (YYYY-MM-DD)")
    p.add_argument("--end", help="last UTC day (YYYY-MM-DD), inclusive")
    p.add_argument("--hours-per-day", type=int, default=24)
    args = p.parse_args()
    if args.window:
        return sf.main(["window", args.window[0][:13], args.window[1][:13]])
    if args.start:
        start = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end = datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc) if args.end else start
        day = start
        while day <= end:
            offset = 0 if args.hours_per_day >= 24 else (day.toordinal() * 7) % 24
            s = day + timedelta(hours=offset)
            sf.main(["window", f"{s:%Y-%m-%dT%H}", f"{s + timedelta(hours=min(args.hours_per_day, 24)):%Y-%m-%dT%H}"])
            day += timedelta(days=1)
        return 0
    return sf.main(["daemon"])


if __name__ == "__main__":
    sys.exit(main())
