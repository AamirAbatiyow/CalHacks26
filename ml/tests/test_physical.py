import numpy as np
import pandas as pd
import pytest

from ml.physical_features import (
    _band, _bstar, _tle2_elements, _tle_epoch, _tle_launch_year, add_history_features,
    geomagnetic_abs_lat, solar_elevation_deg,
)
from ml.evaluate_physical import band_metrics, pick_thresholds

TLE1 = "1 43017U 17073E   26150.61112050  .00012250  00000-0  53366-3 0  9999"
TLE2 = "2 43017  97.4731  18.1891 0152418  29.9783 331.0066 15.12376389462731"


def test_tle_parsing():
    epoch = _tle_epoch(TLE1)
    assert epoch.year == 2026 and epoch.day_of_year == 150
    assert _tle_launch_year(TLE1) == 2017
    assert _bstar(TLE1) == pytest.approx(0.53366e-3)
    inc, ecc, mm = _tle2_elements(TLE2)
    assert inc == pytest.approx(97.4731)
    assert ecc == pytest.approx(0.0152418)
    assert mm == pytest.approx(15.12376389)


def test_band():
    assert _band(145.9) == "VHF"
    assert _band(437.5) == "UHF"
    assert _band(2401.0) == "S"
    assert _band(float("nan")) == "unknown"


def test_solar_elevation_noon_and_midnight():
    ts = pd.Series(pd.to_datetime(["2026-06-21T12:00:00Z", "2026-06-21T00:00:00Z"], utc=True))
    elev, hour = solar_elevation_deg(ts, np.array([0.0, 0.0]), np.array([0.0, 0.0]))
    assert elev[0] == pytest.approx(90 - 23.44, abs=1.0)
    assert elev[1] < -60
    assert hour[0] == pytest.approx(12, abs=0.3)


def test_geomagnetic_latitude_pole():
    assert geomagnetic_abs_lat(np.array([80.8]), np.array([-72.6]))[0] == pytest.approx(90, abs=0.01)


def _frame(rows):
    df = pd.DataFrame(rows, columns=["ground_station", "norad_cat_id", "transmitter_uuid", "band", "start", "label_fail"])
    df["start_ts"] = pd.to_datetime(df["start"], utc=True)
    df["end_ts"] = df["start_ts"] + pd.Timedelta(minutes=10)
    return df


def test_history_uses_only_past_train_labels_with_lag():
    train = _frame([
        (1, 100, "a", "UHF", "2026-01-01T00:00:00Z", 1),
        (1, 100, "a", "UHF", "2026-01-03T00:00:00Z", 1),
        (1, 100, "a", "UHF", "2026-01-03T05:00:00Z", 0),
    ])
    test = _frame([(1, 100, "a", "UHF", "2026-01-10T00:00:00Z", 0),
                   (2, 100, "a", "UHF", "2026-01-10T00:00:00Z", 1)])
    tr, te = add_history_features(train, test, lag_hours=24, smoothing=0.0)
    # first pass: no history; second: sees only the first (2 days earlier); third: also only the first
    assert list(np.expm1(tr["station_hist_log_n"]).round()) == [0, 1, 1]
    assert tr["station_hist_rate"].iloc[1] == 0.0
    # test row sees all 3 train passes, never its own label
    assert np.expm1(te["station_hist_log_n"].iloc[0]).round() == 3
    assert te["station_hist_rate"].iloc[0] == pytest.approx(1 / 3)
    # unseen station is cold-start but satellite history is still available
    assert te["station_hist_log_n"].iloc[1] == 0
    assert np.expm1(te["sat_hist_log_n"].iloc[1]).round() == 3


def test_history_ignores_test_labels():
    train = _frame([(1, 100, "a", "UHF", "2026-01-01T00:00:00Z", 0)])
    test_a = _frame([(1, 100, "a", "UHF", "2026-01-05T00:00:00Z", 0),
                     (1, 100, "a", "UHF", "2026-01-09T00:00:00Z", 0)])
    test_b = test_a.assign(label_fail=1)
    _, ha = add_history_features(train, test_a)
    _, hb = add_history_features(train, test_b)
    cols = [c for c in ha.columns if "hist" in c]
    pd.testing.assert_frame_equal(ha[cols], hb[cols])


def test_station_window_history():
    train = _frame([
        (1, 100, "a", "UHF", "2026-01-01T00:00:00Z", 1),
        (1, 100, "a", "UHF", "2026-02-01T00:00:00Z", 0),
    ])
    test = _frame([(1, 100, "a", "UHF", "2026-02-10T00:00:00Z", 0)])
    _, te = add_history_features(train, test, smoothing=0.0)
    assert np.expm1(te["station_hist_log_n"].iloc[0]).round() == 2
    assert np.expm1(te["station_14d_hist_log_n"].iloc[0]).round() == 1
    assert te["station_14d_hist_rate"].iloc[0] == 1.0


def test_thresholds_hit_target_precision():
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 5000)
    p = np.clip(y * 0.5 + rng.normal(0.25, 0.2, 5000), 0, 1)
    for target in (0.95, 0.98):
        t_ok, t_fail = pick_thresholds(y, p, target)
        m = band_metrics(y, p, t_ok, t_fail)
        assert m["fail_precision"] >= target
        assert m["ok_precision"] >= target
        assert 0 <= m["escalate_share"] <= 1
        assert t_ok < t_fail
