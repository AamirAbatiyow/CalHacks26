#!/usr/bin/env python3
"""
Unified, resumable, rate-limit-aware SatNOGS collector (replaces the three
earlier fetchers: per-slice `fetch_labeled`, block `fetch_uniform`, and the
random-window natural fetcher).

Everything lands in one on-disk store, one file per complete UTC hour:

    data/raw/satnogs_store/hours/YYYYMMDDTHH.json   every observation, every status
    data/raw/satnogs_store/hours/YYYYMMDDTHH.partial checkpoint (next cursor + rows)
    data/raw/satnogs_store/stations.json            station metadata, fetched per new id
    data/raw/satnogs_store/kp.json                  GFZ definitive + NOAA SWPC recent Kp
    data/raw/satnogs_store/tle_latest.json          SatNOGS DB TLE snapshot (+ history dir)
    data/raw/satnogs_store/state.json               request log, 429 count, crawl edges

Whole hours are fetched with no status filter, so the store holds every
station's complete pass history for the covered span. That is what the causal
station / satellite / transmitter history features need. Observations are
deduplicated by id when loaded (`load_store`).

Crawl order (`daemon`):
1. forward edge: hours between the newest stored hour and now - settle_hours
   (labels need time: `failed`/`good` within hours, `bad` waits for a vetter);
2. backfill: extend the contiguous span backwards.
3. optional relabel: hours first fetched while younger than `--relabel-after-days`
   are fetched again once they are older, so vetting that happened later is kept.

Rate limits: anonymous access allows ~60-80 requests per sliding hour; the
server answers 429 with a Retry-After of up to an hour. Requests are spread
evenly under a rolling-hour budget (persisted across restarts), and a 429
lowers the budget and sleeps for the server's Retry-After. The daemon is meant
to run in the background (see `ml/run_collector.sh`, `ml/systemd/`).

Usage:
    python -m ml.satnogs_fetcher daemon                    # run forever
    python -m ml.satnogs_fetcher daemon --max-requests 40  # bounded run
    python -m ml.satnogs_fetcher window 2026-10-20T00 2026-10-20T06
    python -m ml.satnogs_fetcher random-windows --n 20 --days-min 7 --days-max 300
    python -m ml.satnogs_fetcher import-legacy              # fold old fetcher caches in
    python -m ml.satnogs_fetcher status
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

import requests

NETWORK_API = "https://network.satnogs.org/api"
DB_API = "https://db.satnogs.org/api"
GFZ_KP_URL = "https://kp.gfz.de/app/json/"
NOAA_KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
STORE = Path(os.environ.get("GT_SATNOGS_STORE", DATA / "raw" / "satnogs_store"))
HOURS = STORE / "hours"
STATE_FILE = STORE / "state.json"
STATIONS_FILE = STORE / "stations.json"
KP_FILE = STORE / "kp.json"
TLE_FILE = STORE / "tle_latest.json"
TLE_HISTORY = STORE / "tle_history"
LOG_FILE = STORE / "collector.log"

LABELED = ("good", "bad", "failed")

# Pre-pass fields, the label, and the timestamps needed to model label latency.
# Post-pass artifacts (waterfall, payload, demoddata, client_metadata) are reduced
# to booleans for auditing and never used as features.
KEEP_FIELDS = [
    "id", "start", "end", "ground_station", "norad_cat_id", "sat_id", "station_name",
    "station_lat", "station_lng", "station_alt", "status", "waterfall_status",
    "waterfall_status_datetime", "vetted_datetime", "vetted_user",
    "rise_azimuth", "set_azimuth", "max_altitude",
    "transmitter_uuid", "transmitter_mode", "transmitter_baud", "transmitter_type",
    "transmitter_description", "transmitter_status", "transmitter_unconfirmed",
    "transmitter_updated", "transmitter_downlink_low", "transmitter_downlink_high",
    "observation_frequency", "center_frequency",
    "tle0", "tle1", "tle2", "tle_source", "client_version", "observer",
]

UA = {"User-Agent": "ground-truth-ml/2.0 (research; paced, caches every page)"}


def log(msg: str) -> None:
    line = f"[{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}Z] {msg}"
    print(line, flush=True)
    try:
        STORE.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def slim(obs: dict) -> dict:
    out = {k: obs.get(k) for k in KEEP_FIELDS}
    out["has_payload"] = bool(obs.get("payload"))
    out["has_waterfall"] = bool(obs.get("waterfall"))
    out["n_demoddata"] = len(obs.get("demoddata") or [])
    return out


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _hour_key(t: datetime) -> str:
    return t.strftime("%Y%m%dT%H")


def _parse_hour(key: str) -> datetime:
    return datetime.strptime(key, "%Y%m%dT%H").replace(tzinfo=timezone.utc)


def _atomic_write(path: Path, payload) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- state


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.load(open(STATE_FILE))
        except json.JSONDecodeError:
            pass
    return {"request_times": [], "n_requests": 0, "n_429": 0, "budget_per_hour": 70,
            "last_429": None, "last_kp": None, "last_tle": None, "last_retrain": None,
            "last_retrain_labeled": 0, "relabeled": []}


def save_state(state: dict) -> None:
    STORE.mkdir(parents=True, exist_ok=True)
    _atomic_write(STATE_FILE, state)


class RateLimitedSession:
    """Rolling-hour request budget shared by every SatNOGS Network request.

    Requests are spread evenly (3600 / budget seconds apart) instead of
    bursting into a 429 and then stalling for an hour. On 429 the budget drops
    by 15% (floor 20/h) and we sleep the server's Retry-After; after two hours
    without a 429 it creeps back up by one request per hour (cap 80/h).
    """

    def __init__(self, state: dict, max_sleep_s: float = 3700.0, sleep=time.sleep):
        self.state = state
        self.s = requests.Session()
        self.s.headers.update(UA)
        self.max_sleep_s = max_sleep_s
        self.sleep = sleep

    def _prune(self, now: float) -> list:
        times = [t for t in self.state["request_times"] if now - t < 3600]
        self.state["request_times"] = times
        return times

    def wait_time(self, now: Optional[float] = None) -> float:
        now = time.time() if now is None else now
        times = self._prune(now)
        budget = max(1, int(self.state.get("budget_per_hour", 70)))
        spacing = 3600.0 / budget
        wait = 0.0
        if times:
            wait = max(wait, times[-1] + spacing - now)
        if len(times) >= budget:
            wait = max(wait, times[len(times) - budget] + 3600 - now)
        return max(0.0, wait)

    def _maybe_raise_budget(self, now: float) -> None:
        last = self.state.get("last_429")
        if last is None or now - last > 7200:
            b = self.state.get("budget_per_hour", 70)
            if b < 80 and now - self.state.get("last_budget_bump", 0) > 3600:
                self.state["budget_per_hour"] = b + 1
                self.state["last_budget_bump"] = now

    def get(self, url: str, params: Optional[dict] = None, network: bool = True,
            max_attempts: int = 50) -> requests.Response:
        backoff = 30.0
        for _ in range(max_attempts):
            if network:
                w = self.wait_time()
                if w > 0:
                    self.sleep(w)
                now = time.time()
                self.state["request_times"].append(now)
                self.state["n_requests"] = self.state.get("n_requests", 0) + 1
            try:
                r = self.s.get(url, params=params, timeout=90)
            except requests.RequestException as e:
                log(f"network error {e!r}; retry in {backoff:.0f}s")
                self.sleep(backoff)
                backoff = min(backoff * 2, 900)
                continue
            if r.status_code == 429:
                now = time.time()
                self.state["n_429"] = self.state.get("n_429", 0) + 1
                self.state["last_429"] = now
                self.state["budget_per_hour"] = max(20, int(self.state.get("budget_per_hour", 70) * 0.85))
                ra = r.headers.get("Retry-After")
                wait = min(float(ra) + 5, self.max_sleep_s) if ra else backoff
                backoff = min(backoff * 2, self.max_sleep_s)
                log(f"429 (Retry-After={ra}); budget now {self.state['budget_per_hour']}/h; sleeping {wait:.0f}s")
                save_state(self.state)
                self.sleep(wait)
                continue
            if r.status_code >= 500:
                log(f"HTTP {r.status_code} on {url}; retry in {backoff:.0f}s")
                self.sleep(backoff)
                backoff = min(backoff * 2, 900)
                continue
            r.raise_for_status()
            if network:
                self._maybe_raise_budget(time.time())
            return r
        raise RuntimeError(f"giving up on {url}")


# --------------------------------------------------------------------------- hours


def hour_path(t: datetime) -> Path:
    return HOURS / f"{_hour_key(t)}.json"


def done_hours() -> list[datetime]:
    if not HOURS.exists():
        return []
    return sorted(_parse_hour(p.stem) for p in HOURS.glob("*.json") if not p.name.endswith(".tmp"))


def fetch_hour(sess: RateLimitedSession, t: datetime, refresh: bool = False,
               stop_after: Optional[float] = None) -> Optional[int]:
    """Fetch every observation with start in [t, t+1h). Returns count, or None if interrupted.

    Each page is checkpointed, so a stop (budget, signal, crash) resumes at the
    next cursor rather than the start of the hour.
    """
    HOURS.mkdir(parents=True, exist_ok=True)
    path, partial = hour_path(t), HOURS / f"{_hour_key(t)}.partial"
    if path.exists() and not refresh:
        return len(json.load(open(path))["observations"])
    params = {"start": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
              "end": (t + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "format": "json"}
    url, rows, first = f"{NETWORK_API}/observations/", [], True
    if partial.exists():
        st = json.load(open(partial))
        url, rows, first = st["next_url"], st["observations"], False
    seen = {o["id"] for o in rows}
    while url:
        if stop_after is not None and time.time() > stop_after:
            return None
        r = sess.get(url, params=params if first else None)
        first = False
        for o in r.json():
            if o.get("id") not in seen:
                seen.add(o["id"])
                rows.append(slim(o))
        url = r.links.get("next", {}).get("url")
        if url:
            _atomic_write(partial, {"next_url": url, "observations": rows})
        save_state(sess.state)
    _atomic_write(path, {"hour": t.isoformat(), "fetched_at": _utcnow().isoformat(),
                         "observations": rows})
    partial.unlink(missing_ok=True)
    return len(rows)


def next_hour_to_fetch(now: datetime, settle_hours: float, anchor: datetime,
                       relabel_after_days: Optional[float], state: dict) -> Optional[tuple[datetime, bool]]:
    """(hour, refresh) to fetch next, or None when caught up and fully backfilled to `anchor`."""
    newest_allowed = (now - timedelta(hours=settle_hours)).replace(minute=0, second=0, microsecond=0) \
        - timedelta(hours=1)
    have = set(done_hours())
    partials = sorted(_parse_hour(p.stem) for p in HOURS.glob("*.partial")) if HOURS.exists() else []
    for p in partials:
        if p not in have:
            return p, False
    if not have:
        return newest_allowed, False
    newest = max(have)
    if newest < newest_allowed:
        return newest + timedelta(hours=1), False
    if relabel_after_days:
        done_relabel = set(state.get("relabeled", []))
        for h in sorted(have):
            key = _hour_key(h)
            if key in done_relabel:
                continue
            try:
                fetched = datetime.fromisoformat(json.load(open(hour_path(h)))["fetched_at"])
            except (KeyError, ValueError, json.JSONDecodeError):
                continue
            age_at_fetch = (fetched - h).total_seconds() / 86400
            if age_at_fetch < relabel_after_days <= (now - h).total_seconds() / 86400:
                return h, True
    # Backfill: the newest gap below the newest hour, down to the anchor.
    h = newest - timedelta(hours=1)
    while h >= anchor:
        if h not in have:
            return h, False
        h -= timedelta(hours=1)
    return None


# --------------------------------------------------------------------------- side data


def seed_stations() -> int:
    """Seed the station file from committed snapshots so the crawl only fetches unknown ids.

    Full API records (PR #18 snapshot) are kept as-is; the older pipeline's
    `data/processed/stations.json` lacks antenna frequency ranges, so those
    entries are marked `partial` and upgraded a few per hour by the daemon.
    """
    have = {}
    if STATIONS_FILE.exists():
        have = {s["id"]: s for s in json.load(open(STATIONS_FILE))}
    n0 = len(have)
    full = DATA / "processed" / "satnogs_stations_natural.json"
    if full.exists():
        for s in json.load(open(full)):
            if s["id"] not in have or have[s["id"]].get("partial"):
                have[s["id"]] = s
    legacy = DATA / "processed" / "stations.json"
    if legacy.exists():
        for s in json.load(open(legacy)):
            if s.get("source") != "satnogs" or s["id"] in have:
                continue
            have[s["id"]] = {
                "id": s["id"], "altitude": s.get("altitude_m"), "min_horizon": s.get("min_horizon"),
                "created": s.get("created"), "lat": s.get("latitude"), "lng": s.get("longitude"),
                "antenna": [{"antenna_type": a, "band": b} for a, b in
                            zip(s.get("antennas") or [], (s.get("bands") or []) + [None] * 10)],
                "bands": s.get("bands") or [], "partial": True,
            }
    STORE.mkdir(parents=True, exist_ok=True)
    _atomic_write(STATIONS_FILE, list(have.values()))
    return len(have) - n0


def refresh_stations(sess: RateLimitedSession, wanted: Iterable[int], max_new: int = 25,
                     max_upgrade: int = 1) -> int:
    """Fetch metadata for station ids not yet in the store (one cheap request each)."""
    have = {}
    if STATIONS_FILE.exists():
        have = {s["id"]: s for s in json.load(open(STATIONS_FILE))}
    wanted = {int(i) for i in wanted if i is not None}
    missing = [i for i in wanted if i not in have][:max_new]
    missing += [i for i in wanted if i in have and have[i].get("partial")][:max_upgrade]
    for sid in missing:
        r = sess.get(f"{NETWORK_API}/stations/", params={"format": "json", "id": sid})
        for s in r.json():
            s["fetched_at"] = _utcnow().isoformat()
            have[s["id"]] = s
        if not r.json():
            have[sid] = {"id": sid, "missing": True, "fetched_at": _utcnow().isoformat()}
    if missing:
        STORE.mkdir(parents=True, exist_ok=True)
        _atomic_write(STATIONS_FILE, list(have.values()))
    return len(missing)


def refresh_kp(sess: RateLimitedSession, days_back: int = 400) -> int:
    """GFZ definitive Kp (full history, chunked) merged with NOAA SWPC's recent estimates."""
    merged = {}
    if KP_FILE.exists():
        merged = json.load(open(KP_FILE)).get("kp", {})
    end = _utcnow()
    start = end - timedelta(days=days_back if not merged else 10)
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=120), end)
        r = sess.get(GFZ_KP_URL, params={"start": cur.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                         "end": nxt.strftime("%Y-%m-%dT%H:%M:%SZ"), "index": "Kp"},
                     network=False)
        d = r.json()
        for t, k in zip(d.get("datetime", []), d.get("Kp", [])):
            if k is not None and k >= 0:
                merged[t] = {"kp": float(k), "src": "gfz"}
        cur = nxt
    try:
        rows = sess.get(NOAA_KP_URL, network=False).json()
        for row in rows:
            if isinstance(row, dict):
                t, k = row.get("time_tag"), row.get("Kp")
            else:
                t, k = (row[0], row[1]) if row and row[0] != "time_tag" else (None, None)
            if t is None or k is None:
                continue
            key = pd_iso(t)
            if key not in merged or merged[key]["src"] != "gfz":
                merged[key] = {"kp": float(k), "src": "noaa"}
    except Exception as e:  # NOAA is a top-up only
        log(f"NOAA Kp refresh failed: {e!r}")
    STORE.mkdir(parents=True, exist_ok=True)
    _atomic_write(KP_FILE, {"updated_at": _utcnow().isoformat(), "kp": dict(sorted(merged.items()))})
    return len(merged)


def pd_iso(t: str) -> str:
    t = t.replace(" ", "T")
    if len(t) == 19:
        t += "Z"
    return t.replace(".000", "")


def refresh_tles(sess: RateLimitedSession) -> int:
    """Latest TLE per satellite from SatNOGS DB, with a dated copy kept for causal lookups."""
    rows = sess.get(f"{DB_API}/tle/", params={"format": "json"}, network=False).json()
    STORE.mkdir(parents=True, exist_ok=True)
    TLE_HISTORY.mkdir(parents=True, exist_ok=True)
    _atomic_write(TLE_FILE, {"fetched_at": _utcnow().isoformat(), "tles": rows})
    slim_rows = [{k: r.get(k) for k in ("norad_cat_id", "tle1", "tle2", "updated")} for r in rows]
    _atomic_write(TLE_HISTORY / f"{_utcnow():%Y%m%dT%H}.json", slim_rows)
    return len(rows)


# --------------------------------------------------------------------------- loading


def iter_store_observations(include_legacy: bool = True) -> Iterable[dict]:
    """Yield stored observations, newest fetch winning on duplicate ids."""
    if HOURS.exists():
        for p in sorted(HOURS.glob("*.json")):
            payload = json.load(open(p))
            for o in payload["observations"]:
                o["fetched_at"] = payload.get("fetched_at")
                o["_source"] = "store"
                yield o


def load_store():
    import pandas as pd
    rows = {}
    for o in iter_store_observations():
        prev = rows.get(o["id"])
        if prev is None or (o.get("fetched_at") or "") >= (prev.get("fetched_at") or ""):
            rows[o["id"]] = o
    return pd.DataFrame(list(rows.values()))


def store_status() -> dict:
    hours = done_hours()
    counts, n, stations = Counter(), 0, set()
    for o in iter_store_observations():
        counts[o["status"]] += 1
        n += 1
        stations.add(o.get("ground_station"))
    state = load_state()
    contiguous = 0
    if hours:
        h = hours[-1]
        hs = set(hours)
        while h in hs:
            contiguous += 1
            h -= timedelta(hours=1)
    now = time.time()
    return {
        "hours_stored": len(hours),
        "oldest_hour": hours[0].isoformat() if hours else None,
        "newest_hour": hours[-1].isoformat() if hours else None,
        "contiguous_hours_from_newest": contiguous,
        "partial_hours": len(list(HOURS.glob("*.partial"))) if HOURS.exists() else 0,
        "observations": n,
        "labeled": sum(counts[s] for s in LABELED),
        "status_counts": dict(counts),
        "stations": len(stations),
        "requests_total": state.get("n_requests", 0),
        "requests_last_hour": len([t for t in state.get("request_times", []) if now - t < 3600]),
        "http_429_total": state.get("n_429", 0),
        "budget_per_hour": state.get("budget_per_hour"),
        "last_kp": state.get("last_kp"),
        "last_tle": state.get("last_tle"),
        "last_retrain": state.get("last_retrain"),
        "pid": state.get("pid"),
        "heartbeat": state.get("heartbeat"),
    }


# --------------------------------------------------------------------------- legacy import


def import_legacy() -> int:
    """Fold observations from the earlier fetchers' caches into the hour store.

    Only hours that the legacy source covered completely are written, so a
    partial legacy fetch never masquerades as a full hour of station history.
    Sources: `data/raw/satnogs_window/*.json` (per-slice), `data/raw/uniform_cache`
    (8h blocks, all-status variant only), `data/raw/satnogs_observations_natural.jsonl`
    (random one-hour windows, PR #18).
    """
    added = 0
    raw = DATA / "raw"
    groups: dict[datetime, list] = {}

    def add_complete(start: datetime, end: datetime, obs: list, fetched_at: Optional[str]):
        nonlocal added
        h = start.replace(minute=0, second=0, microsecond=0)
        if h < start:
            h += timedelta(hours=1)
        while h + timedelta(hours=1) <= end:
            path = hour_path(h)
            if not path.exists():
                rows = [o for o in obs if h.isoformat() <= _iso(o["start"]) < (h + timedelta(hours=1)).isoformat()]
                HOURS.mkdir(parents=True, exist_ok=True)
                _atomic_write(path, {"hour": h.isoformat(), "fetched_at": fetched_at or "1970-01-01T00:00:00+00:00",
                                     "observations": rows, "imported_from": "legacy"})
                added += 1
            h += timedelta(hours=1)

    for p in sorted((raw / "satnogs_window").glob("*_*.json")) if (raw / "satnogs_window").exists() else []:
        d = json.load(open(p))
        add_complete(datetime.fromisoformat(d["window_start"]), datetime.fromisoformat(d["window_end"]),
                     d["observations"], d.get("fetched_at"))
    natural = raw / "satnogs_observations_natural.jsonl"
    prog = raw / "fetch_natural_progress.json"
    if natural.exists() and prog.exists():
        done = json.load(open(prog))["done_windows"]
        obs = [json.loads(line) for line in open(natural)]
        for key in done:
            s = datetime.strptime(key, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
            add_complete(s, s + timedelta(hours=1), obs, None)
    ucache = raw / "uniform_cache"
    if ucache.exists():
        for bdir in ucache.glob("*/all"):
            if not (bdir / "DONE").exists():
                continue
            tag = bdir.parent.name
            s, e = (datetime.strptime(x, "%Y%m%dT%H").replace(tzinfo=timezone.utc) for x in tag.split("_"))
            obs = [slim(o) for p in sorted(bdir.glob("page_*.json")) for o in json.load(open(p))]
            add_complete(s, e, obs, None)
    return added


def _iso(t: str) -> str:
    return datetime.fromisoformat(t.replace("Z", "+00:00")).isoformat()


# --------------------------------------------------------------------------- daemon


def maybe_retrain(state: dict, every_hours: float, min_growth: float, min_labeled: int = 1500) -> None:
    """Scheduled retrain: refresh the model once enough new labels have arrived."""
    if every_hours <= 0:
        return
    now = time.time()
    last = state.get("last_retrain_ts") or 0
    if now - last < every_hours * 3600:
        return
    labeled = store_status()["labeled"]
    prev = state.get("last_retrain_labeled", 0) or 0
    if labeled < min_labeled or (prev and labeled < prev * (1 + min_growth)):
        state["last_retrain_ts"] = now
        return
    log(f"scheduled retrain: {labeled} labeled in store (was {prev})")
    cmd = [sys.executable, "-m", "ml.final_model", "retrain", "--scheduled"]
    res = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=3 * 3600)
    log(f"retrain exit {res.returncode}: {(res.stdout or '')[-400:]} {(res.stderr or '')[-400:]}")
    state["last_retrain_ts"] = now
    state["last_retrain"] = _utcnow().isoformat()
    state["last_retrain_labeled"] = labeled


def daemon(settle_hours: float, anchor: datetime, max_requests: Optional[int], max_hours: Optional[float],
           relabel_after_days: Optional[float], retrain_every_hours: float, retrain_min_growth: float,
           idle_sleep_s: float = 600) -> int:
    if not STATIONS_FILE.exists():
        seed_stations()
    state = load_state()
    state["pid"] = os.getpid()
    state["started_at"] = _utcnow().isoformat()
    sess = RateLimitedSession(state)
    start_requests = state.get("n_requests", 0)
    deadline = time.time() + max_hours * 3600 if max_hours else None
    log(f"collector start pid={os.getpid()} settle={settle_hours}h anchor={anchor:%Y-%m-%dT%H} "
        f"budget={state.get('budget_per_hour')}/h")
    while True:
        state["heartbeat"] = _utcnow().isoformat()
        if max_requests is not None and state.get("n_requests", 0) - start_requests >= max_requests:
            log("request cap reached; exiting")
            break
        if deadline and time.time() > deadline:
            log("wall-clock cap reached; exiting")
            break
        now_ts = time.time()
        try:
            if now_ts - (state.get("last_kp_ts") or 0) > 3 * 3600:
                n = refresh_kp(sess)
                state["last_kp_ts"], state["last_kp"] = now_ts, f"{_utcnow().isoformat()} ({n} 3h values)"
            if now_ts - (state.get("last_tle_ts") or 0) > 6 * 3600:
                n = refresh_tles(sess)
                state["last_tle_ts"], state["last_tle"] = now_ts, f"{_utcnow().isoformat()} ({n} TLEs)"
        except Exception as e:
            log(f"side-data refresh failed: {e!r}")
            state["last_kp_ts"] = state["last_tle_ts"] = now_ts - 2 * 3600
        save_state(state)

        nxt = next_hour_to_fetch(_utcnow(), settle_hours, anchor, relabel_after_days, state)
        if nxt is None:
            maybe_retrain(state, retrain_every_hours, retrain_min_growth)
            save_state(state)
            time.sleep(idle_sleep_s)
            continue
        hour, refresh = nxt
        t0 = time.time()
        try:
            n = fetch_hour(sess, hour, refresh=refresh, stop_after=deadline)
        except Exception as e:
            log(f"hour {_hour_key(hour)} failed: {e!r}; backing off 120s")
            save_state(state)
            time.sleep(120)
            continue
        if n is None:
            break
        if refresh:
            state.setdefault("relabeled", []).append(_hour_key(hour))
        try:
            obs = json.load(open(hour_path(hour)))["observations"]
            st = Counter(o["status"] for o in obs)
            refresh_stations(sess, {o.get("ground_station") for o in obs}, max_new=8)
        except Exception as e:
            st = Counter()
            log(f"station refresh failed: {e!r}")
        log(f"hour {_hour_key(hour)}{' (relabel)' if refresh else ''}: {n} obs {dict(st)} "
            f"in {time.time() - t0:.0f}s; requests={state['n_requests']} 429s={state.get('n_429', 0)}")
        maybe_retrain(state, retrain_every_hours, retrain_min_growth)
        save_state(state)
    save_state(state)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("daemon", help="continuous collection")
    d.add_argument("--settle-hours", type=float, default=72.0)
    d.add_argument("--anchor", default="2025-10-01T00",
                   help="oldest hour to backfill to (YYYY-MM-DDTHH)")
    d.add_argument("--max-requests", type=int)
    d.add_argument("--max-hours", type=float)
    d.add_argument("--relabel-after-days", type=float, default=10.0)
    d.add_argument("--retrain-every-hours", type=float, default=6.0)
    d.add_argument("--retrain-min-growth", type=float, default=0.10)
    w = sub.add_parser("window", help="fetch every hour in [START, END)")
    w.add_argument("start")
    w.add_argument("end")
    r = sub.add_parser("random-windows", help="random one-hour windows (natural mix over months)")
    r.add_argument("--n", type=int, default=20)
    r.add_argument("--days-min", type=int, default=7)
    r.add_argument("--days-max", type=int, default=300)
    r.add_argument("--seed", type=int, default=7)
    sub.add_parser("import-legacy")
    sub.add_parser("seed-stations")
    sub.add_parser("status")
    sub.add_parser("side-data", help="refresh Kp and TLEs only")
    args = p.parse_args(argv)

    if args.cmd == "status":
        print(json.dumps(store_status(), indent=1))
        return 0
    if args.cmd == "seed-stations":
        print(f"seeded {seed_stations()} stations")
        return 0
    if args.cmd == "import-legacy":
        print(f"imported {import_legacy()} complete hours")
        return 0
    state = load_state()
    sess = RateLimitedSession(state)
    if args.cmd == "side-data":
        print(f"kp: {refresh_kp(sess)} values, tle: {refresh_tles(sess)}")
        return 0
    if args.cmd == "daemon":
        anchor = datetime.strptime(args.anchor, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
        return daemon(args.settle_hours, anchor, args.max_requests, args.max_hours,
                      args.relabel_after_days, args.retrain_every_hours, args.retrain_min_growth)
    if args.cmd == "window":
        s, e = (datetime.strptime(x, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc) for x in (args.start, args.end))
        h = s
        while h < e:
            log(f"hour {_hour_key(h)}: {fetch_hour(sess, h)} obs")
            h += timedelta(hours=1)
        return 0
    if args.cmd == "random-windows":
        rng = random.Random(args.seed)
        now = _utcnow().replace(minute=0, second=0, microsecond=0)
        hours = sorted({rng.randrange(args.days_min * 24, args.days_max * 24) for _ in range(args.n)})
        for k in hours:
            h = now - timedelta(hours=k)
            log(f"hour {_hour_key(h)}: {fetch_hour(sess, h)} obs")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
