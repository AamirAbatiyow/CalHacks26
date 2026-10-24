"""
Evaluate and train the calibrated, abstaining pass-failure model.

Evaluation is nested and grouped by station: the outer GroupKFold holds out
whole stations; everything (satellite encodings, ensemble fits, isotonic,
conformal thresholds, alpha selection) is fit on the outer-train stations only.

Usage:
    python -m ml.train_conformal                 # complete-sampling window (default)
    python -m ml.train_conformal --window all    # all 3,500 passes (optimistic, see README)
"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, confusion_matrix, roc_auc_score
from sklearn.model_selection import GroupKFold

from .conformal_ensemble import (
    ABSTAIN, ALPHA_GRID, FAIL, OK, AbstainingPassModel, EnsembleConfig,
    build_features, complete_sampling_window, decision_metrics, get_target,
    load_passes, load_station_meta,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MODEL_DIR = Path(__file__).parent / "models"


def expected_calibration_error(y: np.ndarray, p: np.ndarray, n_bins: int = 10) -> float:
    bins = np.minimum((p * n_bins).astype(int), n_bins - 1)
    ece = 0.0
    for b in range(n_bins):
        m = bins == b
        if m.any():
            ece += m.mean() * abs(y[m].mean() - p[m].mean())
    return float(ece)


def _policy_report(y: np.ndarray, d: np.ndarray, folds: np.ndarray, alphas: list, status: np.ndarray) -> Dict[str, Any]:
    m = decision_metrics(y, d)
    m["false_ok_by_status"] = pd.Series(status[(d == OK) & (y == 1)]).value_counts().to_dict()
    m["escalated_by_status"] = pd.Series(status[d == ABSTAIN]).value_counts().to_dict()
    m["alpha_per_fold"] = alphas
    m["set_coverage_fail"] = float(np.mean(np.isin(d[y == 1], [FAIL, ABSTAIN])))
    m["set_coverage_ok"] = float(np.mean(np.isin(d[y == 0], [OK, ABSTAIN])))
    m["escalated_by_true_class"] = {
        "fail": int(np.sum((d == ABSTAIN) & (y == 1))),
        "ok": int(np.sum((d == ABSTAIN) & (y == 0))),
    }
    per_fold = [decision_metrics(y[folds == k], d[folds == k]) for k in np.unique(folds)]
    for key in ("precision_fail", "precision_ok", "accuracy_auto", "escalation_rate"):
        vals = np.array([f[key] for f in per_fold], dtype=float)
        m[f"{key}_fold_std"] = float(np.nanstd(vals))
    return m


def evaluate(df: pd.DataFrame, stations: pd.DataFrame, n_outer: int, model_kwargs: Dict[str, Any]) -> Dict[str, Any]:
    X = build_features(df, stations)
    y = get_target(df)
    status = df["status"].to_numpy()
    groups = X["station_id"].to_numpy()

    score = np.zeros(len(y))
    proba = np.zeros(len(y))
    folds = np.zeros(len(y), dtype=int)
    policies: Dict[str, np.ndarray] = {}
    policy_alphas: Dict[str, list] = {}
    sweep = {a: np.empty(len(y), dtype=object) for a in ALPHA_GRID}

    for k, (tr, te) in enumerate(GroupKFold(n_outer).split(X, y, groups)):
        model = AbstainingPassModel(**model_kwargs).fit(X.iloc[tr], y[tr], status[tr])
        s = model.raw_score(X.iloc[te])
        score[te], proba[te], folds[te] = s, model.iso_.predict(s), k
        for name, a in model.alphas_.items():
            policies.setdefault(name, np.empty(len(y), dtype=object))[te] = model.conformal_.decide(s, a)
            policy_alphas.setdefault(name, []).append(a)
        for a in ALPHA_GRID:
            sweep[a][te] = model.conformal_.decide(s, a)
        logger.info("fold %d: %d test passes, %d held-out stations, alphas=%s",
                    k, len(te), len(np.unique(groups[te])), model.alphas_)

    no_abstain = (proba >= 0.5).astype(int)
    report = {
        "n_passes": int(len(y)),
        "n_stations": int(len(np.unique(groups))),
        "failure_rate": float(y.mean()),
        "n_outer_folds": n_outer,
        "auc_roc_raw_score": float(roc_auc_score(y, score)),
        "auc_roc_calibrated": float(roc_auc_score(y, proba)),
        "brier_calibrated": float(brier_score_loss(y, proba)),
        "ece_calibrated": expected_calibration_error(y, proba),
        "no_abstain_at_0.5": {
            "accuracy": float((no_abstain == y).mean()),
            "precision_fail": float(np.sum((no_abstain == 1) & (y == 1)) / max(1, np.sum(no_abstain == 1))),
            "recall_fail": float(np.sum((no_abstain == 1) & (y == 1)) / max(1, np.sum(y == 1))),
            "confusion_matrix_[[tn,fp],[fn,tp]]": confusion_matrix(y, no_abstain).tolist(),
        },
        "policies": {name: _policy_report(y, d, folds, policy_alphas[name], status) for name, d in policies.items()},
        "alpha_sweep": {},
    }
    for a, d in sweep.items():
        m = decision_metrics(y, d)
        report["alpha_sweep"][str(a)] = {k: m[k] for k in (
            "escalation_rate", "coverage", "precision_fail", "precision_ok",
            "accuracy_auto", "recall_fail_overall", "n_fail_calls", "n_ok_calls")}
    return report


def print_report(r: Dict[str, Any]) -> None:
    print("\n" + "=" * 72)
    print(f"Held-out-station evaluation: {r['n_passes']} passes, {r['n_stations']} stations, "
          f"failure rate {r['failure_rate']:.1%}, {r['n_outer_folds']}-fold GroupKFold")
    print("=" * 72)
    print(f"AUC (raw / calibrated): {r['auc_roc_raw_score']:.4f} / {r['auc_roc_calibrated']:.4f}   "
          f"Brier {r['brier_calibrated']:.4f}   ECE {r['ece_calibrated']:.4f}")
    na = r["no_abstain_at_0.5"]
    print(f"No-abstain baseline @0.5: acc {na['accuracy']:.3f}  prec(fail) {na['precision_fail']:.3f}  "
          f"recall(fail) {na['recall_fail']:.3f}  cm {na['confusion_matrix_[[tn,fp],[fn,tp]]']}")
    for name, m in r["policies"].items():
        c = m["confusion_auto"]
        print(f"\n[{name}] alphas per fold {m['alpha_per_fold']}")
        print(f"  coverage {m['coverage']:.1%}  escalation {m['escalation_rate']:.1%} "
              f"(+/-{m['escalation_rate_fold_std']:.1%})")
        print(f"  precision FAIL {m['precision_fail']:.3f} (+/-{m['precision_fail_fold_std']:.3f})  "
              f"precision OK {m['precision_ok']:.3f} (+/-{m['precision_ok_fold_std']:.3f})  "
              f"accuracy(auto) {m['accuracy_auto']:.3f}")
        print(f"  recall FAIL (auto-decided) {m['recall_fail_auto']:.3f}  recall FAIL (all) {m['recall_fail_overall']:.3f}")
        print(f"  auto confusion: TP {c['tp']}  FP {c['fp']}  TN {c['tn']}  FN {c['fn']}  | escalated "
              f"{m['n_escalated']} ({m['escalated_by_true_class']})")
        print(f"  wrong OK calls by true status {m['false_ok_by_status']}  escalated by status {m['escalated_by_status']}")
        print(f"  conformal set coverage: fail {m['set_coverage_fail']:.3f}  ok {m['set_coverage_ok']:.3f}")
    print("\nalpha sweep (held-out):")
    print("  alpha  escal  precF  precOK  acc   nFAIL  nOK")
    for a, m in r["alpha_sweep"].items():
        print(f"  {float(a):<6} {m['escalation_rate']:.3f}  {m['precision_fail']:.3f}  {m['precision_ok']:.3f}  "
              f"{m['accuracy_auto']:.3f}  {m['n_fail_calls']:<5}  {m['n_ok_calls']}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--window", choices=["complete", "all"], default="complete")
    p.add_argument("--outer-folds", type=int, default=5)
    p.add_argument("--escalation-target", type=float, default=0.15)
    p.add_argument("--precision-targets", type=float, nargs="+", default=[0.98, 0.95, 0.90, 0.85])
    p.add_argument("--version", default="v2.0.0-conformal")
    p.add_argument("--no-save", action="store_true")
    args = p.parse_args()

    df = load_passes()
    if args.window == "complete":
        df = df[complete_sampling_window(df)].reset_index(drop=True)
    stations = load_station_meta()
    model_kwargs = {"escalation_target": args.escalation_target, "precision_targets": args.precision_targets}

    report = evaluate(df, stations, args.outer_folds, model_kwargs)
    report["window"] = args.window
    print_report(report)

    if args.no_save:
        return
    MODEL_DIR.mkdir(exist_ok=True)
    X = build_features(df, stations)
    final = AbstainingPassModel(**model_kwargs).fit(X, get_target(df), df["status"].to_numpy())
    joblib.dump(final, MODEL_DIR / f"model_{args.version}.joblib")
    report["final_model"] = {
        "version": args.version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "alphas": final.alphas_,
        "thresholds": {
            k: {name: (float(v) if np.isfinite(v) else None)
                for name, v in zip(("fail_min_score", "ok_max_score"), final.conformal_.thresholds(a))}
            for k, a in final.alphas_.items()
        },
        "features": final.config.numeric + final.config.categorical,
    }
    with open(MODEL_DIR / f"metrics_{args.version}.json", "w") as f:
        json.dump(report, f, indent=2)
    logger.info("saved model and metrics for %s", args.version)


if __name__ == "__main__":
    main()
