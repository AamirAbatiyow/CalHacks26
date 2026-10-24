"""Tests for the v3.2 policy layer."""

import numpy as np
import pandas as pd
import pytest

from ml import causal_features as cf
from ml import final_model as fm
from ml import policies as P
from ml.tests.test_final import synthetic_store


def with_artifacts(raw: pd.DataFrame, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    raw = raw.copy()
    st = raw["status"].to_numpy()
    raw["has_waterfall"] = st != "failed"
    raw["has_payload"] = st != "failed"
    raw["n_demoddata"] = np.where((st == "good") & (rng.random(len(raw)) < 0.6), rng.integers(1, 20, len(raw)), 0)
    return raw


@pytest.fixture(scope="module")
def pdata():
    raw, hours, stations = synthetic_store()
    raw = with_artifacts(raw)
    ds = cf.build_dataset(raw, stations, cf.KpSeries({}), hours, lag_hours=1.0,
                          lookback_hours=fm.LOOKBACK_H, long_lookback_hours=fm.LONG_LOOKBACK_H)
    obs = cf.normalize_observations(raw)
    known = cf.label_known_at(obs, 1.0)
    pos = pd.Series(np.arange(len(obs)), index=obs["id"].to_numpy())
    q = pos.loc[ds["id"].to_numpy()].to_numpy()
    df = pd.concat([ds, P.decision_features(obs, known, q, 1.0).reset_index(drop=True)], axis=1)
    return raw, obs, known, q, df


def test_decision_features_ignore_own_and_unknown_outcomes(pdata):
    raw, obs, known, q, df = pdata
    qi = q[-40:]
    a = P.decision_features(obs, known, qi, 1.0)
    # Flipping the pass's own label, or any outcome not known by end + lag, must not change dt_/co_ features.
    obs2 = obs.copy()
    T_min = obs["end_ns"].to_numpy()[qi].min() + cf.NS_PER_H
    future = known > T_min
    future[qi] = True
    flip = {"good": "failed", "failed": "good", "bad": "good", "unknown": "unknown"}
    obs2.loc[future, "status"] = obs2.loc[future, "status"].map(flip)
    known2 = known.copy()
    known2[future] = np.maximum(known2[future], T_min + 1)
    first = qi[obs["end_ns"].to_numpy()[qi] + cf.NS_PER_H == T_min]
    cols = P.DT + P.CO
    pd.testing.assert_frame_equal(P.decision_features(obs, known, first, 1.0)[cols],
                                  P.decision_features(obs2, known2, first, 1.0)[cols])
    assert (a["own_artifacts"] == 0).sum() == (obs["status"].to_numpy()[qi] == "failed").sum()


def test_hand_rules_tuned_on_residual():
    n = 400
    df = pd.DataFrame({"y": np.r_[np.ones(200), np.zeros(200)].astype(int),
                       "own_artifacts": np.r_[np.zeros(150), np.ones(250)],
                       "dt_st_fail_streak": np.r_[np.full(150, 5), np.full(40, 3), np.full(10, 0), np.full(200, 0)],
                       "own_n_demod": np.r_[np.zeros(200), np.full(200, 3)],
                       "ground_station": np.arange(n) % 20})
    pols = P.tune_hand_rules(df, None, ("ops_evidence",))
    assert [p.id for p in pols] == ["ops-no-artifacts", "ops-decoded-frames"]
    decided = np.zeros(n, bool)
    for p in pols:
        decided |= p.mask(df)
    rest = P.tune_hand_rules(df, {"ops-outage-streak"}, ("ops_history",), decided)
    # Only the 40 undecided streak-3 passes count; 40/40 clears Wilson80 >= 0.95.
    assert rest and rest[0].train_n == 40 and rest[0].conditions == [("dt_st_fail_streak", ">=", 1.0)]


def test_fit_apply_first_match_and_cedar(pdata):
    _, _, _, _, df = pdata
    ps = P.fit_policies(df, "B", 0)
    ids = [p.id for p in ps.policies]
    assert ids[:2] == ["ops-no-artifacts", "ops-decoded-frames"]
    dec = ps.apply(df)
    assert set(dec["decision"]) <= {"failed", "ok", "escalate"}
    assert (dec.loc[df["own_artifacts"] == 0, "policy"] == "ops-no-artifacts").all()
    m = P.metrics(df, dec)
    assert m["fail_precision"] >= 0.95 and m["ok_precision"] >= 0.95
    code = ps.policies[0].cedar()
    assert 'GroundTruth::Action::"auto_decide_failed"' in code and "context.own_artifacts == 0" in code
    a = P.fit_policies(df, "A", 0)
    assert not any(p.group == "ops_evidence" for p in a.policies)
    assert not any(c[0] in P.OWN for p in a.policies for c in p.conditions)


def test_evaluate_tier_reports_groups(pdata):
    _, _, _, _, df = pdata
    res = P.evaluate_tier(df, "B", k=3)
    for split in ("station_cv", "time"):
        g = res[split]["groups"]
        assert "ops-no-artifacts" in g and "marginal_coverage" in g["ops-no-artifacts"]
        assert 0 <= res[split]["escalated"] <= 1
    assert "ops-no-artifacts" in P.helpful_groups(res)


def test_decide_observations_with_shipped_policies():
    raw, _ = fm.load_raw()
    raw = raw.sort_values("start")
    new, ctx = raw.tail(30), raw.iloc[:-30]
    out = P.decide_observations(new, ctx)
    assert len(out) == 30
    rules = {r["rule_id"] for r in P.load_policies()[1]["rules"]}
    for o in out:
        assert o["policy_version"] == P.POLICY_VERSION and o["model_version"] == "v3.1.0"
        if o["route"] == "auto":
            assert o["rule_id"] in rules and o["confidence_percent"] >= 95
        else:
            assert o["rule_id"] is None and o["confidence_percent"] < 95
    no_art = (~new["has_waterfall"].fillna(False).astype(bool)) & (~new["has_payload"].fillna(False).astype(bool))
    got = {o["pass_id"]: o for o in out}
    assert all(got[i]["decision"] == "failed" for i in new.loc[no_art, "id"])
