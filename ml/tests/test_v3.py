"""Tests for the time-uniform dataset builder and the v3 abstaining models."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from ml.abstain_v3 import ABSTAIN, FAIL_BAD, FAIL_NODATA, AbstainV3, GroupConformal, TwoStageV3, V3Config
from ml.conformal_ensemble import FAIL, OK
from ml.uniform_data import _antenna_match, _rolling_history, _tle_epoch


def _obs(rows):
    df = pd.DataFrame(rows, columns=["ground_station", "start", "end", "status"])
    df["start"] = pd.to_datetime(df["start"], utc=True)
    df["end"] = pd.to_datetime(df["end"], utc=True)
    return df


def test_rolling_history_is_past_only_with_lag():
    df = _obs([
        (1, "2026-09-01T00:00Z", "2026-09-01T00:10Z", "failed"),
        (1, "2026-09-01T00:30Z", "2026-09-01T00:40Z", "good"),
        (1, "2026-09-01T01:20Z", "2026-09-01T01:30Z", "bad"),
    ])
    h = _rolling_history(df, "ground_station", pd.Timedelta(hours=1), "st")
    assert h["st_n_past"].tolist() == [0, 0, 1]
    assert h.loc[2, "st_fail_last5"] == 1.0
    assert h.loc[2, "st_nodata_last5"] == 1.0
    assert np.isnan(h.loc[2, "st_hours_since_alive"])
    assert h.loc[2, "st_consec_nodata"] == 1


def test_rolling_history_ignores_own_and_future_outcomes():
    df = _obs([
        (7, "2026-09-01T00:00Z", "2026-09-01T00:10Z", "good"),
        (7, "2026-09-01T05:00Z", "2026-09-01T05:10Z", "failed"),
        (7, "2026-09-01T10:00Z", "2026-09-01T10:10Z", "failed"),
    ])
    h = _rolling_history(df, "ground_station", pd.Timedelta(hours=1), "st")
    assert h.loc[0, "st_n_past"] == 0
    assert h.loc[1, "st_fail_last5"] == 0.0
    assert h.loc[2, "st_fail_last5"] == 0.5
    assert h.loc[2, "st_hours_since_good"] == pytest.approx(10 - 10 / 60)


def test_tle_epoch_and_antenna_match():
    ep = _tle_epoch("1 25544U 98067A   26297.50000000  .00007800  00000-0  14938-3 0  9992")
    assert ep == pd.Timestamp("2026-10-24T12:00Z")
    ants = [{"frequency": 430e6, "frequency_max": 440e6, "antenna_type": "yagi"}]
    assert _antenna_match(435e6, ants) == (1, 0.0, "directional")
    in_range, dist, _ = _antenna_match(145.8e6, ants)
    assert in_range == 0 and dist == pytest.approx(284.2)


def test_group_conformal_falls_back_to_global():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 400)
    p = np.clip(0.5 + (y - 0.5) * 0.5 + rng.normal(0, 0.2, 400), 0, 1)
    groups = np.where(np.arange(400) < 390, "big", "tiny")
    gc = GroupConformal(min_per_class=40).fit(p, y, groups)
    assert "big" in gc.by_group_ and "tiny" not in gc.by_group_
    d = gc.decide(p, 0.1, groups)
    assert set(d) <= {FAIL, OK, ABSTAIN}


def _synthetic(n=900, seed=0):
    rng = np.random.default_rng(seed)
    health = rng.uniform(0, 1, n)
    elev = rng.uniform(0, 90, n)
    p_nodata = 0.6 * (health < 0.3)
    p_bad = 0.5 * (elev < 25)
    u = rng.uniform(size=n)
    status = np.where(u < p_nodata, "failed", np.where(rng.uniform(size=n) < p_bad, "bad", "good"))
    return pd.DataFrame({
        "station_id": rng.integers(0, 60, n), "health": health, "max_elevation_deg": elev,
        "mode": rng.choice(["FM", "GMSK"], n), "status": status,
    })


def test_v3_models_smoke():
    df = _synthetic()
    y = (df["status"] != "good").astype(int).to_numpy()
    cfg = V3Config(numeric=["health", "max_elevation_deg"], categorical=["mode"], cb_iterations=60)
    single = AbstainV3(cfg, n_inner=3).fit(df, y, df["status"].to_numpy())
    assert set(single.decide(df)["esc17"]) <= {FAIL, OK, ABSTAIN}

    stacked = AbstainV3(V3Config(numeric=cfg.numeric, categorical=cfg.categorical, cb_iterations=60,
                                 use_xgb=True, stacked=True), n_inner=3).fit(df, y, df["status"].to_numpy())
    assert stacked.score(df).shape == (len(df),)

    two = TwoStageV3(cfg, n_inner=3).fit(df, y, df["status"].to_numpy())
    d = two.decide(df)["esc17"]
    assert set(d) <= {FAIL_NODATA, FAIL_BAD, OK, ABSTAIN}
    nodata = d == FAIL_NODATA
    if nodata.sum() > 20:
        assert (df["status"].to_numpy()[nodata] == "failed").mean() > 0.6
