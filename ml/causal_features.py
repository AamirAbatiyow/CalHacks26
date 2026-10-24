"""
Strictly causal features for the final pass-failure classifier (v3).

Every feature for a pass is computed from what an operator could know at the
pass start time T:

* Pass / orbit / radio / station-hardware attributes known when the pass is
  scheduled (PR #18 physics set: geometry, elevation margin, antenna coverage
  of the downlink, baud, TLE age, B* drag, perigee/apogee, Kp, sun angle).
  No station id, name, raw lat/lon or snapshot status (`last_seen`, `status`,
  `success_rate` are written after the fact and leak).
* Outcome history (PR #12 outage streaks, PR #17 station health and
  co-observation, PR #18 station-band / satellite / transmitter rates), using
  only past passes whose outcome was *known* by T under an explicit label
  latency model (`known_at`):

    failed  -> end + lag          (no artifacts uploaded; lag = 1h or 3h)
    good    -> end + lag, or the vetting time if a vetter set it
    bad     -> vetting time (vetted_datetime / waterfall_status_datetime)
    unknown -> never

  Human rulings on escalated passes (the HITL loop) make outcomes known
  earlier: callers can pass their own `known_at`.

Satellite target encoding over the same time window (PR #17 E0-E2) is not
used: it reads other stations' outcomes for the same or later passes.

Passes whose station history is not fully covered by the store (the first
`lookback + lag` hours of a contiguous crawl, isolated legacy hours) are
flagged with `history_covered = False` and excluded from training/evaluation,
because a missing history would look like a quiet station.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

import numpy as np
import pandas as pd

LABELED = ("good", "bad", "failed")
FAILURE = ("bad", "failed")

NS_PER_H = 3_600_000_000_000
NEVER = np.iinfo(np.int64).max // 2

DIRECTIONAL = {"yagi", "cross-yagi", "helical", "parabolic", "patch", "moxon", "other direct", "dish"}
OMNI = {"quadrafilar", "eggbeater", "turnstile", "lindenblad", "other omni", "paragon", "dipole",
        "vertical", "ground plane", "discone", "v-dipole", "ground"}

BANDS = [("HF", 3e6, 30e6), ("VHF", 30e6, 300e6), ("UHF", 300e6, 1e9), ("L", 1e9, 2e9),
         ("S", 2e9, 4e9), ("C", 4e9, 8e9), ("X", 8e9, 12e9)]

PHYSICAL_NUMERIC = [
    "max_elevation_deg", "duration_sec", "azimuth_span_deg",
    "min_horizon_deg", "elev_margin_deg", "min_culmination_deg", "culmination_margin_deg",
    "station_alt_m", "station_abs_lat", "station_age_days", "n_antennas", "antenna_covers_freq",
    "has_directional", "has_omni",
    "log10_freq_hz", "freq_offset_khz", "log_baud", "tx_unconfirmed", "tx_status_active",
    "tle_age_days", "sat_inclination_deg", "sat_mean_motion", "sat_perigee_km", "sat_apogee_km",
    "sat_bstar", "sat_age_years",
    "kp_last", "kp_max_24h", "geomag_abs_lat", "kp_x_geomag_lat",
    "sun_elev_deg", "is_night", "local_solar_hour", "self_scheduled",
]
PHYSICAL_CATEGORICAL = ["band", "transmitter_mode", "transmitter_type", "antenna_type", "tle_source"]

# key name -> columns; lookback hours per key
HISTORY_KEYS = {
    "st": ("ground_station",),
    "sat": ("norad_cat_id",),
    "tx": ("transmitter_uuid",),
    "stband": ("ground_station", "band"),
    "stsat": ("ground_station", "norad_cat_id"),
}
STATION_STATE = ["n", "failed_frac", "good_frac", "unknown_frac", "last_failed", "last_good",
                 "fail_streak", "h_since_known", "h_since_good", "h_since_failed", "bad_known"]
OTHER_STATE = ["n", "failed_frac", "good_frac"]


def history_feature_names(prefix: str = "") -> List[str]:
    out = [f"st_{s}" for s in STATION_STATE]
    for k in ("sat", "tx", "stband", "stsat"):
        out += [f"{k}_{s}" for s in OTHER_STATE]
    out += ["st_n_long", "st_failed_frac_long"]
    return out


HISTORY_FEATURES = history_feature_names()


# --------------------------------------------------------------------------- helpers


def _band(f: float) -> str:
    if not np.isfinite(f):
        return "unknown"
    for name, lo, hi in BANDS:
        if lo <= f < hi:
            return name
    return "other"


def _tle_epoch_ns(line: Optional[str]) -> float:
    try:
        yy = int(line[18:20])
        doy = float(line[20:32])
        year = 2000 + yy if yy < 57 else 1900 + yy
        return (pd.Timestamp(year=year, month=1, day=1, tz="UTC") + pd.Timedelta(days=doy - 1)).value
    except (TypeError, ValueError):
        return np.nan


def _bstar(line: Optional[str]) -> float:
    try:
        s = line[53:61].strip()
        mant, exp = s[:-2], s[-2:]
        sign = -1.0 if mant.startswith("-") else 1.0
        return sign * float("0." + mant.lstrip("+-")) * 10 ** int(exp)
    except (TypeError, ValueError, IndexError):
        return np.nan


def _launch_year(line: Optional[str]) -> float:
    try:
        yy = int(line[9:11])
        return float(2000 + yy if yy < 57 else 1900 + yy)
    except (TypeError, ValueError):
        return np.nan


def _tle2(line: Optional[str]):
    try:
        return float(line[8:16]), float("0." + line[26:33].strip()), float(line[52:63])
    except (TypeError, ValueError):
        return np.nan, np.nan, np.nan


def solar_position(t: pd.Series, lat: np.ndarray, lon: np.ndarray):
    """Sun elevation (deg) and local solar hour; NOAA low-precision, ~0.5 deg."""
    jd = pd.to_datetime(t, utc=True).map(lambda x: x.to_julian_date()).to_numpy(dtype=float)
    n = jd - 2451545.0
    L = np.deg2rad((280.460 + 0.9856474 * n) % 360)
    g = np.deg2rad((357.528 + 0.9856003 * n) % 360)
    lam = L + np.deg2rad(1.915) * np.sin(g) + np.deg2rad(0.020) * np.sin(2 * g)
    eps = np.deg2rad(23.439 - 0.0000004 * n)
    dec = np.arcsin(np.sin(eps) * np.sin(lam))
    ra = np.arctan2(np.cos(eps) * np.sin(lam), np.cos(lam))
    gmst_h = (18.697374558 + 24.06570982441908 * n) % 24
    ha = np.deg2rad(((gmst_h * 15 + lon) - np.rad2deg(ra) + 540) % 360 - 180)
    latr = np.deg2rad(lat)
    elev = np.arcsin(np.sin(latr) * np.sin(dec) + np.cos(latr) * np.cos(dec) * np.cos(ha))
    return np.rad2deg(elev), (np.rad2deg(ha) / 15 + 12) % 24


def geomagnetic_abs_lat(lat, lon):
    plat, plon = np.deg2rad(80.8), np.deg2rad(-72.6)
    la, lo = np.deg2rad(lat), np.deg2rad(lon)
    s = np.sin(la) * np.sin(plat) + np.cos(la) * np.cos(plat) * np.cos(lo - plon)
    return np.abs(np.rad2deg(np.arcsin(np.clip(s, -1, 1))))


class KpSeries:
    """3-hourly Kp; lookups only use bins that *ended* before the query time."""

    def __init__(self, kp: Dict[str, float]):
        items = sorted((pd.Timestamp(t).tz_convert("UTC") if pd.Timestamp(t).tzinfo else
                        pd.Timestamp(t, tz="UTC"), v) for t, v in kp.items())
        self.t = np.array([x[0].value for x in items], dtype=np.int64)
        self.v = np.array([x[1] for x in items], dtype=float)

    @classmethod
    def from_file(cls, path: Path) -> "KpSeries":
        if not Path(path).exists():
            return cls({})
        d = json.load(open(path))
        if "kp" in d and isinstance(d["kp"], dict):
            return cls({t: (v["kp"] if isinstance(v, dict) else v) for t, v in d["kp"].items()})
        if "datetime" in d:
            return cls(dict(zip(d["datetime"], d.get("kp", d.get("Kp", [])))))
        return cls(d)

    def last_and_max24(self, t_ns: np.ndarray):
        if len(self.t) == 0:
            nan = np.full(len(t_ns), np.nan)
            return nan, nan
        end = self.t + 3 * NS_PER_H
        hi = np.searchsorted(end, t_ns, side="right")
        last = np.where(hi > 0, self.v[np.clip(hi - 1, 0, None)], np.nan)
        lo = np.searchsorted(end, t_ns - 24 * NS_PER_H, side="right")
        mx = np.array([self.v[a:b].max() if b > a else np.nan for a, b in zip(lo, hi)])
        return last, mx


# --------------------------------------------------------------------------- base table


def normalize_observations(raw: pd.DataFrame) -> pd.DataFrame:
    """Store rows (all statuses) -> typed table sorted by start."""
    df = raw.dropna(subset=["ground_station", "start", "end"]).copy()
    df = df.drop_duplicates("id", keep="last")
    df["ground_station"] = df["ground_station"].astype(int)
    df["norad_cat_id"] = pd.to_numeric(df["norad_cat_id"], errors="coerce").fillna(-1).astype(int)
    df["start_ts"] = pd.to_datetime(df["start"], utc=True).dt.as_unit("ns")
    df["end_ts"] = pd.to_datetime(df["end"], utc=True).dt.as_unit("ns")
    df["start_ns"] = df["start_ts"].astype("int64")
    df["end_ns"] = df["end_ts"].astype("int64")
    freq = pd.to_numeric(df.get("observation_frequency"), errors="coerce")
    low = pd.to_numeric(df.get("transmitter_downlink_low"), errors="coerce")
    df["freq_hz"] = freq.fillna(low)
    df["band"] = df["freq_hz"].map(_band)
    df["transmitter_uuid"] = df["transmitter_uuid"].fillna("none").astype(str)
    df["y"] = df["status"].isin(FAILURE).astype(int)
    df["labeled"] = df["status"].isin(LABELED)
    return df.sort_values(["start_ns", "id"]).reset_index(drop=True)


def _dt_ns(s: pd.Series) -> np.ndarray:
    t = pd.to_datetime(s, utc=True, errors="coerce").dt.as_unit("ns")
    v = t.astype("int64").to_numpy().astype(np.int64)
    v[t.isna().to_numpy()] = NEVER
    return v


def label_known_at(df: pd.DataFrame, lag_hours: float) -> np.ndarray:
    """Earliest time (ns) each pass's final status is known to the operator."""
    lag = int(lag_hours * NS_PER_H)
    end = df["end_ns"].to_numpy()
    vetted = np.minimum(_dt_ns(df.get("vetted_datetime", pd.Series(index=df.index, dtype=object))),
                        _dt_ns(df.get("waterfall_status_datetime", pd.Series(index=df.index, dtype=object))))
    status = df["status"].to_numpy()
    out = np.full(len(df), NEVER, dtype=np.int64)
    auto = end + lag
    out[status == "failed"] = auto[status == "failed"]
    g = status == "good"
    out[g] = np.where(vetted[g] < NEVER, np.maximum(vetted[g], end[g]), auto[g])
    b = status == "bad"
    out[b] = np.where(vetted[b] < NEVER, np.maximum(vetted[b], end[b]), NEVER)
    return out


def history_coverage(df: pd.DataFrame, hours_present: Iterable[pd.Timestamp], need_hours: float) -> np.ndarray:
    """True when every UTC hour overlapping [start - need_hours, start) is in the store."""
    present = {int(pd.Timestamp(h).value // NS_PER_H) for h in hours_present}
    if not present:
        return np.zeros(len(df), dtype=bool)
    hs = np.array(sorted(present), dtype=np.int64)
    # contiguous run start for each present hour
    run_start = {}
    prev, cur_start = None, None
    for h in hs:
        if prev is None or h != prev + 1:
            cur_start = h
        run_start[h] = cur_start
        prev = h
    start_h = df["start_ns"].to_numpy() // NS_PER_H
    need = int(math.ceil(need_hours))
    out = np.zeros(len(df), dtype=bool)
    for i, h in enumerate(start_h):
        rs = run_start.get(int(h))
        out[i] = rs is not None and h - rs >= need
    return out


# --------------------------------------------------------------------------- physics


def physical_features(df: pd.DataFrame, stations: Dict[int, dict], kp: KpSeries) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    out["max_elevation_deg"] = pd.to_numeric(df["max_altitude"], errors="coerce")
    out["duration_sec"] = (df["end_ns"] - df["start_ns"]) / 1e9
    rise = pd.to_numeric(df.get("rise_azimuth"), errors="coerce")
    sett = pd.to_numeric(df.get("set_azimuth"), errors="coerce")
    d = (sett - rise).abs() % 360
    out["azimuth_span_deg"] = np.minimum(d, 360 - d)

    st = df["ground_station"].map(lambda s: stations.get(int(s), {}))
    getf = lambda k: st.map(lambda s: s.get(k) if isinstance(s, dict) else None)
    out["min_horizon_deg"] = pd.to_numeric(getf("min_horizon"), errors="coerce")
    out["min_culmination_deg"] = pd.to_numeric(getf("min_culmination"), errors="coerce")
    out["elev_margin_deg"] = out["max_elevation_deg"] - out["min_horizon_deg"]
    out["culmination_margin_deg"] = out["max_elevation_deg"] - out["min_culmination_deg"]
    out["station_alt_m"] = pd.to_numeric(df.get("station_alt"), errors="coerce").fillna(
        pd.to_numeric(getf("altitude"), errors="coerce"))
    lat = pd.to_numeric(df["station_lat"], errors="coerce").to_numpy(dtype=float)
    lon = pd.to_numeric(df["station_lng"], errors="coerce").to_numpy(dtype=float)
    out["station_abs_lat"] = np.abs(lat)
    created = pd.to_datetime(getf("created"), utc=True, errors="coerce")
    out["station_age_days"] = (df["start_ts"] - created).dt.total_seconds() / 86400
    owner = getf("owner")
    out["self_scheduled"] = np.where(owner.isna(), np.nan,
                                     (df.get("observer").astype(object) == owner).astype(float))

    freq = df["freq_hz"].to_numpy(dtype=float)
    ants = st.map(lambda s: (s.get("antenna") or []) if isinstance(s, dict) else [])
    cover, atype, nant, hd, ho = [], [], [], [], []
    for a_list, f in zip(ants, freq):
        nant.append(len(a_list) if a_list else np.nan)
        types = {(a.get("antenna_type") or "").lower() for a in a_list}
        hd.append(float(bool(types & DIRECTIONAL)) if a_list else np.nan)
        ho.append(float(bool(types & OMNI)) if a_list else np.nan)
        if not a_list or not np.isfinite(f):
            cover.append(np.nan)
            atype.append("unknown")
            continue
        fb = _band(f)
        hit = [a for a in a_list
               if ((a.get("frequency") or 0) <= f <= (a.get("frequency_max") or 0))
               or (a.get("frequency") is None and a.get("band") == fb)]
        cover.append(1.0 if hit else 0.0)
        atype.append((hit[0].get("antenna_type") or "unknown") if hit else "none_covering")
    out["antenna_covers_freq"], out["antenna_type"], out["n_antennas"] = cover, atype, nant
    out["has_directional"], out["has_omni"] = hd, ho

    out["log10_freq_hz"] = np.log10(np.where(freq > 0, freq, np.nan))
    low = pd.to_numeric(df.get("transmitter_downlink_low"), errors="coerce")
    out["freq_offset_khz"] = (df["freq_hz"] - low) / 1e3
    out["log_baud"] = np.log10(pd.to_numeric(df.get("transmitter_baud"), errors="coerce").clip(lower=1))
    out["tx_unconfirmed"] = df.get("transmitter_unconfirmed").map(
        lambda v: np.nan if v is None or (isinstance(v, float) and np.isnan(v)) else float(bool(v)))
    # transmitter_status is a snapshot; trust it only if it was last updated before the pass.
    upd = pd.to_datetime(df.get("transmitter_updated"), utc=True, errors="coerce")
    active = df.get("transmitter_status").map(lambda s: 1.0 if s == "active" else 0.0 if isinstance(s, str) else np.nan)
    out["tx_status_active"] = np.where(upd.notna() & (upd < df["start_ts"]), active, np.nan)

    epoch = df["tle1"].map(_tle_epoch_ns).to_numpy(dtype=float)
    out["tle_age_days"] = (df["start_ns"].to_numpy() - epoch) / (86400 * 1e9)
    els = np.array([_tle2(t) for t in df["tle2"]], dtype=float).reshape(-1, 3)
    out["sat_inclination_deg"], ecc, out["sat_mean_motion"] = els[:, 0], els[:, 1], els[:, 2]
    mu, re = 398600.4418, 6378.137
    with np.errstate(invalid="ignore", divide="ignore"):
        a = (mu / (out["sat_mean_motion"] * 2 * math.pi / 86400) ** 2) ** (1 / 3)
    out["sat_perigee_km"] = a * (1 - ecc) - re
    out["sat_apogee_km"] = a * (1 + ecc) - re
    out["sat_bstar"] = df["tle1"].map(_bstar)
    ly = df["tle1"].map(_launch_year).astype(float)
    out["sat_age_years"] = df["start_ts"].dt.year + df["start_ts"].dt.day_of_year / 365.25 - ly

    last, mx = kp.last_and_max24(df["start_ns"].to_numpy())
    out["kp_last"], out["kp_max_24h"] = last, mx
    out["geomag_abs_lat"] = geomagnetic_abs_lat(lat, lon)
    out["kp_x_geomag_lat"] = out["kp_last"] * out["geomag_abs_lat"] / 90
    mid = df["start_ts"] + (df["end_ts"] - df["start_ts"]) / 2
    elev, hour = solar_position(mid, lat, lon)
    out["sun_elev_deg"], out["local_solar_hour"] = elev, hour
    out["is_night"] = np.where(np.isnan(elev), np.nan, (elev < -6).astype(float))
    for c in PHYSICAL_CATEGORICAL:
        src = out[c] if c in out else df.get(c)
        out[c] = pd.Series(src, index=df.index).fillna("unknown").astype(str)
    return out


# --------------------------------------------------------------------------- history


def _group_index(df: pd.DataFrame, cols: Sequence[str]) -> np.ndarray:
    if len(cols) == 1:
        return pd.factorize(df[cols[0]].astype(str))[0]
    return pd.factorize(df[list(cols)].astype(str).agg("|".join, axis=1))[0]


def history_features(df: pd.DataFrame, known_at: np.ndarray, query_idx: Optional[np.ndarray] = None,
                     lookback_hours: float = 12.0, long_lookback_hours: float = 24.0,
                     query_time_ns: Optional[np.ndarray] = None) -> pd.DataFrame:
    """Past-only outcome history for rows `query_idx` of `df` (all statuses).

    A past pass counts as scheduled if it ended before T (the decision time,
    default: this pass's start) and its outcome counts only if `known_at <= T`.
    """
    n_all = len(df)
    q = np.arange(n_all) if query_idx is None else np.asarray(query_idx)
    T = df["start_ns"].to_numpy()[q] if query_time_ns is None else np.asarray(query_time_ns)
    end = df["end_ns"].to_numpy()
    status = df["status"].to_numpy()
    is_failed = status == "failed"
    is_good = status == "good"
    is_bad = status == "bad"
    W = int(lookback_hours * NS_PER_H)
    WL = int(long_lookback_hours * NS_PER_H)
    out = {name: np.full(len(q), np.nan) for name in HISTORY_FEATURES}

    for key, cols in HISTORY_KEYS.items():
        g = _group_index(df, cols)
        order = np.lexsort((end, g))
        g_sorted, end_sorted = g[order], end[order]
        bounds = np.searchsorted(g_sorted, np.arange(g.max() + 2))
        for j, (qi, t) in enumerate(zip(q, T)):
            gi = g[qi]
            a, b = bounds[gi], bounds[gi + 1]
            ends = end_sorted[a:b]
            hi = a + np.searchsorted(ends, t, side="left")  # ended strictly before T
            w = WL if key == "st" else W
            lo = a + np.searchsorted(ends, t - w, side="left")
            if hi <= lo:
                if key == "st":
                    out["st_n"][j] = 0
                    out["st_n_long"][j] = 0
                else:
                    out[f"{key}_n"][j] = 0
                continue
            idx = order[lo:hi]
            idx = idx[idx != qi]
            known = known_at[idx] <= t
            if key == "st":
                out["st_n_long"][j] = len(idx)
                out["st_failed_frac_long"][j] = (is_failed[idx] & known).mean() if len(idx) else np.nan
                recent = end[idx] >= t - W
                idx, known = idx[recent], known[recent]
            n = len(idx)
            out[f"{key}_n"][j] = n
            if n == 0:
                continue
            kf = is_failed[idx] & known
            kg = is_good[idx] & known
            out[f"{key}_failed_frac"][j] = kf.mean()
            out[f"{key}_good_frac"][j] = kg.mean()
            if key != "st":
                continue
            out["st_unknown_frac"][j] = 1 - known.mean()
            out["st_bad_known"][j] = float((is_bad[idx] & known).sum())
            kidx = idx[known]
            if len(kidx):
                kidx = kidx[np.argsort(end[kidx])]
                last = kidx[-1]
                out["st_last_failed"][j] = float(is_failed[last])
                out["st_last_good"][j] = float(is_good[last])
                out["st_h_since_known"][j] = (t - end[last]) / NS_PER_H
                streak = 0
                for k in kidx[::-1]:
                    if is_failed[k]:
                        streak += 1
                    else:
                        break
                out["st_fail_streak"][j] = streak
                gk = kidx[is_good[kidx]]
                fk = kidx[is_failed[kidx]]
                out["st_h_since_good"][j] = (t - end[gk[-1]]) / NS_PER_H if len(gk) else lookback_hours * 2
                out["st_h_since_failed"][j] = (t - end[fk[-1]]) / NS_PER_H if len(fk) else lookback_hours * 2
    return pd.DataFrame(out, index=df.index[q])


# --------------------------------------------------------------------------- dataset


def build_dataset(raw: pd.DataFrame, stations: Dict[int, dict], kp: KpSeries,
                  hours_present: Iterable[pd.Timestamp], lag_hours: float = 1.0,
                  lookback_hours: float = 12.0, long_lookback_hours: float = 24.0) -> pd.DataFrame:
    """One row per labeled, history-covered pass: physics + causal history + label."""
    obs = normalize_observations(raw)
    known = label_known_at(obs, lag_hours)
    covered = history_coverage(obs, hours_present, lookback_hours + lag_hours)
    q = np.where(obs["labeled"].to_numpy() & covered)[0]
    hist = history_features(obs, known, q, lookback_hours, long_lookback_hours)
    long_ok = history_coverage(obs, hours_present, long_lookback_hours + lag_hours)[q]
    hist.loc[~long_ok, ["st_n_long", "st_failed_frac_long"]] = np.nan
    phys = physical_features(obs.iloc[q], stations, kp)
    base = obs.iloc[q][["id", "ground_station", "norad_cat_id", "start_ts", "end_ts", "start_ns", "end_ns",
                        "status", "y", "band"]].rename(columns={"band": "_band"})
    out = pd.concat([base, phys, hist], axis=1)
    out.attrs["n_obs_all"] = len(obs)
    out.attrs["n_labeled_all"] = int(obs["labeled"].sum())
    out.attrs["n_covered"] = int(covered.sum())
    out.attrs["lag_hours"] = lag_hours
    return out.drop(columns=["_band"]).reset_index(drop=True)


FEATURES_NUMERIC = PHYSICAL_NUMERIC + HISTORY_FEATURES
FEATURES_CATEGORICAL = PHYSICAL_CATEGORICAL
