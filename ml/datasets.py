"""
Labeled pass datasets and leakage-safe physical features.

Two sources:
- "v110": the 3,500-row parquet behind model v1.1.0, built by a per-status
  quota fetch (2,000 good / 1,000 bad / 500 failed, newest first). Classes
  cover different time windows, so `census_only=True` keeps only the window
  in which all three statuses were fetched completely.
- "window": every observation in contiguous UTC days from
  `ml/fetch_labeled.py`, restricted to labeled statuses.

Nothing here reads a station's outcomes. Station history features are
computed inside each training fold by `station_history_features`.
"""

import json
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).parent.parent / "data"
PROCESSED_DIR = DATA_DIR / "processed"
RAW_DIR = DATA_DIR / "raw"

FAILURE_STATUSES = ("bad", "failed")
LABELED_STATUSES = ("good", "bad", "failed")

# Start of the shortest per-status window in the v1.1.0 fetch ('failed').
V110_CENSUS_START = pd.Timestamp("2026-10-23T21:17:20Z")

OMNI_ANTENNAS = {"quadrafilar", "eggbeater", "turnstile", "lindenblad", "other omni",
                 "paragon", "dipole", "vertical", "ground plane", "discone"}
DIRECTIONAL_ANTENNAS = {"yagi", "cross-yagi", "helical", "parabolic", "patch", "moxon"}

PHYSICAL_NUMERIC = [
    "max_elevation_deg", "duration_sec", "station_lat", "station_abs_lat",
    "station_lon", "station_alt_m", "min_horizon_deg", "elev_margin_deg",
    "has_directional", "has_omni", "n_antennas", "station_age_days",
    "kp_at_time", "kp_max_6h", "kp_latitude_risk", "log10_freq_hz",
    "sun_elev_deg", "is_night", "tle_age_days",
]
PHYSICAL_CATEGORICAL = ["band", "transmitter_mode"]


def _load_stations() -> pd.DataFrame:
    st = pd.DataFrame(json.load(open(PROCESSED_DIR / "stations.json")))
    st = st[st["source"] == "satnogs"].copy()
    st["has_directional"] = st["antennas"].apply(
        lambda a: int(any(x in DIRECTIONAL_ANTENNAS for x in (a or []))))
    st["has_omni"] = st["antennas"].apply(
        lambda a: int(any(x in OMNI_ANTENNAS for x in (a or []))))
    st["n_antennas"] = st["antennas"].apply(lambda a: len(a or []))
    st["station_created"] = pd.to_datetime(st["created"], utc=True, errors="coerce")
    return st[["id", "altitude_m", "min_horizon", "has_directional", "has_omni",
               "n_antennas", "station_created"]].rename(columns={"id": "station_id"})


def _load_kp() -> Optional[pd.Series]:
    path = RAW_DIR / "kp_gfz.json"
    if path.exists():
        d = json.load(open(path))
        return pd.Series(d["kp"], index=pd.to_datetime(d["datetime"], utc=True)).sort_index()
    sw = json.load(open(PROCESSED_DIR / "space_weather.json"))
    s = pd.Series({pd.Timestamp(r["time"], tz="UTC"): r["kp"] for r in sw["kp_series"]})
    return s.sort_index() if len(s) else None


def _kp_features(t: pd.Series, kp: Optional[pd.Series]) -> pd.DataFrame:
    """Kp of the 3-hour interval containing the pass, and the max over the prior 6h."""
    out = pd.DataFrame(index=t.index, columns=["kp_at_time", "kp_max_6h"], dtype=float)
    if kp is None:
        return out
    bins = t.dt.floor("3h")
    out["kp_at_time"] = bins.map(kp).astype(float)
    roll = kp.rolling("9h").max()  # current 3h bin plus the two before it
    out["kp_max_6h"] = bins.map(roll).astype(float)
    return out


def solar_elevation_deg(t: pd.Series, lat: pd.Series, lon: pd.Series) -> np.ndarray:
    """Approximate solar elevation (NOAA low-precision formulae, ~0.5° accuracy)."""
    t = pd.to_datetime(t, utc=True)
    doy = t.dt.dayofyear.values
    hours = (t.dt.hour + t.dt.minute / 60 + t.dt.second / 3600).values
    g = 2 * np.pi / 365 * (doy - 1 + (hours - 12) / 24)
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g)
            - 0.006758 * np.cos(2 * g) + 0.000907 * np.sin(2 * g)
            - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    eqtime = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g)
                       - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    true_solar_min = hours * 60 + eqtime + 4 * lon.values
    ha = np.radians(true_solar_min / 4 - 180)
    phi = np.radians(lat.values)
    cos_zen = np.sin(phi) * np.sin(decl) + np.cos(phi) * np.cos(decl) * np.cos(ha)
    return 90 - np.degrees(np.arccos(np.clip(cos_zen, -1, 1)))


def frequency_band(freq_hz: pd.Series) -> pd.Series:
    f = freq_hz.astype(float)
    band = pd.Series("unknown", index=f.index)
    band[(f >= 30e6) & (f < 300e6)] = "VHF"
    band[(f >= 300e6) & (f < 1e9)] = "UHF"
    band[(f >= 1e9) & (f < 2e9)] = "L"
    band[(f >= 2e9) & (f < 4e9)] = "S"
    band[(f >= 4e9)] = "C+"
    return band


def tle_epoch(tle1: pd.Series) -> pd.Series:
    def parse(line):
        if not isinstance(line, str) or len(line) < 32:
            return pd.NaT
        yy = int(line[18:20])
        doy = float(line[20:32])
        year = 2000 + yy if yy < 57 else 1900 + yy
        return pd.Timestamp(year=year, month=1, day=1, tz="UTC") + pd.to_timedelta(doy - 1, unit="D")
    return tle1.apply(parse)


def add_physical_features(df: pd.DataFrame) -> pd.DataFrame:
    """Expects station_id, start_time, station_lat/lon, max_elevation_deg, duration_sec."""
    df = df.copy()
    df["t"] = pd.to_datetime(df["start_time"], utc=True)
    stations = _load_stations()
    stations["_sid"] = stations.pop("station_id").astype(str)
    df = df.drop(columns=[c for c in stations.columns if c in df.columns])
    df["_sid"] = df["station_id"].astype(str)
    df = df.merge(stations, on="_sid", how="left").drop(columns="_sid")
    if "station_alt_m" not in df.columns:
        df["station_alt_m"] = df["altitude_m"]
    df["station_alt_m"] = df["station_alt_m"].fillna(df["altitude_m"])
    df["min_horizon_deg"] = df["min_horizon"]
    df["elev_margin_deg"] = df["max_elevation_deg"] - df["min_horizon_deg"]
    df["station_abs_lat"] = df["station_lat"].abs()
    df["station_age_days"] = (df["t"] - df["station_created"]).dt.total_seconds() / 86400

    kp = _kp_features(df["t"], _load_kp())
    given_kp = df["kp_at_time"] if "kp_at_time" in df.columns else pd.Series(np.nan, index=df.index)
    df["kp_at_time"] = pd.to_numeric(given_kp, errors="coerce").fillna(kp["kp_at_time"])
    df["kp_max_6h"] = kp["kp_max_6h"].values
    df["kp_latitude_risk"] = df["kp_at_time"] * df["station_abs_lat"] / 90

    mid = df["t"] + pd.to_timedelta(df["duration_sec"] / 2, unit="s")
    df["sun_elev_deg"] = solar_elevation_deg(mid, df["station_lat"], df["station_lon"])
    df["is_night"] = (df["sun_elev_deg"] < -6).astype(int)

    if "freq_hz" in df.columns:
        df["log10_freq_hz"] = np.log10(df["freq_hz"].astype(float))
        df["band"] = frequency_band(df["freq_hz"])
    if "tle1" in df.columns:
        df["tle_age_days"] = (df["t"] - tle_epoch(df["tle1"])).dt.total_seconds() / 86400
    for col in PHYSICAL_NUMERIC:
        if col not in df.columns:
            df[col] = np.nan
    return df


def _transmitter_frequency(df: pd.DataFrame) -> pd.Series:
    """Downlink frequency from the SatNOGS DB catalogue by (NORAD id, mode)."""
    path = RAW_DIR / "satnogs_db_transmitters.json"
    if not path.exists():
        return pd.Series(np.nan, index=df.index)
    tx = pd.DataFrame(json.load(open(path)))[["norad_cat_id", "mode", "downlink_low"]].dropna()
    by_mode = tx.groupby(["norad_cat_id", "mode"]).downlink_low.median()
    by_sat = tx.groupby("norad_cat_id").downlink_low.median()
    keys = list(zip(df["satellite_norad_id"], df["transmitter_mode"]))
    f = pd.Series([by_mode.get(k, np.nan) for k in keys], index=df.index)
    return f.fillna(df["satellite_norad_id"].map(by_sat))


def load_v110(census_only: bool = False) -> pd.DataFrame:
    df = pd.read_parquet(PROCESSED_DIR / "passes_features.parquet")
    df = df[df["status"].isin(LABELED_STATUSES)].copy()
    df["freq_hz"] = _transmitter_frequency(df)
    df = df.drop(columns=["kp_at_time"])
    df = add_physical_features(df)
    if census_only:
        df = df[df["t"] >= V110_CENSUS_START]
    df["y"] = df["status"].isin(FAILURE_STATUSES).astype(int)
    return df.sort_values("t").reset_index(drop=True)


def load_window(min_age_hours: float = 0.0) -> pd.DataFrame:
    """Labeled passes from contiguous-window fetches.

    `min_age_hours` drops passes that ended less than that long before they
    were fetched; very recent passes are mostly still unvetted.
    """
    from .fetch_labeled import load_window_observations
    raw = pd.DataFrame(load_window_observations())
    if raw.empty:
        return raw
    raw["start_time"] = raw["start"]
    t_start = pd.to_datetime(raw["start"], utc=True)
    t_end = pd.to_datetime(raw["end"], utc=True)
    if min_age_hours > 0:
        fetched = pd.to_datetime(raw["fetched_at"], utc=True)
        raw = raw[(fetched - t_end) >= pd.Timedelta(hours=min_age_hours)]
        t_start, t_end = t_start[raw.index], t_end[raw.index]
    df = pd.DataFrame({
        "pass_id": raw["id"],
        "satellite_norad_id": raw["norad_cat_id"],
        "station_id": raw["ground_station"],
        "station_lat": raw["station_lat"],
        "station_lon": raw["station_lng"],
        "station_alt_m": raw["station_alt"],
        "start_time": raw["start"],
        "duration_sec": (t_end - t_start).dt.total_seconds(),
        "max_elevation_deg": raw["max_altitude"],
        "transmitter_mode": raw["transmitter_mode"],
        "freq_hz": raw["observation_frequency"].fillna(raw["transmitter_downlink_low"]),
        "tle1": raw["tle1"],
        "status": raw["status"],
        "vetted_by_human": raw["vetted_user"].notna().astype(int),
    })
    status_all = df["status"].value_counts().to_dict()
    df = df[df["status"].isin(LABELED_STATUSES)].copy()
    df = add_physical_features(df)
    df["y"] = df["status"].isin(FAILURE_STATUSES).astype(int)
    df.attrs["status_counts_all"] = status_all
    return df.sort_values("t").reset_index(drop=True)


def station_recent_state(df: pd.DataFrame, lag_hours: float = 1.0,
                         lookback_hours: float = 24.0) -> pd.DataFrame:
    """Past-only station state at pass time.

    Uses only the station's passes that ended at least `lag_hours` before
    this pass starts, and only whether they were 'failed' (no artifacts
    uploaded). That outcome is known once the upload window closes, unlike
    'bad', which waits for a human vetter, so these features are available
    at decision time as long as outcomes arrive within the lag.
    """
    end = df["t"] + pd.to_timedelta(df["duration_sec"], unit="s")
    out = pd.DataFrame(index=df.index, columns=[
        "recent_n", "recent_failed_frac", "last_known_failed", "hours_since_last_known"],
        dtype=float)
    lag = np.timedelta64(int(lag_hours * 3600), "s")
    lookback = np.timedelta64(int(lookback_hours * 3600), "s")
    failed = (df["status"] == "failed").values
    for _, idx in df.groupby("station_id").indices.items():
        idx = np.asarray(idx)
        order = np.argsort(end.values[idx], kind="stable")
        idx = idx[order]
        ends = end.values[idx]
        f = failed[idx].astype(float)
        cf = np.r_[0, np.cumsum(f)]
        for i in idx:
            known_until = df["t"].values[i] - lag
            hi = np.searchsorted(ends, known_until, side="right")
            lo = np.searchsorted(ends, known_until - lookback, side="left")
            n = hi - lo
            out.at[i, "recent_n"] = n
            if n > 0:
                out.at[i, "recent_failed_frac"] = (cf[hi] - cf[lo]) / n
                out.at[i, "last_known_failed"] = f[hi - 1]
                out.at[i, "hours_since_last_known"] = (
                    (df["t"].values[i] - ends[hi - 1]) / np.timedelta64(1, "h"))
    return out


RECENT_STATE_FEATURES = ["recent_n", "recent_failed_frac", "last_known_failed",
                         "hours_since_last_known"]


def station_history_features(train: pd.DataFrame, apply_to: pd.DataFrame,
                             prior_strength: float = 10.0) -> pd.DataFrame:
    """Smoothed station failure rate and pass count, from `train` rows only."""
    prior = train["y"].mean()
    g = train.groupby("station_id")["y"].agg(["sum", "count"])
    rate = (g["sum"] + prior_strength * prior) / (g["count"] + prior_strength)
    out = pd.DataFrame(index=apply_to.index)
    out["station_fail_rate"] = apply_to["station_id"].map(rate).fillna(prior).astype(float)
    out["station_n_train"] = apply_to["station_id"].map(g["count"]).fillna(0).astype(float)
    return out
