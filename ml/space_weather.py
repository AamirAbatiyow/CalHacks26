"""
Planetary Kp history for pass-time space-weather features.

NOAA SWPC only serves the last ~30 days of 3-hourly planetary Kp over HTTPS
(``daily-geomagnetic-indices.txt``); its quarterly archive is FTP-only and
was unreachable from our environment. For the full year we therefore use the
definitive Kp series from GFZ Potsdam (the official Kp producer, whose values
NOAA's "estimated planetary Kp" approximates), and use the NOAA 30-day file to
cross-check agreement and to fill the most recent days GFZ has not published.
"""

import json
import re
from bisect import bisect_right
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import requests

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
KP_FILE = RAW_DIR / "kp_3h.json"

GFZ_URL = "https://kp.gfz.de/app/json/"
NOAA_DGD_URL = "https://services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt"


def _fetch_gfz(start: datetime, end: datetime) -> Dict[str, float]:
    out = {}
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=120), end)
        r = requests.get(GFZ_URL, params={
            "start": cur.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "end": nxt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "index": "Kp",
        }, timeout=60)
        r.raise_for_status()
        d = r.json()
        for t, k in zip(d.get("datetime", []), d.get("Kp", [])):
            if k is not None and k >= 0:
                out[t] = float(k)
        cur = nxt
    return out


def _fetch_noaa_dgd() -> Dict[str, float]:
    r = requests.get(NOAA_DGD_URL, timeout=60)
    r.raise_for_status()
    out = {}
    for line in r.text.splitlines():
        if not re.match(r"^\d{4} \d{2} \d{2}", line):
            continue
        parts = line.split()
        day = datetime(int(parts[0]), int(parts[1]), int(parts[2]), tzinfo=timezone.utc)
        kps = [float(x) for x in parts[-8:]]
        for i, k in enumerate(kps):
            if k >= 0:
                out[(day + timedelta(hours=3 * i)).strftime("%Y-%m-%dT%H:%M:%SZ")] = k
    return out


def fetch_kp_history(start: datetime, end: datetime) -> dict:
    gfz = _fetch_gfz(start, end)
    try:
        noaa = _fetch_noaa_dgd()
    except requests.RequestException:
        noaa = {}
    common = sorted(set(gfz) & set(noaa))
    agreement = None
    if common:
        diff = np.array([abs(gfz[t] - noaa[t]) for t in common])
        agreement = {
            "n_overlap_3h_slots": len(common),
            "mean_abs_diff": float(diff.mean()),
            "share_within_one_third": float((diff <= 0.34).mean()),
        }
    merged = dict(gfz)
    source = {t: "gfz" for t in gfz}
    for t, k in noaa.items():
        if t not in merged:
            merged[t] = k
            source[t] = "noaa_swpc"
    series = [{"time": t, "kp": merged[t], "source": source[t]} for t in sorted(merged)]
    payload = {"series": series, "noaa_gfz_agreement": agreement}
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with open(KP_FILE, "w") as f:
        json.dump(payload, f)
    n_noaa = sum(1 for s in series if s["source"] == "noaa_swpc")
    print(f"Kp: {len(series)} 3-hour slots ({n_noaa} NOAA-only); NOAA vs GFZ: {agreement}")
    return payload


class KpLookup:
    """Kp at a time, and max Kp over the preceding 24 h (both pass-time-known)."""

    def __init__(self, path: Path = KP_FILE):
        d = json.load(open(path))
        self.times: List[float] = []
        self.kp: List[float] = []
        for s in d["series"]:
            t = datetime.strptime(s["time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            self.times.append(t.timestamp())
            self.kp.append(s["kp"])
        self.kp_arr = np.array(self.kp)

    def at(self, ts: float) -> Optional[float]:
        i = bisect_right(self.times, ts) - 1
        if i < 0 or ts - self.times[i] > 3 * 3600:
            return None
        return self.kp[i]

    def max_prev_24h(self, ts: float) -> Optional[float]:
        hi = bisect_right(self.times, ts)
        lo = bisect_right(self.times, ts - 24 * 3600)
        if hi <= lo:
            return None
        return float(self.kp_arr[lo:hi].max())
