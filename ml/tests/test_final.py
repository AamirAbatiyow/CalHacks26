"""Tests for the v3 causal features, gate, HITL learner and unified fetcher."""

import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from ml import causal_features as cf
from ml import final_model as fm
from ml import hitl
from ml import satnogs_fetcher as sf

T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)


def synthetic_store(n_stations=40, hours=36, seed=0):
    """Observations with station outages (runs of `failed`), noisy good/bad and unvetted passes."""
    rng = np.random.default_rng(seed)
    rows, oid = [], 1
    for s in range(n_stations):
        down = []
        t = 0.0
        while t < hours:
            if rng.random() < 0.25:
                down.append((t, t + rng.uniform(12, 30)))
            t += rng.uniform(6, 12)
        t = rng.uniform(0, 1)
        while t < hours:
            start = T0 + timedelta(hours=t)
            dur = rng.uniform(300, 900)
            is_down = any(a <= t < b for a, b in down)
            if is_down:
                status = "failed"
            else:
                status = rng.choice(["good", "bad", "unknown", "failed"], p=[0.55, 0.15, 0.25, 0.05])
            end = start + timedelta(seconds=dur)
            rows.append({
                "id": oid, "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "ground_station": s, "norad_cat_id": int(rng.integers(1, 15)), "station_lat": 10.0 + s,
                "station_lng": 5.0 * s, "station_alt": 100, "status": status,
                "vetted_datetime": (end + timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%SZ") if status == "bad" else None,
                "waterfall_status_datetime": None, "max_altitude": float(rng.uniform(10, 90)),
                "rise_azimuth": 10.0, "set_azimuth": 200.0, "transmitter_uuid": f"tx{rng.integers(1, 10)}",
                "transmitter_mode": rng.choice(["FM", "BPSK", "GMSK"]), "transmitter_baud": 9600,
                "transmitter_type": "Transmitter", "transmitter_status": "active",
                "transmitter_updated": "2026-01-01T00:00:00Z", "transmitter_unconfirmed": False,
                "transmitter_downlink_low": 437e6, "observation_frequency": 437e6,
                "tle1": "1 25544U 98067A   26270.20915682  .00007800  00000-0  14938-3 0  9992",
                "tle2": "2 25544  51.6335  21.6229 0006885 302.9098  57.1228 15.49030149591753",
                "tle_source": "x", "observer": "op", "fetched_at": "2026-10-10T00:00:00+00:00",
            })
            oid += 1
            t += rng.uniform(0.6, 1.6)
    raw = pd.DataFrame(rows)
    hours_present = [pd.Timestamp(T0) + pd.Timedelta(hours=h) for h in range(hours + 1)]
    stations = {s: {"id": s, "min_horizon": 10, "min_culmination": 20, "altitude": 100,
                    "created": "2020-01-01T00:00:00Z", "owner": "op",
                    "antenna": [{"frequency": 430e6, "frequency_max": 440e6, "band": "UHF", "antenna_type": "yagi"}]}
                for s in range(n_stations)}
    return raw, hours_present, stations


@pytest.fixture(scope="module")
def synth():
    raw, hours, stations = synthetic_store()
    df = cf.build_dataset(raw, stations, cf.KpSeries({}), hours, lag_hours=1.0,
                          lookback_hours=fm.LOOKBACK_H, long_lookback_hours=fm.LONG_LOOKBACK_H)
    return raw, hours, stations, df


def test_label_latency_model():
    raw, _, _ = synthetic_store(n_stations=3, hours=10)
    obs = cf.normalize_observations(raw)
    known = cf.label_known_at(obs, 1.0)
    end = obs["end_ns"].to_numpy()
    st = obs["status"].to_numpy()
    assert np.all(known[st == "failed"] == end[st == "failed"] + cf.NS_PER_H)
    assert np.all(known[st == "unknown"] == cf.NEVER)
    assert np.all(known[st == "bad"] == end[st == "bad"] + 5 * cf.NS_PER_H)


def test_history_is_strictly_causal(synth):
    raw, hours, stations, df = synth
    obs = cf.normalize_observations(raw)
    known = cf.label_known_at(obs, 1.0)
    q = np.where(obs["labeled"])[0][-50:]
    h1 = cf.history_features(obs, known, q)
    # Rewriting every outcome that is not yet known at a row's decision time must not change its features.
    obs2 = obs.copy()
    t_q = obs["start_ns"].to_numpy()[q].min()
    future = known > t_q
    flip = {"good": "failed", "failed": "good", "bad": "good", "unknown": "unknown"}
    obs2.loc[future, "status"] = obs2.loc[future, "status"].map(flip)
    known2 = known.copy()
    known2[future] = np.maximum(known2[future], t_q + 1)
    first = q[obs["start_ns"].to_numpy()[q] == t_q]
    a = cf.history_features(obs, known, first)
    b = cf.history_features(obs2, known2, first)
    pd.testing.assert_frame_equal(a, b)
    assert h1["st_fail_streak"].notna().any()


def test_coverage_excludes_warmup(synth):
    _, _, _, df = synth
    assert df["start_ts"].min() >= pd.Timestamp(T0) + pd.Timedelta(hours=fm.LOOKBACK_H + 1)
    assert {"ground_station", "y", "status"} <= set(df.columns)
    assert not any(c in fm.VARIANTS["full_causal"]["numeric"] for c in ("ground_station", "station_lat", "id"))


def test_pick_threshold_wilson_is_conservative():
    rng = np.random.default_rng(0)
    s = rng.random(2000)
    y = (rng.random(2000) < s ** 0.3).astype(int)
    t_point = fm.pick_threshold(s, y, 0.95, "point")
    t_w = fm.pick_threshold(s, y, 0.95, "wilson")
    t_w80 = fm.pick_threshold(s, y, 0.95, "wilson", z=1.2816)
    assert t_point <= t_w80 <= t_w
    assert t_w is not None and t_point is not None and t_w >= t_point
    flagged = s >= t_w
    assert fm.wilson(y[flagged].sum(), flagged.sum())[0] >= 0.95
    assert fm.pick_threshold(np.zeros(10), np.zeros(10), 0.95) is None


def test_gate_finds_outages_with_high_precision(synth):
    _, _, _, df = synth
    ms, dec = fm.eval_station_cv(df, "full_causal_mono", k=3, rules=("point95", "wilson95"))
    m = ms["point95"]
    assert ms["wilson95"]["fail_flagged"] <= m["fail_flagged"]
    assert m["fail_flagged"] > 20
    assert m["fail_precision"] >= 0.85
    assert m["recall_failed_class"] > m["recall_bad_class"]
    mt, _, _ = fm.eval_time(df, "full_causal_mono")
    assert set(mt) == set(fm.RULES)
    assert mt[fm.DEFAULT_RULE]["n"] > 0 and "unseen_stations" in mt[fm.DEFAULT_RULE]


def test_save_load_and_gate_fields(synth, tmp_path):
    _, _, _, df = synth
    gm = fm.fit_gated(df, "full_causal_mono", inner_folds=3)
    cfg = fm.save_artifacts(gm, "v3.0.0", {"lag_hours": 1.0, "heldout_fail_precision": 0.97}, model_dir=tmp_path)
    gm2, cfg2 = fm.load_gated(model_dir=tmp_path)
    np.testing.assert_allclose(gm.proba(df), gm2.proba(df))
    dec = gm2.decide(df)
    fields = [fm.gate_fields(gm2, cfg2, r) for _, r in dec.iterrows()]
    auto = [f for f in fields if f["route"] == "auto"]
    assert all(f["confidence_percent"] >= 95 for f in auto)
    assert all(f["confidence_percent"] < 95 for f in fields if f["route"] == "human")


def test_hitl_ingest_bumps_version_fast(synth, tmp_path):
    _, _, _, df = synth
    gm = fm.fit_gated(df, "full_causal_mono", inner_folds=3)
    fm.save_artifacts(gm, "v3.0.0", {"lag_hours": 1.0}, model_dir=tmp_path)
    learner = hitl.HitlLearner(df, gm, "v3.0.0", model_dir=tmp_path, full_every=3)
    row = df.iloc[0].to_dict()
    t = time.time()
    out = learner.ingest(row, "failed", pass_id=1, reviewer="t")
    assert out["model_version"] == "v3.0.1" and out["refit"]["kind"] == "warm"
    assert time.time() - t < 10
    learner.ingest(row, "good")
    out = learner.ingest(row, "bad")
    assert out["refit"]["kind"] == "full" and out["model_version"] == "v3.0.3"
    assert fm.load_registry(tmp_path)["current"] == "v3.0.3"
    assert sum(1 for _ in open(tmp_path / "human_labels.jsonl")) == 3


def test_hitl_simulation_runs(synth, monkeypatch, tmp_path):
    raw, hours, stations, _ = synth
    monkeypatch.setattr(fm, "load_raw", lambda prefer_store=True: (raw, hours))
    monkeypatch.setattr(fm, "load_stations", lambda: stations)
    monkeypatch.setattr(fm, "load_kp", lambda: cf.KpSeries({}))
    monkeypatch.setattr(fm, "REPORT_DIR", tmp_path)
    res = hitl.simulate(start_frac=0.4, refit_every_hours=4, modes=("frozen", "full"), n_buckets=3,
                        out_name="sim")
    assert set(res["modes"]) == {"frozen", "full"}
    assert res["modes"]["full"]["refits"]
    assert (tmp_path / "sim.png").exists()


class FakeResp:
    def __init__(self, status, payload=None, headers=None, links=None):
        self.status_code, self._p, self.headers, self.links = status, payload or [], headers or {}, links or {}

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


def test_fetcher_respects_429_and_resumes(tmp_path, monkeypatch):
    monkeypatch.setattr(sf, "STORE", tmp_path)
    monkeypatch.setattr(sf, "HOURS", tmp_path / "hours")
    monkeypatch.setattr(sf, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(sf, "LOG_FILE", tmp_path / "log")
    slept = []
    state = sf.load_state()
    sess = sf.RateLimitedSession(state, sleep=slept.append)
    page1 = [{"id": 1, "start": "2026-10-01T00:10:00Z", "status": "good"}]
    page2 = [{"id": 2, "start": "2026-10-01T00:05:00Z", "status": "failed"}, page1[0]]
    responses = [FakeResp(200, page1, links={"next": {"url": "u2"}}), FakeResp(429, headers={"Retry-After": "30"}),
                 FakeResp(200, page2)]
    monkeypatch.setattr(sess.s, "get", lambda url, params=None, timeout=None: responses.pop(0))
    n = sf.fetch_hour(sess, T0)
    assert n == 2  # deduplicated
    assert any(s >= 35 for s in slept)
    assert state["n_429"] == 1 and state["budget_per_hour"] < 70
    assert sf.fetch_hour(sess, T0) == 2  # cached, no request
    st = sf.store_status()
    assert st["labeled"] == 2 and st["hours_stored"] == 1


def test_rate_budget_spreads_requests():
    state = {"request_times": [], "budget_per_hour": 60}
    sess = sf.RateLimitedSession(state, sleep=lambda s: None)
    now = 1_000_000.0
    assert sess.wait_time(now) == 0
    state["request_times"] = [now - 10]
    assert 49 <= sess.wait_time(now) <= 51
    state["request_times"] = [now - 3500 + i for i in range(60)]
    assert sess.wait_time(now) >= 99


def test_next_hour_prefers_forward_edge_then_backfill(tmp_path, monkeypatch):
    monkeypatch.setattr(sf, "HOURS", tmp_path)
    now = datetime(2026, 10, 10, 12, 30, tzinfo=timezone.utc)
    anchor = datetime(2026, 10, 1, tzinfo=timezone.utc)
    h, _ = sf.next_hour_to_fetch(now, 72, anchor, None, {})
    assert h == datetime(2026, 10, 7, 11, tzinfo=timezone.utc)
    (tmp_path / f"{h:%Y%m%dT%H}.json").write_text(json.dumps({"observations": [], "fetched_at": now.isoformat()}))
    h2, _ = sf.next_hour_to_fetch(now, 72, anchor, None, {})
    assert h2 == h - timedelta(hours=1)
    h3, _ = sf.next_hour_to_fetch(now + timedelta(hours=2), 72, anchor, None, {})
    assert h3 == h + timedelta(hours=1)


def test_featurize_matches_training_features(synth, monkeypatch):
    raw, hours, stations, df = synth
    monkeypatch.setattr(fm, "load_stations", lambda: stations)
    monkeypatch.setattr(fm, "load_kp", lambda: cf.KpSeries({}))
    row = df.iloc[-1]
    new = raw[raw["id"] == row["id"]]
    context = raw[raw["id"] != row["id"]]
    X = fm.featurize(new, context, lag_hours=1.0)
    for c in ("st_fail_streak", "st_failed_frac", "sat_good_frac", "elev_margin_deg"):
        a, b = X.iloc[0][c], row[c]
        assert (pd.isna(a) and pd.isna(b)) or a == pytest.approx(b), c
    # A human ruling on the last escalated pass makes it count immediately.
    prev = context[context["ground_station"] == row["ground_station"]].iloc[-1]
    X2 = fm.featurize(new, context, lag_hours=24.0, human_known={int(prev["id"]): prev["end"]})
    X3 = fm.featurize(new, context, lag_hours=24.0)
    assert X2.iloc[0]["st_n"] >= X3.iloc[0]["st_n"]


def test_features_ignore_unresolved_rows(synth):
    raw, hours, stations, df = synth
    no_unknown = raw[raw["status"] != "unknown"]
    df2 = cf.build_dataset(no_unknown, stations, cf.KpSeries({}), hours, lag_hours=1.0,
                           lookback_hours=fm.LOOKBACK_H, long_lookback_hours=fm.LONG_LOOKBACK_H)
    cols = cf.HISTORY_FEATURES
    pd.testing.assert_frame_equal(df[cols].reset_index(drop=True), df2[cols].reset_index(drop=True))


def test_fetch_hour_by_status(tmp_path, monkeypatch):
    monkeypatch.setattr(sf, "STORE", tmp_path)
    monkeypatch.setattr(sf, "HOURS", tmp_path / "hours")
    monkeypatch.setattr(sf, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(sf, "LOG_FILE", tmp_path / "log")
    sess = sf.RateLimitedSession(sf.load_state(), sleep=lambda s: None)
    calls = []

    def fake_get(url, params=None, timeout=None):
        calls.append(params["status"])
        return FakeResp(200, [{"id": len(calls), "start": "2026-10-01T00:10:00Z", "status": params["status"]}])
    monkeypatch.setattr(sess.s, "get", fake_get)
    assert sf.fetch_hour(sess, T0, statuses=sf.LABELED) == 3
    assert calls == list(sf.LABELED)
    assert json.load(open(sf.hour_path(T0)))["statuses"] == list(sf.LABELED)
    assert not list((tmp_path / "hours").glob("*.part"))
