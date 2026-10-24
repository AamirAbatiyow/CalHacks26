#!/usr/bin/env python3
"""
Time-uniform SatNOGS fetch: every status from the same time windows.

The original labeled fetch (fetch_labeled.py) pulled the newest N passes per
status, so each class covered a different time span and anything time-indexed
(Kp, start_time, pass_id) leaked the label. Here we pull *all* observations in
a set of contiguous blocks spread across several weeks, with no status filter,
so the class mix inside each block is the network's real mix. Contiguous
blocks also give every station a dense, ordered history for past-only
station-health features.

Every API page is cached to disk, so the script is resumable and obeys
Retry-After on 429 without giving up.

Usage:
    python -m ml.fetch_uniform                       # observations (slow; rate limited)
    python -m ml.fetch_uniform --side-data-only      # stations, DB transmitters/satellites, Kp
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

NETWORK_API = "https://network.satnogs.org/api"
DB_API = "https://db.satnogs.org/api"
KP_API = "https://kp.gfz.de/app/json/"

ROOT = Path(__file__).parent.parent / "data"
CACHE = ROOT / "raw" / "uniform_cache"
SIDE = ROOT / "raw" / "uniform_side_cache"

session = requests.Session()
session.headers["User-Agent"] = "ground-truth-research (calhacks)"


def _get(url: str, params: dict | None = None, min_interval: float = 3.0) -> requests.Response:
    while True:
        try:
            r = session.get(url, params=params, timeout=90)
        except requests.RequestException as e:
            print(f"  network error {e}; sleeping 30s", flush=True)
            time.sleep(30)
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "60")) + 5
            print(f"  429 at {datetime.now(timezone.utc):%H:%M:%S}; sleeping {wait}s", flush=True)
            time.sleep(wait)
            continue
        if r.status_code >= 500:
            print(f"  HTTP {r.status_code}; sleeping 60s", flush=True)
            time.sleep(60)
            continue
        r.raise_for_status()
        time.sleep(min_interval)
        return r


def _next_link(r: requests.Response) -> str | None:
    for part in r.headers.get("Link", "").split(","):
        if 'rel="next"' in part:
            return part.split(";")[0].strip().strip("<>")
    return None


def make_blocks(n_blocks: int, block_hours: float, days_back: int, min_age_days: int, seed: int) -> list[tuple[datetime, datetime]]:
    """Evenly spaced blocks with a random start hour so time of day is spread."""
    rng = np.random.default_rng(seed)
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    newest = now - timedelta(days=min_age_days)
    oldest = now - timedelta(days=days_back)
    span = (newest - oldest) / n_blocks
    blocks = []
    for i in range(n_blocks):
        base = oldest + span * i
        offset = timedelta(hours=int(rng.integers(0, 24)))
        start = base + offset
        blocks.append((start, start + timedelta(hours=block_hours)))
    return blocks


def fetch_block(start: datetime, end: datetime) -> int:
    tag = f"{start:%Y%m%dT%H}_{end:%Y%m%dT%H}"
    bdir = CACHE / tag
    bdir.mkdir(parents=True, exist_ok=True)
    done = bdir / "DONE"
    if done.exists():
        return sum(len(json.loads(p.read_text())) for p in bdir.glob("page_*.json"))

    url = f"{NETWORK_API}/observations/"
    params = {"start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"), "format": "json"}
    page, n = 0, 0
    state = bdir / "next.json"
    if state.exists():
        s = json.loads(state.read_text())
        url, page, params = s["url"], s["page"], None
        n = sum(len(json.loads(p.read_text())) for p in bdir.glob("page_*.json"))
    while url:
        r = _get(url, params)
        data = r.json()
        (bdir / f"page_{page:04d}.json").write_text(json.dumps(data))
        n += len(data)
        page += 1
        url, params = _next_link(r), None
        state.write_text(json.dumps({"url": url, "page": page}))
        if page % 10 == 0:
            print(f"  {tag}: page {page}, {n} obs", flush=True)
        if not data:
            break
    done.write_text(str(n))
    print(f"  {tag}: done, {n} obs", flush=True)
    return n


def fetch_side_data(kp_start: datetime, kp_end: datetime) -> None:
    SIDE.mkdir(parents=True, exist_ok=True)
    targets = {
        "stations.json": (f"{NETWORK_API}/stations/", {"format": "json"}),
        "db_transmitters.json": (f"{DB_API}/transmitters/", {"format": "json"}),
        "db_satellites.json": (f"{DB_API}/satellites/", {"format": "json"}),
    }
    for name, (url, params) in targets.items():
        out = SIDE / name
        if out.exists():
            continue
        rows, p = [], params
        while url:
            r = _get(url, p, min_interval=1.0)
            rows.extend(r.json())
            url, p = _next_link(r), None
        out.write_text(json.dumps(rows))
        print(f"  {name}: {len(rows)} rows", flush=True)

    kp_out = SIDE / "kp_gfz.json"
    r = _get(KP_API, {"start": kp_start.strftime("%Y-%m-%dT00:00:00Z"),
                      "end": kp_end.strftime("%Y-%m-%dT23:59:59Z"), "index": "Kp"}, min_interval=0.5)
    kp_out.write_text(r.text)
    print(f"  kp_gfz.json: {len(r.json().get('Kp', []))} 3-hour values", flush=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--blocks", type=int, default=10)
    p.add_argument("--block-hours", type=float, default=8)
    p.add_argument("--days-back", type=int, default=63)
    p.add_argument("--min-age-days", type=int, default=5, help="skip recent days that are not vetted yet")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--side-data-only", action="store_true")
    args = p.parse_args()

    blocks = make_blocks(args.blocks, args.block_hours, args.days_back, args.min_age_days, args.seed)
    fetch_side_data(blocks[0][0] - timedelta(days=2), blocks[-1][1] + timedelta(days=1))
    if args.side_data_only:
        return 0
    total = 0
    for i, (s, e) in enumerate(blocks):
        print(f"block {i + 1}/{len(blocks)}: {s:%Y-%m-%d %H:%M} -> {e:%Y-%m-%d %H:%M}", flush=True)
        total += fetch_block(s, e)
        print(f"total so far: {total}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
