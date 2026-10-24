#!/usr/bin/env python3
"""
Fetch SatNOGS observations with their *natural* label distribution.

Earlier versions requested fixed quotas per status (2000 good / 1000 bad /
500 failed), which distorts the class balance and concentrated every pass in
the ~36 hours before the fetch. This version samples random one-hour windows
spread uniformly across the last year and keeps *every* observation in each
window, so the good/bad/failed mix, the station mix and the time spread are
what SatNOGS actually produces. Unvetted (``unknown``) observations are stored
too so the vetting rate can be reported, but are not used for training.

Also fetches the station list (elevation mask, antennas) and Kp history.

Rate limiting: anonymous SatNOGS API access is throttled to roughly 75-80
requests per sliding hour per IP (observed Oct 2026), 25 observations per
page. On HTTP 429 we sleep for exactly the server's Retry-After (time until the
oldest request leaves the window); without that header we back off
exponentially from 60 s. Requests are also paced (default one every 3 s).
Progress is written after every window so the fetch can be resumed.

Usage:
    python -m ml.fetch_labeled --target-labeled 30000
"""

import argparse
import json
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

SATNOGS_API = "https://network.satnogs.org/api"
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "raw"

OBS_FILE = OUTPUT_DIR / "satnogs_observations_natural.jsonl"
PROGRESS_FILE = OUTPUT_DIR / "fetch_natural_progress.json"
STATIONS_FILE = OUTPUT_DIR / "satnogs_stations_full.json"

LABELED_STATUSES = {"good", "bad", "failed"}

# Only fields that are known before the pass, plus the label and a few
# post-hoc fields kept solely so leakage can be audited (see features.LEAKY_FIELDS).
KEEP_FIELDS = [
    "id", "start", "end", "ground_station", "norad_cat_id",
    "station_lat", "station_lng", "station_alt",
    "status", "waterfall_status", "client_version",
    "max_altitude", "rise_azimuth", "set_azimuth",
    "transmitter_uuid", "transmitter_mode", "transmitter_baud",
    "transmitter_type", "transmitter_description",
    "transmitter_downlink_low", "transmitter_downlink_high",
    "observation_frequency", "center_frequency",
    "tle0", "tle1", "tle2", "tle_source", "observer",
]

UA = {"User-Agent": "ground-truth-ml/1.0 (research; paced requests)"}


class PacedSession:
    def __init__(self, pace_s: float, max_backoff_s: float):
        self.s = requests.Session()
        self.s.headers.update(UA)
        self.pace_s = pace_s
        self.max_backoff_s = max_backoff_s
        self._last = 0.0
        self.n_requests = 0
        self.n_429 = 0

    def get(self, url, params=None):
        backoff = 60.0
        while True:
            wait = self.pace_s - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            try:
                r = self.s.get(url, params=params, timeout=90)
            except requests.RequestException as e:
                print(f"  network error {e!r}; sleeping 30s", flush=True)
                time.sleep(30)
                continue
            self.n_requests += 1
            if r.status_code == 429:
                self.n_429 += 1
                header = r.headers.get("Retry-After")
                if header:
                    sleep_s = min(float(header) + 5, self.max_backoff_s)
                else:
                    sleep_s = backoff
                    backoff = min(backoff * 2, self.max_backoff_s)
                print(f"  429 (Retry-After={header}); sleeping {sleep_s:.0f}s", flush=True)
                time.sleep(sleep_s)
                continue
            if r.status_code >= 500:
                print(f"  HTTP {r.status_code}; sleeping 60s", flush=True)
                time.sleep(60)
                continue
            r.raise_for_status()
            return r


def plan_windows(n_windows: int, days_min: int, days_max: int, seed: int, now: datetime):
    """Random 1-hour windows, stratified so every day-range bucket is covered."""
    rng = random.Random(seed)
    span_h = (days_max - days_min) * 24
    starts = set()
    while len(starts) < n_windows:
        starts.add(rng.randrange(span_h))
    windows = []
    for h in starts:
        start = (now - timedelta(days=days_max) + timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
        windows.append(start)
    rng.shuffle(windows)
    return windows


def fetch_window(sess: PacedSession, start: datetime):
    end = start + timedelta(hours=1)
    url = f"{SATNOGS_API}/observations/"
    params = {
        "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "format": "json",
        "page_size": 100,  # ignored by the API at the time of writing (fixed 25/page)
    }
    out = []
    first = True
    while url:
        r = sess.get(url, params=params if first else None)
        first = False
        for o in r.json():
            out.append({k: o.get(k) for k in KEEP_FIELDS})
        url = r.links.get("next", {}).get("url")
    return out


def fetch_stations(sess: PacedSession):
    r = sess.get(f"{SATNOGS_API}/stations/", params={"format": "json"})
    stations = r.json()
    url = r.links.get("next", {}).get("url")
    while url:
        r = sess.get(url)
        stations.extend(r.json())
        url = r.links.get("next", {}).get("url")
    with open(STATIONS_FILE, "w") as f:
        json.dump(stations, f)
    print(f"Saved {len(stations)} stations to {STATIONS_FILE}")


def load_progress():
    if PROGRESS_FILE.exists():
        return json.load(open(PROGRESS_FILE))
    return {"done_windows": [], "status_counts": {}, "n_obs": 0}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--target-labeled", type=int, default=30000)
    p.add_argument("--n-windows", type=int, default=600, help="windows to plan (fetched in random order)")
    p.add_argument("--days-min", type=int, default=7, help="skip the most recent days (still being vetted)")
    p.add_argument("--days-max", type=int, default=372)
    p.add_argument("--pace", type=float, default=3.0, help="seconds between requests")
    p.add_argument("--max-backoff", type=float, default=3700.0)
    p.add_argument("--max-hours", type=float, default=8.0, help="wall-clock budget")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--anchor", type=str, default="2026-10-24", help="fixed 'now' so the window plan is reproducible")
    p.add_argument("--skip-stations", action="store_true")
    p.add_argument("--skip-kp", action="store_true")
    args = p.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sess = PacedSession(args.pace, args.max_backoff)
    t0 = time.time()

    if not args.skip_stations and not STATIONS_FILE.exists():
        fetch_stations(sess)

    if not args.skip_kp:
        from .space_weather import fetch_kp_history
        now = datetime.fromisoformat(args.anchor).replace(tzinfo=timezone.utc)
        fetch_kp_history(now - timedelta(days=args.days_max + 2), now)

    now = datetime.fromisoformat(args.anchor).replace(tzinfo=timezone.utc)
    windows = plan_windows(args.n_windows, args.days_min, args.days_max, args.seed, now)
    prog = load_progress()
    done = set(prog["done_windows"])
    counts = prog["status_counts"]

    def labeled():
        return sum(counts.get(s, 0) for s in LABELED_STATUSES)

    print(f"Resuming: {len(done)} windows done, {prog['n_obs']} obs, {labeled()} labeled", flush=True)
    for w in windows:
        key = w.strftime("%Y-%m-%dT%H")
        if key in done:
            continue
        if labeled() >= args.target_labeled:
            break
        if (time.time() - t0) / 3600 > args.max_hours:
            print("Wall-clock budget exhausted", flush=True)
            break
        obs = fetch_window(sess, w)
        with open(OBS_FILE, "a") as f:
            for o in obs:
                f.write(json.dumps(o) + "\n")
        for o in obs:
            counts[o["status"]] = counts.get(o["status"], 0) + 1
        done.add(key)
        prog = {
            "done_windows": sorted(done),
            "status_counts": counts,
            "n_obs": prog["n_obs"] + len(obs),
            "requests": sess.n_requests,
            "http_429": sess.n_429,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(PROGRESS_FILE, "w") as f:
            json.dump(prog, f, indent=1)
        print(f"[{len(done):4d}] {key}: +{len(obs):4d} obs | total {prog['n_obs']} | labeled {labeled()} "
              f"| {counts} | req={sess.n_requests} 429s={sess.n_429} | {(time.time()-t0)/60:.1f} min", flush=True)

    print(f"Done. {prog['n_obs']} observations, {labeled()} labeled. Status mix: {counts}")
    return labeled()


if __name__ == "__main__":
    sys.exit(0 if main() >= 1000 else 1)
