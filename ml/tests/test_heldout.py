"""Tests for leakage-safe evaluation, station-state features and the gate mapping."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from ml import datasets as ds
from ml import heldout_eval as he
from ml.data_loader import generate_synthetic_observations
from ml.features import prepare_features
from ml.gate import build_gate, gate_decision


def _toy_passes():
    t0 = pd.Timestamp("2026-10-23T00:00:00Z")
    rows = []
    # Station 1: passes every 2h, failing from 06:00 on.
    for k in range(6):
        rows.append({"station_id": 1, "t": t0 + pd.Timedelta(hours=2 * k), "duration_sec": 600,
                     "status": "failed" if k >= 3 else "good"})
    rows.append({"station_id": 2, "t": t0 + pd.Timedelta(hours=7), "duration_sec": 600,
                 "status": "failed"})
    return pd.DataFrame(rows)


class TestStationRecentState:
    def test_uses_only_passes_known_before_lag(self):
        df = _toy_passes()
        rs = ds.station_recent_state(df, lag_hours=1)
        # 00:00 pass: nothing earlier.
        assert rs.loc[0, "recent_n"] == 0
        assert np.isnan(rs.loc[0, "recent_failed_frac"])
        # 06:00 pass (first failure): earlier passes are all good, its own label unseen.
        assert rs.loc[3, "recent_n"] == 3
        assert rs.loc[3, "recent_failed_frac"] == 0
        assert rs.loc[3, "last_known_failed"] == 0
        # 08:00 pass sees the 06:00 failure (ended 06:10, > 1h before 08:00).
        assert rs.loc[4, "last_known_failed"] == 1

    def test_lag_hides_recent_outcomes(self):
        df = _toy_passes()
        rs = ds.station_recent_state(df, lag_hours=3)
        # With a 3h lag the 08:00 pass cannot see the 06:00 failure yet.
        assert rs.loc[4, "last_known_failed"] == 0

    def test_other_stations_do_not_leak(self):
        df = _toy_passes()
        rs = ds.station_recent_state(df, lag_hours=1)
        assert rs.loc[6, "recent_n"] == 0


class TestStationHistory:
    def test_unseen_station_gets_prior(self):
        train = pd.DataFrame({"station_id": [1, 1, 1, 2], "y": [1, 1, 1, 0]})
        test = pd.DataFrame({"station_id": [3, 1]})
        h = ds.station_history_features(train, test, prior_strength=0)
        assert h.loc[0, "station_fail_rate"] == pytest.approx(0.75)
        assert h.loc[0, "station_n_train"] == 0
        assert h.loc[1, "station_fail_rate"] == pytest.approx(1.0)


class TestSplits:
    def test_station_split_has_disjoint_stations(self):
        rng = np.random.default_rng(0)
        df = pd.DataFrame({"station_id": rng.integers(0, 40, 600), "y": rng.integers(0, 2, 600),
                           "t": pd.date_range("2026-10-01", periods=600, freq="10min", tz="UTC")})
        for tr, te in he._splitter("station", df, 5, 42):
            assert not set(df.station_id.iloc[tr]) & set(df.station_id.iloc[te])

    def test_time_split_is_forward(self):
        df = pd.DataFrame({"station_id": 1, "y": 0,
                           "t": pd.date_range("2026-10-01", periods=100, freq="h", tz="UTC")})
        (tr, te), = he._splitter("time", df.sample(frac=1, random_state=0).reset_index(drop=True), 5, 0)
        shuffled = df.sample(frac=1, random_state=0).reset_index(drop=True)
        assert shuffled.t.iloc[tr].max() < shuffled.t.iloc[te].min()


class TestThreshold:
    def test_reaches_target(self):
        scores = np.linspace(0, 1, 200)
        y = (scores > 0.5).astype(int)
        y[150] = 0  # one false positive among the top
        thr = he.threshold_for_precision(scores, y, 0.95, min_flagged=10)
        flagged = scores >= thr
        assert y[flagged].mean() >= 0.95
        assert flagged.sum() >= 90

    def test_returns_none_when_unreachable(self):
        scores = np.linspace(0, 1, 100)
        y = np.zeros(100, dtype=int)
        assert he.threshold_for_precision(scores, y, 0.9) is None

    def test_wilson_interval_brackets_point(self):
        lo, hi = he.wilson_interval(95, 100)
        assert lo < 0.95 < hi


class TestGate:
    gate = build_gate([
        {"target": 0.90, "threshold": 0.70, "heldout_precision": 0.91},
        {"target": 0.95, "threshold": 0.90, "heldout_precision": 0.947},
        {"target": 0.98, "threshold": 0.96, "heldout_precision": 0.962},
    ])

    def test_auto_threshold_uses_measured_precision(self):
        # 0.95 target measured 0.947 on held-out stations, so auto starts at the 0.98 point.
        assert self.gate["auto_threshold"] == 0.96

    def test_auto_route_only_above_auto_threshold(self):
        d = gate_decision(0.97, self.gate)
        assert d["route"] == "auto" and d["confidence_percent"] >= 95

    def test_high_but_not_auto_goes_to_human_approval(self):
        d = gate_decision(0.92, self.gate)
        assert d["route"] == "human" and 80 <= d["confidence_percent"] < 95

    def test_low_scores_escalate(self):
        d = gate_decision(0.4, self.gate)
        assert d["route"] == "human" and d["confidence_percent"] < 80


def test_heldout_pipeline_end_to_end(tmp_path):
    from ml.score import PassFailureModel
    from ml.train import train_heldout_and_save

    df = he.load_dataset("v110_census")
    result = train_heldout_and_save("test_heldout", output_dir=tmp_path, df=df.assign(source="v110_census"))
    assert "station_id" not in result["config"]["feature_names"]
    assert result["metrics"]["heldout_station"]["auc_roc"] > 0.6

    model = PassFailureModel(model_dir=tmp_path, version="test_heldout")
    sample = df.sample(5, random_state=0)
    preds = model.predict_with_shap(sample, pass_ids=sample["pass_id"].tolist())
    for p in preds:
        d = p.to_dict()
        assert 0 <= d["failure_probability"] <= 1
        assert d["gate_route"] in ("auto", "human")
        assert 0 <= d["gate_confidence_percent"] <= 100


def test_station_id_not_a_feature():
    df = generate_synthetic_observations(n_samples=50)
    _, features = prepare_features(df)
    assert "station_id" not in features


def test_solar_elevation_noon_vs_midnight():
    t = pd.Series(pd.to_datetime(["2026-06-21T12:00:00Z", "2026-06-21T00:00:00Z"], utc=True))
    el = ds.solar_elevation_deg(t, pd.Series([51.5, 51.5]), pd.Series([0.0, 0.0]))
    assert el[0] == pytest.approx(62, abs=1.5)
    assert el[1] < -10


def test_tle_epoch_parse():
    line = "1 63235U 25052AB  26296.65823596  .00006682  00000-0  26617-3 0  9999"
    epoch = ds.tle_epoch(pd.Series([line])).iloc[0]
    assert epoch.year == 2026 and epoch.dayofyear == 296
