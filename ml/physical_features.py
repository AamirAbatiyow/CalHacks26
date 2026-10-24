"""
Physical, pass-time-known features for pass-failure prediction (v2).

Design rules:
  * No raw station identity: no station id, name, observer name or raw lat/lon
    (a coordinate pair is a station fingerprint). Station information enters
    only through physical attributes (elevation mask, altitude, |latitude|,
    antenna coverage of the downlink frequency) and through *history* features
    computed strictly from the training fold (see ``add_history_features``).
  * Only information available when the pass is scheduled. Fields written
    after the pass are excluded; see ``LEAKY_FIELDS`` for the audit.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from .space_weather import KpLookup, KP_FILE

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
OBS_FILE = RAW_DIR / "satnogs_observations_natural.jsonl"
STATIONS_FILE = RAW_DIR / "satnogs_stations_full.json"

LABELED_STATUSES = ("good", "bad", "failed")

# Present in the SatNOGS observation record but only written during/after the
# pass, so they encode the outcome. ``client_version`` is null for ~60-100% of
# ``failed`` passes and never null otherwise. Station ``success_rate`` and
# ``status`` are lifetime/current aggregates that include the label.
LEAKY_FIELDS = [
    "status", "waterfall_status", "status_certainty", "vetted_user", "vetted_datetime",
    "payload", "waterfall", "demoddata", "archived", "archive_url",
    "client_version", "client_metadata",
    "station.success_rate", "station.status", "station.observations",
]

# Downlink-frequency bands (MHz), ITU/amateur naming.
BANDS = [
    ("HF", 3, 30), ("VHF", 30, 300), ("UHF", 300, 1000), ("L", 1000, 2000),
    ("S", 2000, 4000), ("C", 4000, 8000), ("X", 8000, 12000),
]

NUMERIC_FEATURES = [
    # pass geometry
    "max_elevation_deg", "duration_sec", "azimuth_span_deg",
    # station physical config (current snapshot from SatNOGS)
    "station_min_horizon_deg", "elevation_margin_deg", "station_min_culmination_deg",
    "station_altitude_m", "station_abs_lat", "station_age_days", "station_n_antennas",
    "antenna_covers_freq",
    # radio
    "downlink_freq_mhz", "freq_offset_khz", "log_baud",
    # orbit / TLE
    "tle_age_days", "sat_inclination_deg", "sat_mean_motion", "sat_perigee_km",
    "sat_apogee_km", "sat_bstar", "sat_age_years",
    # space weather
    "kp_at_time", "kp_max_24h", "geomag_abs_lat", "kp_x_geomag_lat",
    # illumination
    "sun_elevation_deg", "is_night", "local_solar_hour",
    # scheduling
    "self_scheduled",
]

CATEGORICAL_FEATURES = ["band", "transmitter_mode", "transmitter_type", "tle_source", "antenna_type"]

# name -> (key column(s), lookback window in days or None for all history)
HISTORY_KEYS = {
    "station": ("ground_station", None),
    "station_14d": ("ground_station", 14),
    "sat": ("norad_cat_id", None),
    "tx": ("transmitter_uuid", None),
    "station_band": (("ground_station", "band"), None),
}

HISTORY_FEATURES = [f"{k}_{s}" for k in HISTORY_KEYS for s in ("hist_rate", "hist_log_n")]


def load_raw_observations(path: Path = OBS_FILE) -> pd.DataFrame:
    rows = [json.loads(l) for l in open(path)]
    df = pd.DataFrame(rows).drop_duplicates("id")
    return df


def _band(freq_mhz: float) -> str:
    if not np.isfinite(freq_mhz):
        return "unknown"
    for name, lo, hi in BANDS:
        if lo <= freq_mhz < hi:
            return name
    return "other"


def _tle_epoch(tle1: Optional[str]) -> Optional[pd.Timestamp]:
    try:
        yy = int(tle1[18:20])
        doy = float(tle1[20:32])
        year = 2000 + yy if yy < 57 else 1900 + yy
        return pd.Timestamp(year=year, month=1, day=1, tz="UTC") + pd.Timedelta(days=doy - 1)
    except (TypeError, ValueError):
        return None


def _tle_launch_year(tle1: Optional[str]) -> Optional[int]:
    try:
        yy = int(tle1[9:11])
        return 2000 + yy if yy < 57 else 1900 + yy
    except (TypeError, ValueError):
        return None


def _bstar(tle1: Optional[str]) -> float:
    try:
        s = tle1[53:61].strip()
        mant, exp = s[:-2], s[-2:]
        sign = -1.0 if mant.startswith("-") else 1.0
        mant = mant.lstrip("+-")
        return sign * float("0." + mant) * 10 ** int(exp)
    except (TypeError, ValueError, IndexError):
        return np.nan


def _tle2_elements(tle2: Optional[str]) -> Tuple[float, float, float]:
    try:
        inc = float(tle2[8:16])
        ecc = float("0." + tle2[26:33].strip())
        mm = float(tle2[52:63])
        return inc, ecc, mm
    except (TypeError, ValueError):
        return np.nan, np.nan, np.nan


def solar_elevation_deg(ts: pd.Series, lat: np.ndarray, lon: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Sun elevation (NOAA low-precision algorithm, ~0.5 deg) and local solar hour."""
    t = pd.to_datetime(ts, utc=True)
    jd = t.map(lambda x: x.to_julian_date()).to_numpy()
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
    solar_hour = (np.rad2deg(ha) / 15 + 12) % 24
    return np.rad2deg(elev), solar_hour


def geomagnetic_abs_lat(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """|Geomagnetic latitude| under a centred dipole (IGRF-14 pole, ~2025)."""
    plat, plon = np.deg2rad(80.8), np.deg2rad(-72.6)
    la, lo = np.deg2rad(lat), np.deg2rad(lon)
    s = np.sin(la) * np.sin(plat) + np.cos(la) * np.cos(plat) * np.cos(lo - plon)
    return np.abs(np.rad2deg(np.arcsin(np.clip(s, -1, 1))))


def _antenna_info(station: dict, freq_hz: float) -> Tuple[float, str, int]:
    ants = station.get("antenna") or []
    if not ants or not np.isfinite(freq_hz):
        return np.nan, "unknown", len(ants)
    for a in ants:
        lo, hi = a.get("frequency") or 0, a.get("frequency_max") or 0
        if lo <= freq_hz <= hi:
            return 1.0, a.get("antenna_type") or "unknown", len(ants)
    return 0.0, "none_covering", len(ants)


def build_dataset(obs: Optional[pd.DataFrame] = None, stations_path: Path = STATIONS_FILE,
                  kp_path: Path = KP_FILE) -> pd.DataFrame:
    """Raw SatNOGS observations -> one row per labeled pass with physical features."""
    if obs is None:
        obs = load_raw_observations()
    df = obs[obs["status"].isin(LABELED_STATUSES) & obs["ground_station"].notna()].copy()
    df["ground_station"] = df["ground_station"].astype(int)
    stations = {s["id"]: s for s in json.load(open(stations_path))}
    kp = KpLookup(kp_path)

    df["start_ts"] = pd.to_datetime(df["start"], utc=True)
    df["end_ts"] = pd.to_datetime(df["end"], utc=True)
    df = df.sort_values("start_ts").reset_index(drop=True)
    df["label_fail"] = (df["status"] != "good").astype(int)

    df["max_elevation_deg"] = pd.to_numeric(df["max_altitude"], errors="coerce")
    df["duration_sec"] = (df["end_ts"] - df["start_ts"]).dt.total_seconds()
    rise = pd.to_numeric(df["rise_azimuth"], errors="coerce")
    sett = pd.to_numeric(df["set_azimuth"], errors="coerce")
    d = (sett - rise).abs() % 360
    df["azimuth_span_deg"] = np.minimum(d, 360 - d)

    st = df["ground_station"].map(stations)
    df["station_min_horizon_deg"] = st.map(lambda s: s.get("min_horizon") if isinstance(s, dict) else np.nan).astype(float)
    df["station_min_culmination_deg"] = st.map(lambda s: s.get("min_culmination") if isinstance(s, dict) else np.nan).astype(float)
    df["elevation_margin_deg"] = df["max_elevation_deg"] - df["station_min_horizon_deg"]
    df["station_altitude_m"] = pd.to_numeric(df["station_alt"], errors="coerce")
    lat = pd.to_numeric(df["station_lat"], errors="coerce").to_numpy()
    lon = pd.to_numeric(df["station_lng"], errors="coerce").to_numpy()
    df["station_abs_lat"] = np.abs(lat)
    created = pd.to_datetime(st.map(lambda s: s.get("created") if isinstance(s, dict) else None), utc=True)
    df["station_age_days"] = (df["start_ts"] - created).dt.total_seconds() / 86400
    owner = st.map(lambda s: s.get("owner") if isinstance(s, dict) else None)
    df["self_scheduled"] = (df["observer"].notna() & (df["observer"] == owner)).astype(float)

    freq = pd.to_numeric(df["observation_frequency"], errors="coerce")
    freq = freq.fillna(pd.to_numeric(df["transmitter_downlink_low"], errors="coerce"))
    df["downlink_freq_mhz"] = freq / 1e6
    df["freq_offset_khz"] = (freq - pd.to_numeric(df["transmitter_downlink_low"], errors="coerce")) / 1e3
    df["band"] = df["downlink_freq_mhz"].map(_band)
    df["log_baud"] = np.log10(pd.to_numeric(df["transmitter_baud"], errors="coerce").clip(lower=1))
    ant = [_antenna_info(s if isinstance(s, dict) else {}, f) for s, f in zip(st, freq.to_numpy())]
    df["antenna_covers_freq"] = [a[0] for a in ant]
    df["antenna_type"] = [a[1] for a in ant]
    df["station_n_antennas"] = [a[2] for a in ant]

    epochs = df["tle1"].map(_tle_epoch)
    df["tle_age_days"] = [(s - e).total_seconds() / 86400 if e is not None else np.nan
                          for s, e in zip(df["start_ts"], epochs)]
    els = np.array([_tle2_elements(t) for t in df["tle2"]])
    df["sat_inclination_deg"], ecc, df["sat_mean_motion"] = els[:, 0], els[:, 1], els[:, 2]
    mu, re = 398600.4418, 6378.137
    a = (mu / (df["sat_mean_motion"] * 2 * math.pi / 86400) ** 2) ** (1 / 3)
    df["sat_perigee_km"] = a * (1 - ecc) - re
    df["sat_apogee_km"] = a * (1 + ecc) - re
    df["sat_bstar"] = df["tle1"].map(_bstar)
    ly = df["tle1"].map(_tle_launch_year)
    df["sat_age_years"] = df["start_ts"].dt.year + df["start_ts"].dt.dayofyear / 365.25 - ly.astype(float)

    mid = df["start_ts"] + (df["end_ts"] - df["start_ts"]) / 2
    ts = mid.map(lambda x: x.timestamp())
    df["kp_at_time"] = ts.map(kp.at).astype(float)
    df["kp_max_24h"] = ts.map(kp.max_prev_24h).astype(float)
    df["geomag_abs_lat"] = geomagnetic_abs_lat(lat, lon)
    df["kp_x_geomag_lat"] = df["kp_at_time"] * df["geomag_abs_lat"] / 90

    elev, hour = solar_elevation_deg(mid, lat, lon)
    df["sun_elevation_deg"] = elev
    df["is_night"] = np.where(np.isnan(elev), np.nan, (elev < -6).astype(float))
    df["local_solar_hour"] = hour

    for c in CATEGORICAL_FEATURES:
        df[c] = df[c].fillna("unknown").astype(str)
    return df


def _key_series(df: pd.DataFrame, key) -> pd.Series:
    if isinstance(key, tuple):
        return df[list(key)].astype(str).agg("|".join, axis=1)
    return df[key].astype(str)


def add_history_features(train: pd.DataFrame, test: pd.DataFrame, lag_hours: float = 24.0,
                         smoothing: float = 5.0) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Past success rates per station / satellite / transmitter / station-band.

    Uses labels from ``train`` only. For any row (train or test) only training
    passes that *ended* at least ``lag_hours`` before the row's start are
    counted, which excludes the row itself, every pass in the same sampling
    window, and models the delay before SatNOGS outcomes are vetted. Rates are
    shrunk toward the training-fold prior; ``*_hist_log_n`` tells the model how
    much evidence the rate rests on (0 = cold start, e.g. an unseen station).
    """
    train, test = train.copy(), test.copy()
    prior = 1.0 - train["label_fail"].mean()
    lag = pd.Timedelta(hours=lag_hours)
    for name, (key, window_days) in HISTORY_KEYS.items():
        tk = _key_series(train, key)
        events = pd.DataFrame({"k": tk.values, "t": (train["end_ts"]).values,
                               "ok": 1 - train["label_fail"].values}).sort_values("t")
        groups = {k: (g["t"].values, np.concatenate([[0], np.cumsum(g["ok"].values)]))
                  for k, g in events.groupby("k")}
        for part in (train, test):
            pk = _key_series(part, key).values
            qt = (part["start_ts"] - lag).values
            q0 = (qt - pd.Timedelta(days=window_days).to_timedelta64()) if window_days else None
            n = np.zeros(len(part))
            s = np.zeros(len(part))
            for i, (k, q) in enumerate(zip(pk, qt)):
                g = groups.get(k)
                if g is None:
                    continue
                j = np.searchsorted(g[0], q, side="right")
                j0 = np.searchsorted(g[0], q0[i], side="right") if window_days else 0
                n[i] = j - j0
                s[i] = g[1][j] - g[1][j0]
            part[f"{name}_hist_rate"] = (s + smoothing * prior) / (n + smoothing)
            part[f"{name}_hist_log_n"] = np.log1p(n)
    return train, test


def feature_matrix(df: pd.DataFrame, features: List[str], categories: Dict[str, List[str]]) -> pd.DataFrame:
    X = df[features].copy()
    for c in features:
        if c in categories:
            X[c] = pd.Categorical(X[c], categories=categories[c])
        else:
            X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)
    return X
