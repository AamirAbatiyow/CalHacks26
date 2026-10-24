#!/usr/bin/env python3
"""
Fetch SatNOGS observations for ML training, unfiltered by status.

Every observation in each time slice is fetched, whatever its status
(good / bad / failed / unknown), one file per slice. This keeps the class
ratio natural and gives every class the same time coverage. Anonymous access
is limited to about 1,500 observations an hour, so sampling a few hours per
day buys more date coverage than fetching whole days.

The earlier version fetched each status separately, newest first, until a
per-status quota (2,000 good / 1,000 bad / 500 failed) was hit. That fixed
the class ratio by hand and gave each class a different time window (bad
reached back ~34h, good ~27h, failed ~12h), so any time-varying feature
(Kp, hour of day) leaked the label. `--legacy-by-status` keeps that mode
only for reproducing the v1.1.0 dataset.

Usage:
    python -m ml.fetch_labeled --start 2026-10-05 --end 2026-10-22 --hours-per-day 2
    python -m ml.fetch_labeled --window 2026-10-24T00:00 2026-10-24T06:00
"""

import argparse
import json
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

SATNOGS_API = "https://network.satnogs.org/api"
RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
WINDOW_DIR = RAW_DIR / "satnogs_window"
LEGACY_FILE = RAW_DIR / "satnogs_observations_labeled.json"

KEEP_FIELDS = [
    "id", "start", "end", "ground_station", "norad_cat_id", "station_name",
    "station_lat", "station_lng", "station_alt", "status", "waterfall_status",
    "vetted_user", "vetted_datetime", "rise_azimuth", "set_azimuth",
    "max_altitude", "transmitter_uuid", "transmitter_mode", "transmitter_baud",
    "transmitter_downlink_low", "transmitter_status", "transmitter_unconfirmed",
    "tle0", "tle1", "tle2", "tle_source", "observation_frequency",
    "client_version", "observer",
]

# Anonymous API access allows roughly 60 requests (1,500 observations) per hour;
# beyond that the server answers 429 with a Retry-After close to an hour.
REQUEST_INTERVAL_S = 1.2


def slim(obs: dict) -> dict:
    out = {k: obs.get(k) for k in KEEP_FIELDS}
    out["has_payload"] = bool(obs.get("payload"))
    out["has_waterfall"] = bool(obs.get("waterfall"))
    out["n_demoddata"] = len(obs.get("demoddata") or [])
    return out


def _next_link(response: requests.Response):
    for part in response.headers.get("Link", "").split(","):
        if 'rel="next"' in part:
            url = part.split(";")[0].strip()
            if url.startswith("<") and url.endswith(">"):
                return url[1:-1]
    return None


_stats = Counter()


def _get(session: requests.Session, url: str, params=None, max_retries: int = 12):
    delay = 5
    for _ in range(max_retries):
        time.sleep(REQUEST_INTERVAL_S)
        try:
            r = session.get(url, params=params, timeout=90)
        except requests.RequestException as e:
            print(f"  network error: {e}; retry in {delay}s", flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 180)
            continue
        _stats["requests"] += 1
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", delay))
            print(f"  429 after {_stats['requests']} requests; waiting {wait}s", flush=True)
            time.sleep(wait + 1)
            delay = min(delay * 2, 180)
            continue
        if r.status_code >= 500:
            print(f"  HTTP {r.status_code}; retry in {delay}s", flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 180)
            continue
        r.raise_for_status()
        return r
    raise RuntimeError(f"giving up on {url}")


def fetch_window(session, start: datetime, end: datetime, partial_path: Path) -> list:
    """Fetch every observation whose start time lies in [start, end).

    Progress is checkpointed to `partial_path` so a rate-limit stall or crash
    resumes from the last page instead of the start of the day.
    """
    params = {
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "format": "json",
    }
    url, out, first = f"{SATNOGS_API}/observations/", [], True
    if partial_path.exists():
        state = json.load(open(partial_path))
        url, out, first = state["next_url"], state["observations"], False
        print(f"  resuming with {len(out)} observations", flush=True)
    seen = {o["id"] for o in out}
    pages = 0
    while url:
        r = _get(session, url, params=params if first else None)
        first = False
        for obs in r.json():
            if obs["id"] not in seen:
                seen.add(obs["id"])
                out.append(slim(obs))
        url = _next_link(r)
        pages += 1
        if pages % 20 == 0 and url:
            with open(partial_path, "w") as f:
                json.dump({"next_url": url, "observations": out}, f)
            print(f"  {pages} pages, {len(out)} obs, oldest {out[-1]['start']}", flush=True)
    partial_path.unlink(missing_ok=True)
    return out


def _slice_name(start: datetime, end: datetime) -> str:
    return f"{start:%Y%m%dT%H%M}_{end:%Y%m%dT%H%M}"


def fetch_slices(slices, refresh: bool = False) -> Counter:
    """Fetch each [start, end) slice into its own file; cached slices are skipped."""
    WINDOW_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    totals = Counter()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    for start, end in slices:
        # Scheduled ("future") passes carry no label; don't spend rate limit on them.
        end = min(end, now)
        if end <= start:
            continue
        name = _slice_name(start, end)
        path = WINDOW_DIR / f"{name}.json"
        if path.exists() and not refresh:
            obs = json.load(open(path))["observations"]
            print(f"{name}: cached {len(obs)}", flush=True)
        else:
            t0 = time.time()
            obs = fetch_window(session, start, end, WINDOW_DIR / f"{name}.partial")
            with open(path, "w") as f:
                json.dump({
                    "window_start": start.isoformat(),
                    "window_end": end.isoformat(),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "observations": obs,
                }, f)
            print(f"{name}: fetched {len(obs)} in {time.time() - t0:.0f}s "
                  f"{dict(Counter(o['status'] for o in obs))}", flush=True)
        totals.update(o["status"] for o in obs)
    return totals


def daily_slices(start_day: datetime, end_day: datetime, hours_per_day: int):
    """One slice per day, newest day first.

    With fewer than 24 hours per day the slice start rotates by 7h a day so
    the sample covers all local times of day across the date range.
    """
    day = end_day
    while day >= start_day:
        offset = 0 if hours_per_day >= 24 else (day.toordinal() * 7) % 24
        start = day + timedelta(hours=offset)
        yield start, start + timedelta(hours=min(hours_per_day, 24))
        day -= timedelta(days=1)


def load_window_observations() -> list:
    obs, seen = [], set()
    for path in sorted(WINDOW_DIR.glob("*_*.json")):
        payload = json.load(open(path))
        fetched_at = payload.get("fetched_at")
        for o in payload["observations"]:
            if o["id"] in seen:
                continue
            seen.add(o["id"])
            o["fetched_at"] = fetched_at
            obs.append(o)
    return obs


def fetch_by_status_legacy(status: str, limit: int, days_back: int = 365) -> list:
    """Reproduces the v1.1.0 per-status quota fetch. Biased; see module docstring."""
    session = requests.Session()
    end = datetime.now(timezone.utc)
    params = {
        "start": (end - timedelta(days=days_back)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": status,
        "format": "json",
    }
    url = f"{SATNOGS_API}/observations/"
    out, first = [], True
    while url and len(out) < limit:
        r = _get(session, url, params=params if first else None)
        first = False
        out.extend(slim(o) for o in r.json())
        url = _next_link(r)
    return out[:limit]


GFZ_KP_URL = "https://kp.gfz.de/app/json/"
KP_FILE = RAW_DIR / "kp_gfz.json"


def fetch_kp_history(start_day: datetime) -> Path:
    """3-hourly Kp from GFZ Potsdam, start_day through now (SWPC only serves ~7 days)."""
    if KP_FILE.exists():
        first = json.load(open(KP_FILE))["datetime"][0][:10]
        start_day = min(start_day, datetime.strptime(first, "%Y-%m-%d").replace(tzinfo=timezone.utc))
    r = requests.get(GFZ_KP_URL, params={
        "start": start_day.strftime("%Y-%m-%dT00:00:00Z"),
        "end": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "index": "Kp",
    }, timeout=60)
    r.raise_for_status()
    payload = r.json()
    with open(KP_FILE, "w") as f:
        json.dump({"datetime": payload["datetime"], "kp": payload["Kp"]}, f)
    print(f"Saved {len(payload['Kp'])} Kp values to {KP_FILE}")
    return KP_FILE


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--start", help="First UTC day (YYYY-MM-DD)")
    parser.add_argument("--end", help="Last UTC day (YYYY-MM-DD), inclusive")
    parser.add_argument("--hours-per-day", type=int, default=24,
                        help="Hours sampled per day (rotating start hour when < 24)")
    parser.add_argument("--window", nargs=2, metavar=("START", "END"),
                        help="Single window, YYYY-MM-DDTHH:MM UTC")
    parser.add_argument("--refresh", action="store_true", help="Refetch cached slices")
    parser.add_argument("--legacy-by-status", action="store_true")
    args = parser.parse_args()

    if args.legacy_by_status:
        obs = []
        for status, limit in [("good", 2000), ("bad", 1000), ("failed", 500)]:
            obs.extend(fetch_by_status_legacy(status, limit))
        with open(LEGACY_FILE, "w") as f:
            json.dump(obs, f)
        print(f"Saved {len(obs)} to {LEGACY_FILE}")
        return 0

    if args.window:
        start, end = (datetime.strptime(x, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
                      for x in args.window)
        slices = [(start, end)]
        fetch_kp_history(start)
    else:
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        end_day = datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc) if args.end else today
        start_day = (datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                     if args.start else end_day - timedelta(days=6))
        slices = list(daily_slices(start_day, end_day, args.hours_per_day))
        fetch_kp_history(start_day)
    totals = fetch_slices(slices, refresh=args.refresh)
    print(f"Total by status: {dict(totals)}")
    labeled = sum(totals[s] for s in ("good", "bad", "failed"))
    print(f"Labeled (good/bad/failed): {labeled}")
    return 0 if labeled else 1


if __name__ == "__main__":
    sys.exit(main())
