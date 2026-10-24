"""Tests for the calibrated ensemble + split-conformal abstention model."""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from ml.conformal_ensemble import (
    ABSTAIN, CATEGORICAL_FEATURES, FAIL, NUMERIC_FEATURES, OK,
    AbstainingPassModel, EnsembleConfig, MondrianConformal, SatelliteTargetEncoder,
    build_features, complete_sampling_window, decision_metrics, get_target,
    load_passes, load_station_meta,
)


@pytest.fixture(scope="module")
def data():
    df = load_passes()
    return df, load_station_meta()


def test_leaky_columns_are_not_features():
    feats = set(NUMERIC_FEATURES + CATEGORICAL_FEATURES)
    for leaky in ("station_id", "station_name", "kp_at_time", "kp_latitude_risk",
                  "start_time", "pass_id", "station_status"):
        assert leaky not in feats


def test_build_features_covers_all_stations(data):
    df, st = data
    X = build_features(df, st)
    assert len(X) == len(df)
    assert X["station_age_days"].notna().mean() > 0.95
    assert (X["elevation_margin_deg"] <= X["max_elevation_deg"]).all()


def test_complete_sampling_window_has_every_status(data):
    df, _ = data
    w = complete_sampling_window(df)
    assert 0 < w.sum() < len(df)
    assert set(df.loc[w, "status"]) == {"good", "bad", "failed"}


def test_satellite_encoder_uses_only_fit_rows():
    X = pd.DataFrame({"satellite_norad_id": [1, 1, 2, 2], "transmitter_mode": ["FM"] * 4})
    y = np.array([1, 1, 0, 0])
    status = np.array(["bad", "failed", "good", "good"])
    enc = SatelliteTargetEncoder(smoothing=0.0).fit(X, y, status)
    out = enc.transform(pd.DataFrame({"satellite_norad_id": [1, 2, 3], "transmitter_mode": ["FM"] * 3}))
    assert out["sat_fail_rate_te"].tolist() == [1.0, 0.0, 0.5]
    assert out["sat_bad_rate_te"].iloc[0] == 0.5


def test_mondrian_conformal_class_conditional_coverage():
    rng = np.random.default_rng(0)
    n = 20000
    y = rng.integers(0, 2, n)
    p = np.clip(0.5 + (y - 0.5) * 0.4 + rng.normal(0, 0.25, n), 0, 1)
    cal, test = slice(0, n // 2), slice(n // 2, n)
    conf = MondrianConformal().fit(p[cal], y[cal])
    for alpha in (0.05, 0.1, 0.2):
        d = conf.decide(p[test], alpha)
        yt = y[test]
        assert np.mean(np.isin(d[yt == 1], [FAIL, ABSTAIN])) >= 1 - alpha - 0.02
        assert np.mean(np.isin(d[yt == 0], [OK, ABSTAIN])) >= 1 - alpha - 0.02


def test_smaller_alpha_escalates_more():
    rng = np.random.default_rng(1)
    y = rng.integers(0, 2, 2000)
    p = np.clip(0.5 + (y - 0.5) * 0.3 + rng.normal(0, 0.25, 2000), 0, 1)
    conf = MondrianConformal().fit(p, y)
    esc = [np.mean(conf.decide(p, a) == ABSTAIN) for a in (0.02, 0.1, 0.2)]
    assert esc[0] > esc[1] > esc[2]


def test_zero_alpha_disables_a_side():
    conf = MondrianConformal().fit(np.array([0.1, 0.2, 0.8, 0.9]), np.array([0, 0, 1, 1]))
    d = conf.decide(np.array([0.05, 0.95]), (0.4, 0.0))
    assert FAIL not in set(d)


def test_decision_metrics_counts():
    y = np.array([1, 1, 0, 0, 1, 0])
    d = np.array([FAIL, OK, OK, FAIL, ABSTAIN, ABSTAIN], dtype=object)
    m = decision_metrics(y, d)
    assert m["confusion_auto"] == {"tp": 1, "fp": 1, "tn": 1, "fn": 1}
    assert m["coverage"] == pytest.approx(4 / 6)
    assert m["precision_fail"] == pytest.approx(0.5)


def test_model_fit_predict_smoke(data):
    df, st = data
    df = df.sample(600, random_state=0).reset_index(drop=True)
    X = build_features(df, st)
    cfg = EnsembleConfig(catboost_iterations=50)
    model = AbstainingPassModel(config=cfg, n_inner=3).fit(X, get_target(df), df["status"].to_numpy())
    out = model.predict(X.head(50))
    assert set(out["decision"]) <= {FAIL, OK, ABSTAIN}
    assert out["failure_probability"].between(0, 1).all()
    assert "demo" in model.alphas_ and "precision_0.95" in model.alphas_
