"""
Honest held-out evaluation of the physical-feature pass-failure model (v2).

Two regimes, both with history features recomputed from the training fold only:
  * GroupKFold(5) by ground station - every test station is unseen in training,
    so its station-history features are cold-start (n = 0).
  * Forward time split - train on the first 80% of the timeline, test on the
    last 20%; test passes see station/satellite history frozen at the cutoff.

Escalation policy: P(fail) >= t_fail -> auto "will fail"; P(fail) <= t_ok ->
auto "will succeed"; anything between goes to a human. Thresholds are chosen
on an inner validation slice of the *training* fold to hit the target
precision, then applied unchanged to the test fold (we report the precision
actually achieved there, which can fall short of the target).

Usage:
    python -m ml.evaluate_physical [--save-model]
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.model_selection import GroupKFold

from .physical_features import (
    CATEGORICAL_FEATURES, HISTORY_FEATURES, NUMERIC_FEATURES, add_history_features,
    build_dataset, feature_matrix, load_raw_observations,
)

OUT_DIR = Path(__file__).parent / "models" / "physical"
REPORT_DIR = Path(__file__).parent / "reports"
PRECISION_TARGETS = (0.95, 0.98)

PARAMS = {
    "objective": "binary",
    "metric": "binary_logloss",
    "learning_rate": 0.03,
    "num_leaves": 31,
    "min_child_samples": 40,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "cat_smooth": 20,
    "verbose": -1,
    "seed": 42,
    "num_threads": 8,
}

FEATURE_SETS = {
    "physical+history": NUMERIC_FEATURES + CATEGORICAL_FEATURES + HISTORY_FEATURES,
    "physical_only": NUMERIC_FEATURES + CATEGORICAL_FEATURES,
    "history_only": HISTORY_FEATURES,
    # Leakage reference only: what the score looks like if raw station id is allowed.
    "LEAKY_raw_station_id+physical": NUMERIC_FEATURES + CATEGORICAL_FEATURES + ["station_id_cat"],
}


def _categories(train: pd.DataFrame, feats: List[str]) -> Dict[str, List[str]]:
    cats = [c for c in feats if c in CATEGORICAL_FEATURES or c == "station_id_cat"]
    return {c: sorted(train[c].astype(str).unique()) for c in cats}


def _fit(tr: pd.DataFrame, va: pd.DataFrame, feats: List[str], cats, num_rounds=None):
    Xtr = feature_matrix(tr, feats, cats)
    dtr = lgb.Dataset(Xtr, tr["label_fail"], categorical_feature=[c for c in feats if c in cats])
    if num_rounds is None:
        Xva = feature_matrix(va, feats, cats)
        dva = lgb.Dataset(Xva, va["label_fail"], reference=dtr)
        m = lgb.train(PARAMS, dtr, 3000, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(100, verbose=False)])
        return m, m.best_iteration
    return lgb.train(PARAMS, dtr, num_rounds), num_rounds


def pick_thresholds(y: np.ndarray, p: np.ndarray, target: float) -> Tuple[float, float]:
    """(t_ok, t_fail) maximising coverage subject to precision >= target on each side."""
    order = np.argsort(-p)
    ys, ps = y[order], p[order]
    prec_fail = np.cumsum(ys) / np.arange(1, len(ys) + 1)
    ok = np.where(prec_fail >= target)[0]
    t_fail = float(ps[ok.max()]) if len(ok) else 1.0 + 1e-9
    order = np.argsort(p)
    ys, ps = y[order], p[order]
    prec_ok = np.cumsum(1 - ys) / np.arange(1, len(ys) + 1)
    ok = np.where(prec_ok >= target)[0]
    t_ok = float(ps[ok.max()]) if len(ok) else -1e-9
    if t_ok >= t_fail:
        t_ok = np.nextafter(t_fail, -1)
    return t_ok, t_fail


def band_metrics(y: np.ndarray, p: np.ndarray, t_ok: float, t_fail: float) -> dict:
    auto_fail = p >= t_fail
    auto_ok = p <= t_ok
    middle = ~(auto_fail | auto_ok)
    nf, ns = max(y.sum(), 1), max((1 - y).sum(), 1)
    decided = auto_fail | auto_ok
    pred = np.where(auto_fail, 1, 0)
    return {
        "t_ok": t_ok, "t_fail": t_fail,
        "fail_precision": float(y[auto_fail].mean()) if auto_fail.any() else None,
        "fail_recall": float(y[auto_fail].sum() / nf),
        "ok_precision": float(1 - y[auto_ok].mean()) if auto_ok.any() else None,
        "ok_recall": float((1 - y[auto_ok]).sum() / ns),
        "auto_accuracy": float((pred[decided] == y[decided]).mean()) if decided.any() else None,
        "escalate_share": float(middle.mean()),
        "auto_share": float(decided.mean()),
    }


def oracle_recall_at_precision(y, p, target):
    t_ok, t_fail = pick_thresholds(y, p, target)
    return band_metrics(y, p, t_ok, t_fail)


def summarize(y: np.ndarray, p: np.ndarray) -> dict:
    return {
        "n": int(len(y)),
        "fail_rate": float(y.mean()),
        "auc_roc": float(roc_auc_score(y, p)),
        "auc_pr_fail": float(average_precision_score(y, p)),
        "brier": float(brier_score_loss(y, p)),
        "accuracy_at_0.5": float(((p >= 0.5) == y).mean()),
        "majority_baseline_accuracy": float(max(y.mean(), 1 - y.mean())),
        "precision_fail_at_0.5": float(y[p >= 0.5].mean()) if (p >= 0.5).any() else None,
    }


def _inner_splits(train: pd.DataFrame, inner_split: str):
    if inner_split == "time":
        cut = train["start_ts"].quantile(0.8)
        yield np.where(train["start_ts"] < cut)[0], np.where(train["start_ts"] >= cut)[0]
    else:
        yield from GroupKFold(n_splits=4).split(train, groups=train["ground_station"])


def run_fold(train: pd.DataFrame, test: pd.DataFrame, feats: List[str], inner_split: str):
    """Inner validation inside train -> iterations + thresholds; refit on all train -> test.

    Station-grouped regime: thresholds come from inner 4-fold GroupKFold
    out-of-fold predictions (so they are calibrated on unseen stations).
    Time regime: from a forward split (last 20% of the training period).
    """
    ys, ps, iters = [], [], []
    for a, b in _inner_splits(train, inner_split):
        itr, iva = add_history_features(train.iloc[a], train.iloc[b])
        cats = _categories(itr, feats)
        m_inner, best = _fit(itr, iva, feats, cats)
        ps.append(m_inner.predict(feature_matrix(iva, feats, cats)))
        ys.append(iva["label_fail"].values)
        iters.append(best)
    y_val, p_val = np.concatenate(ys), np.concatenate(ps)
    best = int(np.mean(iters))
    thresholds = {t: pick_thresholds(y_val, p_val, t) for t in PRECISION_TARGETS}

    tr, te = add_history_features(train, test)
    cats = _categories(tr, feats)
    model, _ = _fit(tr, None, feats, cats, num_rounds=max(best, 50))
    p_test = model.predict(feature_matrix(te, feats, cats))
    return p_test, thresholds, model, cats


def evaluate_regime(df: pd.DataFrame, regime: str, feats: List[str]) -> dict:
    y_all, p_all, fold_bands = [], [], {t: [] for t in PRECISION_TARGETS}
    imp = pd.Series(0.0, index=feats)
    if regime == "group_kfold_station":
        splits = GroupKFold(n_splits=5).split(df, groups=df["ground_station"])
        inner = "group"
    else:
        cut = df["start_ts"].quantile(0.8)
        splits = [(np.where(df["start_ts"] < cut)[0], np.where(df["start_ts"] >= cut)[0])]
        inner = "time"
    for k, (a, b) in enumerate(splits):
        train, test = df.iloc[a], df.iloc[b]
        p, thr, model, _ = run_fold(train, test, feats, inner)
        y = test["label_fail"].values
        y_all.append(y)
        p_all.append(p)
        for t in PRECISION_TARGETS:
            fold_bands[t].append((y, p, *thr[t]))
        imp += pd.Series(model.feature_importance("gain"), index=feats)
    y, p = np.concatenate(y_all), np.concatenate(p_all)
    out = summarize(y, p)
    for t in PRECISION_TARGETS:
        yy = np.concatenate([f[0] for f in fold_bands[t]])
        auto_fail = np.concatenate([f[1] >= f[3] for f in fold_bands[t]])
        auto_ok = np.concatenate([f[1] <= f[2] for f in fold_bands[t]])
        # Per-fold thresholds pooled into one decision vector for reporting.
        decision = np.where(auto_fail, 1.0, np.where(auto_ok, 0.0, 0.5))
        pol = band_metrics(yy, decision, 0.25, 0.75)
        del pol["t_ok"], pol["t_fail"]
        out[f"policy_p{int(t*100)}_val_thresholds"] = pol
        pol["thresholds_per_fold"] = [
            {"t_ok": round(f[2], 4), "t_fail": round(f[3], 4)} for f in fold_bands[t]]
        out[f"policy_p{int(t*100)}_oracle_on_test"] = oracle_recall_at_precision(y, p, t)
    out["gain_importance"] = (imp / imp.sum()).sort_values(ascending=False).round(4).to_dict()
    return out


def dataset_stats(raw: pd.DataFrame, df: pd.DataFrame) -> dict:
    vc = raw["status"].value_counts().to_dict()
    return {
        "raw_observations": int(len(raw)),
        "raw_status_counts": {k: int(v) for k, v in vc.items()},
        "vetted_share": float(raw["status"].isin(["good", "bad", "failed"]).mean()),
        "labeled_passes": int(len(df)),
        "label_counts": {k: int(v) for k, v in df["status"].value_counts().items()},
        "fail_rate": float(df["label_fail"].mean()),
        "stations": int(df["ground_station"].nunique()),
        "satellites": int(df["norad_cat_id"].nunique()),
        "transmitters": int(df["transmitter_uuid"].nunique()),
        "sampling_windows_hours": int(df["start_ts"].dt.floor("h").nunique()),
        "time_span": [str(df["start_ts"].min()), str(df["start_ts"].max())],
        "top_station_share": float(df["ground_station"].value_counts(normalize=True).iloc[0]),
        "kp_coverage": float(df["kp_at_time"].notna().mean()),
        "station_meta_coverage": float(df["station_min_horizon_deg"].notna().mean()),
    }


def train_final(df: pd.DataFrame, feats: List[str]) -> Tuple[lgb.Booster, dict, dict]:
    """Deployment model on all data; thresholds from a forward time-validation slice."""
    cut = df["start_ts"].quantile(0.85)
    tr, va = df[df["start_ts"] < cut], df[df["start_ts"] >= cut]
    tr_h, va_h = add_history_features(tr, va)
    cats = _categories(tr_h, feats)
    m, best = _fit(tr_h, va_h, feats, cats)
    p_val = m.predict(feature_matrix(va_h, feats, cats))
    thresholds = {str(t): dict(zip(("t_ok", "t_fail"), pick_thresholds(va_h["label_fail"].values, p_val, t)))
                  for t in PRECISION_TARGETS}
    full, _ = add_history_features(df, df.iloc[:0])
    cats = _categories(full, feats)
    model, _ = _fit(full, None, feats, cats, num_rounds=max(best, 50))
    contrib = model.predict(feature_matrix(full, feats, cats), pred_contrib=True)[:, :-1]
    shap_imp = pd.Series(np.abs(contrib).mean(axis=0), index=feats).sort_values(ascending=False)
    meta = {"best_iteration": int(best), "thresholds": thresholds, "categories": cats,
            "mean_abs_shap": shap_imp.round(5).to_dict()}
    return model, meta, cats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save-model", action="store_true")
    ap.add_argument("--feature-sets", nargs="*", default=list(FEATURE_SETS))
    args = ap.parse_args()

    raw = load_raw_observations()
    df = build_dataset(raw)
    df["station_id_cat"] = df["ground_station"].astype(str)
    stats = dataset_stats(raw, df)
    print(json.dumps(stats, indent=1))

    results = {"dataset": stats, "generated_at": datetime.now(timezone.utc).isoformat(), "feature_sets": {}}
    for name in args.feature_sets:
        feats = FEATURE_SETS[name]
        results["feature_sets"][name] = {}
        for regime in ("group_kfold_station", "time_split"):
            r = evaluate_regime(df, regime, feats)
            results["feature_sets"][name][regime] = r
            print(f"\n== {name} / {regime}: AUC={r['auc_roc']:.3f} acc@0.5={r['accuracy_at_0.5']:.3f} "
                  f"(majority {r['majority_baseline_accuracy']:.3f}) prec_fail@0.5={r['precision_fail_at_0.5']}")
            for t in PRECISION_TARGETS:
                v, o = r[f"policy_p{int(t*100)}_val_thresholds"], r[f"policy_p{int(t*100)}_oracle_on_test"]
                print(f"   P>={t}: val-thr -> fail prec {v['fail_precision']} rec {v['fail_recall']:.3f} | "
                      f"ok prec {v['ok_precision']} rec {v['ok_recall']:.3f} | escalate {v['escalate_share']:.3f}"
                      f"   [oracle: fail rec {o['fail_recall']:.3f} ok rec {o['ok_recall']:.3f} esc {o['escalate_share']:.3f}]")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / "eval_v2.0.0.json", "w") as f:
        json.dump(results, f, indent=1, default=str)

    if args.save_model:
        feats = FEATURE_SETS["physical+history"]
        model, meta, _ = train_final(df, feats)
        model.save_model(str(OUT_DIR / "model_v2.0.0.lgb"))
        with open(OUT_DIR / "config_v2.0.0.json", "w") as f:
            json.dump({"version": "v2.0.0-physical", "features": feats,
                       "categorical_features": CATEGORICAL_FEATURES, "history_lag_hours": 24,
                       "n_train": int(len(df)), **meta}, f, indent=1)
        print("\nFinal model mean |SHAP|:", json.dumps(meta["mean_abs_shap"], indent=1))
        print("Deployment thresholds:", meta["thresholds"])


if __name__ == "__main__":
    main()
