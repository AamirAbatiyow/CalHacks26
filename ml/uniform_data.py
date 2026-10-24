"""
Build the time-uniform pass dataset with past-only features.

Input: cached pages from ml/fetch_uniform.py (all statuses from the same time
blocks) plus station / DB / Kp side data. Output: one row per labeled pass
(good / bad / failed) with features that only use information available before
the pass starts.

Causality rules:
  * Outcome-bearing fields are never features: status_certainty, waterfall*,
    vetted*, archived, archive_url, payload, demoddata, client_version,
    client_metadata (written by the station after it runs the pass).
  * Station / satellite / transmitter history only uses observations whose end
    is at least `lag_hours` before this pass starts, because outcomes are
    reported with delay. 'unknown' (uploaded but never vetted) passes count as
    "station alive" evidence but not as labels.
  * Snapshot metadata is only trusted when its timestamp predates the pass
    (transmitter_status vs transmitter_updated, satellite decay date).
  * `sat_conc_*` columns use other stations' outcomes for the *same* pass
    window (start within +/- 30 min). They are only knowable after the pass,
    so they are reported as a post-pass triage ablation, never in the demo.
"""

from __future__ import annotations

import glob
import json
import math
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

ROOT = Path(__file__).parent.parent / "data"
CACHE = ROOT / "raw" / "uniform_cache"
SIDE = ROOT / "raw" / "uniform_side_cache"
OUT = ROOT / "processed" / "passes_uniform.parquet"

LABELED = ("good", "bad", "failed")
OMNI = {"turnstile", "quadrafilar", "eggbeater", "other omni", "ground", "vertical",
        "dipole", "discone", "v-dipole", "lindenblad"}
DIRECTIONAL = {"yagi", "cross-yagi", "helical", "parabolic", "patch", "other direct"}

KEEP_COLS = [
    "id", "start", "end", "ground_station", "norad_cat_id", "status", "max_altitude",
    "rise_azimuth", "set_azimuth", "station_lat", "station_lng", "station_alt",
    "transmitter_uuid", "transmitter_mode", "transmitter_type", "transmitter_baud",
    "transmitter_downlink_low", "transmitter_status", "transmitter_updated",
    "transmitter_unconfirmed", "observation_frequency", "tle1", "tle2",
]


def load_raw_observations() -> pd.DataFrame:
    rows = []
    for f in sorted(glob.glob(str(CACHE / "*" / "*" / "page_*.json"))):
        for o in json.load(open(f)):
            rows.append({k: o.get(k) for k in KEEP_COLS} | {"block": Path(f).parent.parent.name})
    df = pd.DataFrame(rows).drop_duplicates("id").dropna(subset=["ground_station", "norad_cat_id", "start", "end"])
    df["ground_station"] = df["ground_station"].astype(int)
    df["norad_cat_id"] = df["norad_cat_id"].astype(int)
    df["start"] = pd.to_datetime(df["start"], utc=True)
    df["end"] = pd.to_datetime(df["end"], utc=True)
    return df.sort_values("start").reset_index(drop=True)


def _tle_epoch(tle1: Optional[str]) -> pd.Timestamp:
    try:
        yy, doy = int(tle1[18:20]), float(tle1[20:32])
        year = 2000 + yy if yy < 57 else 1900 + yy
        return pd.Timestamp(year=year, month=1, day=1, tz="UTC") + pd.Timedelta(days=doy - 1)
    except (TypeError, ValueError):
        return pd.NaT


def _tle_elements(tle2: Optional[str]) -> tuple[float, float, float]:
    try:
        inc = float(tle2[8:16])
        ecc = float("0." + tle2[26:33].strip())
        mm = float(tle2[52:63])
        return inc, ecc, mm
    except (TypeError, ValueError):
        return (np.nan, np.nan, np.nan)


def _band(freq_hz: float) -> str:
    if not freq_hz or np.isnan(freq_hz):
        return "NA"
    f = freq_hz / 1e6
    if f < 30:
        return "HF"
    if f < 300:
        return "VHF"
    if f < 1000:
        return "UHF"
    if f < 2000:
        return "L"
    if f < 4000:
        return "S"
    return "HIGHER"


def _mode_family(mode: str) -> str:
    m = str(mode).upper()
    for fam in ("GMSK", "GFSK", "MSK", "BPSK", "QPSK", "AFSK", "FSK", "LORA", "SSTV", "CW", "FM", "USB", "APT", "LRPT"):
        if fam in m:
            return fam
    return "OTHER"


def _epoch_s(t: pd.Series) -> np.ndarray:
    return t.dt.tz_convert(None).to_numpy().astype("datetime64[s]").astype(np.int64)


def _rolling_history(
    df: pd.DataFrame, key: str, lag: pd.Timedelta, prefix: str,
    windows: tuple[int, ...] = (5, 20), recent_hours: Optional[float] = None,
) -> pd.DataFrame:
    """
    Past-only outcome history per `key` (station, satellite, ...).

    For each row, uses rows with the same key whose end <= start - lag.
    Returns counts / rates over the last N known outcomes and the time since
    the last 'alive' (any upload) and last 'good' observation.
    """
    out = {c: np.full(len(df), np.nan) for c in
           [f"{prefix}_n_past", f"{prefix}_hours_since_alive", f"{prefix}_hours_since_good",
            f"{prefix}_consec_nodata", f"{prefix}_cum_fail", f"{prefix}_cum_nodata", f"{prefix}_cum_bad",
            f"{prefix}_cum_n_labeled"]
           + [f"{prefix}_fail_last{w}" for w in windows] + [f"{prefix}_nodata_last{w}" for w in windows]
           + ([f"{prefix}_recent_n", f"{prefix}_recent_good", f"{prefix}_recent_nodata"] if recent_hours else [])}

    starts = _epoch_s(df["start"])
    ends = _epoch_s(df["end"])
    status = df["status"].values
    lag_s = int(lag.total_seconds())
    for _, idx in df.groupby(key, sort=False).indices.items():
        idx = np.asarray(idx)
        order_end = idx[np.argsort(ends[idx], kind="stable")]
        e_sorted = ends[order_end]
        st_sorted = status[order_end]
        alive = st_sorted != "failed"
        good = st_sorted == "good"
        labeled = np.isin(st_sorted, LABELED)
        fail = np.isin(st_sorted, ("bad", "failed"))
        nodata = st_sorted == "failed"
        bad = st_sorted == "bad"
        c_lab, c_fail, c_nod, c_bad = (np.concatenate([[0], np.cumsum(a)]) for a in (labeled, fail, nodata, bad))
        lab_pos = np.flatnonzero(labeled)
        for i in idx:
            k = np.searchsorted(e_sorted, starts[i] - lag_s, side="right")
            out[f"{prefix}_n_past"][i] = k
            out[f"{prefix}_cum_n_labeled"][i] = c_lab[k]
            out[f"{prefix}_cum_fail"][i] = c_fail[k]
            out[f"{prefix}_cum_nodata"][i] = c_nod[k]
            out[f"{prefix}_cum_bad"][i] = c_bad[k]
            if k == 0:
                continue
            a = np.flatnonzero(alive[:k])
            if len(a):
                out[f"{prefix}_hours_since_alive"][i] = (starts[i] - e_sorted[a[-1]]) / 3600
                out[f"{prefix}_consec_nodata"][i] = k - 1 - a[-1]
            else:
                out[f"{prefix}_consec_nodata"][i] = k
            g = np.flatnonzero(good[:k])
            if len(g):
                out[f"{prefix}_hours_since_good"][i] = (starts[i] - e_sorted[g[-1]]) / 3600
            lp = lab_pos[lab_pos < k]
            for w in windows:
                last = lp[-w:]
                if len(last):
                    out[f"{prefix}_fail_last{w}"][i] = fail[last].mean()
                    out[f"{prefix}_nodata_last{w}"][i] = nodata[last].mean()
            if recent_hours:
                lo = np.searchsorted(e_sorted, starts[i] - int(recent_hours * 3600), side="left")
                sl = slice(lo, k)
                out[f"{prefix}_recent_n"][i] = k - lo
                out[f"{prefix}_recent_good"][i] = good[sl].sum()
                out[f"{prefix}_recent_nodata"][i] = nodata[sl].sum()
    return pd.DataFrame(out, index=df.index)


def _concurrent_other_stations(df: pd.DataFrame, minutes: float = 30) -> pd.DataFrame:
    """Non-causal: other stations' outcomes for the same satellite, start within +/- minutes."""
    n = np.zeros(len(df))
    good = np.zeros(len(df))
    starts = _epoch_s(df["start"])
    gs = df["ground_station"].values
    st = df["status"].values
    w = int(minutes * 60)
    for _, idx in df.groupby("norad_cat_id", sort=False).indices.items():
        idx = np.asarray(idx)
        o = idx[np.argsort(starts[idx])]
        s = starts[o]
        for j, i in enumerate(o):
            lo, hi = np.searchsorted(s, s[j] - w), np.searchsorted(s, s[j] + w, side="right")
            nb = o[lo:hi]
            nb = nb[gs[nb] != gs[i]]
            n[i] = len(nb)
            good[i] = np.sum(st[nb] == "good")
    return pd.DataFrame({"sat_conc_n": n, "sat_conc_good": good,
                         "sat_conc_good_frac": np.where(n > 0, good / np.maximum(n, 1), np.nan)}, index=df.index)


def _kp_series() -> pd.Series:
    kp = json.load(open(SIDE / "kp_gfz.json"))
    return pd.Series(kp["Kp"], index=pd.to_datetime(kp["datetime"], utc=True)).sort_index()


def _station_table() -> pd.DataFrame:
    st = pd.DataFrame(json.load(open(SIDE / "stations.json")))
    st["created"] = pd.to_datetime(st["created"], utc=True, errors="coerce")
    return st.set_index("id")


def _antenna_match(freq_hz: float, antennas: list) -> tuple[int, float, str]:
    """(in_range, MHz distance to nearest antenna range, type class of matching/nearest antenna)."""
    if not antennas or not freq_hz or np.isnan(freq_hz):
        return 0, np.nan, "none"
    best_d, best_t = np.inf, "none"
    for a in antennas:
        lo, hi = a.get("frequency") or 0, a.get("frequency_max") or 0
        d = 0.0 if lo <= freq_hz <= hi else min(abs(freq_hz - lo), abs(freq_hz - hi)) / 1e6
        if d < best_d:
            t = a.get("antenna_type", "")
            best_d, best_t = d, ("directional" if t in DIRECTIONAL else "omni" if t in OMNI else "other")
    return int(best_d == 0), float(best_d), best_t


def build_dataset(lag_hours: float = 1.0, bayes_m: float = 5.0) -> pd.DataFrame:
    raw = load_raw_observations()
    lag = pd.Timedelta(hours=lag_hours)

    st_hist = _rolling_history(raw, "ground_station", lag, "st", recent_hours=24)
    sat_hist = _rolling_history(raw, "norad_cat_id", lag, "sat", recent_hours=3)
    tx_hist = _rolling_history(raw, "transmitter_uuid", lag, "tx", windows=(20,))
    raw["st_sat_key"] = raw["ground_station"].astype(str) + "|" + raw["norad_cat_id"].astype(str)
    stsat_hist = _rolling_history(raw, "st_sat_key", lag, "stsat", windows=(5,))
    conc = _concurrent_other_stations(raw)
    df = pd.concat([raw, st_hist, sat_hist, tx_hist[["tx_fail_last20", "tx_cum_n_labeled"]],
                    stsat_hist[["stsat_fail_last5", "stsat_cum_n_labeled"]], conc], axis=1)
    df = df[df["status"].isin(LABELED)].copy()

    # Bayesian (beta-binomial) station prior: shrink the station's past rate
    # toward its hardware group's past rate (hierarchical), then toward global.
    labeled = df.sort_values("end")
    glob_fail = (labeled["status"] != "good").mean()
    glob_nod = (labeled["status"] == "failed").mean()
    df["st_bayes_fail"] = (df["st_cum_fail"] + bayes_m * glob_fail) / (df["st_cum_n_labeled"] + bayes_m)
    df["st_bayes_nodata"] = (df["st_cum_nodata"] + bayes_m * glob_nod) / (df["st_cum_n_labeled"] + bayes_m)
    df["sat_bayes_fail"] = (df["sat_cum_fail"] + bayes_m * glob_fail) / (df["sat_cum_n_labeled"] + bayes_m)
    df["sat_bayes_bad"] = (df["sat_cum_bad"] + bayes_m * (labeled["status"] == "bad").mean()) / (df["sat_cum_n_labeled"] + bayes_m)
    df["st_uptime_24h"] = 1 - df["st_recent_nodata"] / df["st_recent_n"].replace(0, np.nan)
    df["sat_recent_good_frac"] = df["sat_recent_good"] / df["sat_recent_n"].replace(0, np.nan)
    df["sat_recent_any_good"] = (df["sat_recent_good"] > 0).astype(float).where(df["sat_recent_n"] > 0)

    # Pass geometry / time / space weather
    df["duration_sec"] = (df["end"] - df["start"]).dt.total_seconds()
    df["log_duration"] = np.log1p(df["duration_sec"])
    df["max_elevation_deg"] = df["max_altitude"].astype(float)
    az = (df["set_azimuth"].astype(float) - df["rise_azimuth"].astype(float)).abs() % 360
    df["azimuth_span_deg"] = np.minimum(az, 360 - az)
    df["hour_utc"] = df["start"].dt.hour + df["start"].dt.minute / 60
    df["local_solar_hour"] = (df["hour_utc"] + df["station_lng"].astype(float) / 15) % 24
    kp = _kp_series()
    pos = np.clip(kp.index.searchsorted(df["start"], side="right") - 1, 0, len(kp) - 1)
    df["kp_at_time"] = kp.values[pos]
    kp24 = kp.rolling("24h").max()
    df["kp_max_24h"] = kp24.values[pos]

    # Station hardware (station snapshot fields that change slowly)
    st = _station_table().reindex(df["ground_station"].values)
    df["station_lat"] = df["station_lat"].astype(float)
    df["station_lon"] = df["station_lng"].astype(float)
    df["station_abs_lat"] = df["station_lat"].abs()
    df["station_altitude_m"] = df["station_alt"].astype(float)
    df["station_min_horizon"] = st["min_horizon"].astype(float).values
    df["station_min_culmination"] = st["min_culmination"].astype(float).values
    df["elevation_margin_deg"] = df["max_elevation_deg"] - df["station_min_horizon"].fillna(0)
    df["culmination_margin_deg"] = df["max_elevation_deg"] - df["station_min_culmination"].fillna(0)
    created = pd.Series(pd.to_datetime(st["created"].values, utc=True), index=df.index)
    df["station_age_days"] = (df["start"] - created).dt.total_seconds() / 86400
    ants = [a if isinstance(a, list) else [] for a in st["antenna"].tolist()]
    df["n_antennas"] = [len(a) for a in ants]
    types = [{x.get("antenna_type", "") for x in a} for a in ants]
    df["has_directional"] = [int(bool(t & DIRECTIONAL)) for t in types]
    df["has_omni"] = [int(bool(t & OMNI)) for t in types]

    # Transmitter / frequency vs antenna / satellite
    freq = df["observation_frequency"].fillna(df["transmitter_downlink_low"]).astype(float)
    df["freq_mhz"] = freq / 1e6
    df["band"] = [_band(f) for f in freq]
    match = [_antenna_match(f, a) for f, a in zip(freq, ants)]
    df["freq_in_antenna_range"] = [m[0] for m in match]
    df["freq_dist_to_antenna_mhz"] = [m[1] for m in match]
    df["matched_antenna_class"] = [m[2] for m in match]
    df["transmitter_mode"] = df["transmitter_mode"].fillna("UNKNOWN").astype(str)
    df["mode_family"] = df["transmitter_mode"].map(_mode_family)
    df["transmitter_type"] = df["transmitter_type"].fillna("NA").astype(str)
    df["log_baud"] = np.log1p(pd.to_numeric(df["transmitter_baud"], errors="coerce"))
    tx_updated = pd.to_datetime(df["transmitter_updated"], utc=True, errors="coerce")
    df["transmitter_status_pre"] = np.where(tx_updated < df["start"], df["transmitter_status"].fillna("NA"), "updated_after")
    df["transmitter_unconfirmed"] = df["transmitter_unconfirmed"].astype(float)

    epochs = [_tle_epoch(t) for t in df["tle1"]]
    df["tle_age_days"] = (df["start"] - pd.Series(epochs, index=df.index)).dt.total_seconds() / 86400
    el = np.array([_tle_elements(t) for t in df["tle2"]])
    df["sat_inclination_deg"], df["sat_eccentricity"], df["sat_mean_motion"] = el[:, 0], el[:, 1], el[:, 2]
    mu = 398600.4418
    n_rad = df["sat_mean_motion"] * 2 * math.pi / 86400
    df["sat_altitude_km"] = (mu / n_rad ** 2) ** (1 / 3) - 6378.137

    sats = pd.DataFrame(json.load(open(SIDE / "db_satellites.json"))).drop_duplicates("norad_cat_id").set_index("norad_cat_id")
    decayed = pd.to_datetime(sats["decayed"], utc=True, errors="coerce").reindex(df["norad_cat_id"].values)
    decayed.index = df.index
    df["sat_decayed_before_pass"] = (decayed < df["start"]).astype(float)
    df["sat_frequency_violator"] = sats["is_frequency_violator"].reindex(df["norad_cat_id"].values).astype(float).values

    df["station_id"] = df["ground_station"].astype(int)
    df["satellite_norad_id"] = df["norad_cat_id"].astype(int)
    df["outcome_label"] = (df["status"] == "good").astype(int)
    df["start_time"] = df["start"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    drop = ["tle1", "tle2", "transmitter_updated", "transmitter_status", "station_lng", "station_alt",
            "max_altitude", "st_sat_key", "transmitter_baud", "observation_frequency", "transmitter_downlink_low"]
    return df.drop(columns=drop).reset_index(drop=True)


if __name__ == "__main__":
    d = build_dataset()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    d.to_parquet(OUT, index=False)
    print(d.shape, d["status"].value_counts().to_dict(), d["station_id"].nunique(), "stations", d["block"].nunique(), "blocks")
