"""
Held-out evaluation of the pass-failure model.

Compares a random split (the v1.1.0 methodology), GroupKFold by station
(no station in both train and test) and a forward time split. Every
threshold is chosen on inner out-of-fold predictions of the training fold and
then applied once to the outer test fold, so reported precision/recall at a
precision target are not tuned on the data they are measured on.

Usage:
    python -m ml.heldout_eval [--dataset v110|v110_census|window|window_census] [--out ml/reports]
"""

import argparse
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    accuracy_score, average_precision_score, confusion_matrix, f1_score,
    precision_recall_curve, precision_score, recall_score, roc_auc_score,
)
from sklearn.model_selection import GroupKFold, StratifiedKFold, KFold

from . import datasets as ds

logger = logging.getLogger(__name__)

REPORT_DIR = Path(__file__).parent / "reports"
PRECISION_TARGETS = (0.90, 0.95, 0.98)
MIN_FLAGGED_FOR_THRESHOLD = 20

LGB_PARAMS = {
    "objective": "binary",
    "learning_rate": 0.03,
    "num_leaves": 15,
    "min_child_samples": 30,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "reg_lambda": 1.0,
    "verbose": -1,
    "seed": 42,
    "num_threads": 4,
}
NUM_ROUNDS = 300
ONLINE_LAGS_H = (1, 3)


@dataclass
class Variant:
    name: str
    numeric: List[str]
    categorical: List[str]
    station_id_feature: bool = False
    station_history: bool = False
    class_weight: bool = False
    calibrate: bool = False


def feature_variants(df: pd.DataFrame) -> Dict[str, Variant]:
    phys = [c for c in ds.PHYSICAL_NUMERIC if df[c].notna().any()]
    base = ["max_elevation_deg", "duration_sec", "station_lat", "station_lon",
            "kp_at_time", "kp_latitude_risk"]
    v = {
        "v110_station_id": Variant("v110_station_id", base, ["transmitter_mode"],
                                   station_id_feature=True),
        "v110_no_station_id": Variant("v110_no_station_id", base, ["transmitter_mode"]),
        "physical": Variant("physical", phys, ds.PHYSICAL_CATEGORICAL),
        "physical+history": Variant("physical+history", phys, ds.PHYSICAL_CATEGORICAL,
                                    station_history=True),
        "physical+history+weight": Variant("physical+history+weight", phys,
                                           ds.PHYSICAL_CATEGORICAL, station_history=True,
                                           class_weight=True),
        "physical+history+isotonic": Variant("physical+history+isotonic", phys,
                                             ds.PHYSICAL_CATEGORICAL, station_history=True,
                                             calibrate=True),
    }
    for lag in ONLINE_LAGS_H:
        online = [f"{c}_lag{lag}h" for c in ds.RECENT_STATE_FEATURES]
        v[f"physical+online{lag}h"] = Variant(f"physical+online{lag}h", phys + online,
                                              ds.PHYSICAL_CATEGORICAL)
        v[f"physical+online{lag}h+weight"] = Variant(f"physical+online{lag}h+weight", phys + online,
                                                     ds.PHYSICAL_CATEGORICAL, class_weight=True)
        v[f"physical+online{lag}h+isotonic"] = Variant(f"physical+online{lag}h+isotonic",
                                                       phys + online, ds.PHYSICAL_CATEGORICAL,
                                                       calibrate=True)
        v[f"physical+history+online{lag}h"] = Variant(
            f"physical+history+online{lag}h", phys + online, ds.PHYSICAL_CATEGORICAL,
            station_history=True)
        v[f"physical+history+online{lag}h+isotonic"] = Variant(
            f"physical+history+online{lag}h+isotonic", phys + online, ds.PHYSICAL_CATEGORICAL,
            station_history=True, calibrate=True)
    return v


FEATURE_GROUPS = {
    "kp": ["kp_at_time", "kp_max_6h", "kp_latitude_risk"],
    "frequency_band": ["log10_freq_hz", "band"],
    "day_night": ["sun_elev_deg", "is_night"],
    "tle_age": ["tle_age_days"],
    "geometry": ["max_elevation_deg", "duration_sec", "elev_margin_deg"],
    "station_hardware": ["min_horizon_deg", "has_directional", "has_omni", "n_antennas",
                         "station_alt_m", "station_age_days"],
    "station_location": ["station_lat", "station_abs_lat", "station_lon"],
    "transmitter_mode": ["transmitter_mode"],
    "station_state_online1h": [f"{c}_lag1h" for c in ds.RECENT_STATE_FEATURES],
}


def ablation_variants(df: pd.DataFrame, base: str = "physical+online1h") -> Dict[str, Variant]:
    b = feature_variants(df)[base]
    out = {base: b}
    for group, cols in FEATURE_GROUPS.items():
        num = [c for c in b.numeric if c not in cols]
        cat = [c for c in b.categorical if c not in cols]
        if len(num) + len(cat) < len(b.numeric) + len(b.categorical):
            out[f"-{group}"] = Variant(f"-{group}", num, cat, b.station_id_feature,
                                       b.station_history, b.class_weight, b.calibrate)
    return out


def add_online_features(df: pd.DataFrame) -> pd.DataFrame:
    for lag in ONLINE_LAGS_H:
        rs = ds.station_recent_state(df, lag_hours=lag)
        df = df.join(rs.add_suffix(f"_lag{lag}h"))
    return df


def _design(df: pd.DataFrame, v: Variant, cats: Dict[str, list],
            history: Optional[pd.DataFrame]) -> pd.DataFrame:
    X = df[v.numeric].astype(float).copy()
    for c in v.categorical + (["station_id"] if v.station_id_feature else []):
        X[c] = pd.Categorical(df[c].fillna("NA").astype(str), categories=cats[c])
    if history is not None:
        X = pd.concat([X, history], axis=1)
    return X


def _fit(train: pd.DataFrame, v: Variant, seed: int = 42):
    cats = {c: sorted(train[c].fillna("NA").astype(str).unique())
            for c in v.categorical + (["station_id"] if v.station_id_feature else [])}
    hist_train = None
    if v.station_history:
        # Out-of-fold by row: a pass never sees its own label in its station rate.
        hist_train = pd.DataFrame(index=train.index, columns=["station_fail_rate", "station_n_train"],
                                  dtype=float)
        for a, b in KFold(5, shuffle=True, random_state=seed).split(train):
            hist_train.iloc[b] = ds.station_history_features(train.iloc[a], train.iloc[b]).values
    X = _design(train, v, cats, hist_train)
    params = dict(LGB_PARAMS, seed=seed)
    if v.class_weight:
        params["scale_pos_weight"] = float((train["y"] == 0).sum() / max((train["y"] == 1).sum(), 1))
    booster = lgb.train(params, lgb.Dataset(X, label=train["y"]), num_boost_round=NUM_ROUNDS)
    return booster, cats


def _predict(booster, cats, train: pd.DataFrame, test: pd.DataFrame, v: Variant) -> np.ndarray:
    hist = ds.station_history_features(train, test) if v.station_history else None
    return booster.predict(_design(test, v, cats, hist))


def _splitter(kind: str, df: pd.DataFrame, n_splits: int, seed: int):
    if kind == "random":
        return list(StratifiedKFold(n_splits, shuffle=True, random_state=seed).split(df, df["y"]))
    if kind == "station":
        gkf = GroupKFold(n_splits, shuffle=True, random_state=seed)
        return list(gkf.split(df, df["y"], groups=df["station_id"]))
    if kind == "time":
        order = np.argsort(df["t"].values, kind="stable")
        cut = int(len(df) * 0.7)
        return [(order[:cut], order[cut:])]
    raise ValueError(kind)


def _inner_splits(kind: str, df: pd.DataFrame, seed: int):
    if kind == "time":
        order = np.argsort(df["t"].values, kind="stable")
        cut = int(len(df) * 0.7)
        return [(order[:cut], order[cut:])]
    return _splitter(kind, df, 4, seed)


def fit_predict_with_inner(train: pd.DataFrame, test: pd.DataFrame, v: Variant,
                           kind: str, seed: int):
    """Outer-fold scores plus inner OOF scores on the training fold.

    The inner scores (same split kind as the outer split) are used only to
    pick thresholds and fit the isotonic calibrator.
    """
    inner_idx, inner_scores, inner_y = [], [], []
    for a, b in _inner_splits(kind, train, seed):
        tr, va = train.iloc[a], train.iloc[b]
        bst, cats = _fit(tr, v, seed)
        inner_scores.append(_predict(bst, cats, tr, va, v))
        inner_y.append(va["y"].values)
        inner_idx.append(b)
    inner_scores = np.concatenate(inner_scores)
    inner_y = np.concatenate(inner_y)

    bst, cats = _fit(train, v, seed)
    test_scores = _predict(bst, cats, train, test, v)
    if v.calibrate:
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(inner_scores, inner_y)
        inner_scores = iso.predict(inner_scores)
        test_scores = iso.predict(test_scores)
    return test_scores, inner_scores, inner_y, bst


def threshold_for_precision(scores: np.ndarray, y: np.ndarray, target: float,
                            min_flagged: int = MIN_FLAGGED_FOR_THRESHOLD) -> Optional[float]:
    """Lowest threshold whose flagged set (score >= t) reaches `target` precision."""
    order = np.argsort(-scores, kind="stable")
    s, yy = scores[order], y[order]
    tp = np.cumsum(yy)
    n = np.arange(1, len(yy) + 1)
    prec = tp / n
    # Only cut between distinct scores.
    last_of_tie = np.r_[s[1:] != s[:-1], True]
    ok = (prec >= target) & (n >= min_flagged) & last_of_tie
    if not ok.any():
        return None
    return float(s[np.where(ok)[0].max()])


def wilson_interval(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (None, None)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (float(center - half), float(center + half))


def point_metrics(y: np.ndarray, scores: np.ndarray, threshold: float = 0.5) -> dict:
    pred = (scores >= threshold).astype(int)
    return {
        "auc_roc": float(roc_auc_score(y, scores)),
        "auc_pr": float(average_precision_score(y, scores)),
        "threshold": threshold,
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "accuracy": float(accuracy_score(y, pred)),
        "confusion_matrix": confusion_matrix(y, pred, labels=[0, 1]).tolist(),
        "base_rate": float(y.mean()),
        "n": int(len(y)),
    }


def evaluate(df: pd.DataFrame, v: Variant, kind: str, n_splits: int = 5, seed: int = 42) -> dict:
    outer = _splitter(kind, df, n_splits, seed)
    scores = np.full(len(df), np.nan)
    flagged = {t: np.zeros(len(df), dtype=bool) for t in PRECISION_TARGETS}
    fold_thresholds = {t: [] for t in PRECISION_TARGETS}
    fold_of = np.full(len(df), -1)
    importance = None
    for k, (tr_idx, te_idx) in enumerate(outer):
        fold_of[te_idx] = k
        train, test = df.iloc[tr_idx], df.iloc[te_idx]
        s, inner_s, inner_y, bst = fit_predict_with_inner(train, test, v, kind, seed)
        scores[te_idx] = s
        for t in PRECISION_TARGETS:
            thr = threshold_for_precision(inner_s, inner_y, t)
            fold_thresholds[t].append(thr)
            if thr is not None:
                flagged[t][te_idx] = s >= thr
        gain = pd.Series(bst.feature_importance("gain"), index=bst.feature_name())
        importance = gain if importance is None else importance.add(gain, fill_value=0)

    mask = ~np.isnan(scores)
    y, s = df["y"].values[mask], scores[mask]
    out = {"split": kind, "variant": v.name, "n_folds": len(outer), **point_metrics(y, s)}

    p, r, thr = precision_recall_curve(y, s)
    out["pr_curve"] = {"precision": p.tolist(), "recall": r.tolist(), "thresholds": thr.tolist()}

    out["at_precision_target"] = {}
    for t in PRECISION_TARGETS:
        f = flagged[t][mask]
        tp = int((f & (y == 1)).sum())
        n_flag = int(f.sum())
        lo, hi = wilson_interval(tp, n_flag)
        oracle_thr = threshold_for_precision(s, y, t)
        oracle_recall = float(((s >= oracle_thr) & (y == 1)).sum() / y.sum()) if oracle_thr is not None else 0.0
        status = df["status"].values[mask]
        folds = fold_of[mask]
        per_fold = []
        for k in range(len(outer)):
            fk, yk = f[folds == k], y[folds == k]
            per_fold.append({
                "flagged": int(fk.sum()),
                "precision": float((fk & (yk == 1)).sum() / fk.sum()) if fk.sum() else None,
                "recall": float((fk & (yk == 1)).sum() / max(yk.sum(), 1)),
            })
        out["at_precision_target"][f"{t:.2f}"] = {
            "nested_thresholds": fold_thresholds[t],
            "per_fold": per_fold,
            "flagged": n_flag,
            "true_positives": tp,
            "precision": float(tp / n_flag) if n_flag else None,
            "precision_95ci": [lo, hi],
            "recall": float(tp / y.sum()),
            "recall_failed_only": float((f & (status == "failed")).sum() / max((status == "failed").sum(), 1)),
            "recall_bad_only": float((f & (status == "bad")).sum() / max((status == "bad").sum(), 1)),
            "oracle_threshold": oracle_thr,
            "oracle_recall": oracle_recall,
        }
    out["feature_importance_gain"] = (importance / len(outer)).sort_values(ascending=False).round(1).to_dict()
    out["_scores"] = scores
    return out


def load_dataset(name: str) -> pd.DataFrame:
    if name == "v110":
        df = ds.load_v110()
    elif name == "v110_census":
        df = ds.load_v110(census_only=True)
    elif name == "window":
        df = ds.load_window()
    elif name == "window_census":
        df = ds.load_window(min_age_hours=24)
    else:
        raise ValueError(name)
    if df.empty:
        raise FileNotFoundError(f"no labeled passes for dataset '{name}'")
    return add_online_features(df)


def plot_pr_curves(results: List[dict], path: Path, title: str):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(7, 5))
    for r in results:
        ax.plot(r["pr_curve"]["recall"], r["pr_curve"]["precision"],
                label=f"{r['split']} / {r['variant']} (AP {r['auc_pr']:.2f})")
    for t in PRECISION_TARGETS:
        ax.axhline(t, color="grey", lw=0.6, ls="--")
    base = results[0]["base_rate"]
    ax.axhline(base, color="black", lw=0.6, ls=":", label=f"base rate {base:.2f}")
    ax.set_xlabel("Recall (failures caught)")
    ax.set_ylabel("Precision (flagged failures that really failed)")
    ax.set_ylim(0, 1.01)
    ax.set_title(title)
    ax.legend(fontsize=7, loc="lower left")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def run(dataset: str, variants: List[str], splits: List[str], out_dir: Path) -> List[dict]:
    df = load_dataset(dataset)
    logger.info("dataset %s: %d rows, %d stations, failure rate %.3f",
                dataset, len(df), df["station_id"].nunique(), df["y"].mean())
    all_variants = {**feature_variants(df), **ablation_variants(df)}
    if variants == ["ablation"]:
        variants = list(ablation_variants(df))
        dataset_tag = f"{dataset}_ablation"
    else:
        dataset_tag = dataset
    results = []
    for kind in splits:
        for name in variants:
            r = evaluate(df, all_variants[name], kind)
            logger.info("%-8s %-28s AUC %.3f AP %.3f  P@.5 %.3f R@.5 %.3f | P95: prec %s rec %.3f",
                        kind, name, r["auc_roc"], r["auc_pr"], r["precision"], r["recall"],
                        r["at_precision_target"]["0.95"]["precision"],
                        r["at_precision_target"]["0.95"]["recall"])
            results.append(r)
    out_dir.mkdir(parents=True, exist_ok=True)
    plotted = [r for r in results if r["variant"] in ("v110_station_id", "physical", "physical+online1h")]
    if plotted and dataset_tag == dataset:
        plot_pr_curves(plotted, out_dir / f"pr_curve_{dataset}.png", f"Held-out PR curves ({dataset})")
    summary = {
        "dataset": dataset_tag,
        "n_rows": int(len(df)),
        "n_stations": int(df["station_id"].nunique()),
        "status_counts": df["status"].value_counts().to_dict(),
        "time_range": [str(df["t"].min()), str(df["t"].max())],
        "results": [{k: v for k, v in r.items() if k != "_scores"} for r in results],
    }
    if "status_counts_all" in df.attrs:
        summary["status_counts_including_unlabeled"] = df.attrs["status_counts_all"]
    with open(out_dir / f"heldout_{dataset_tag}.json", "w") as f:
        json.dump(summary, f, indent=1, default=str)
    with open(out_dir / f"heldout_{dataset_tag}.md", "w") as f:
        f.write(to_markdown(summary))
    return results


def _fmt(x, nd=3):
    return "–" if x is None else f"{x:.{nd}f}"


def to_markdown(summary: dict) -> str:
    lines = [
        f"# Held-out evaluation: `{summary['dataset']}`",
        "",
        f"{summary['n_rows']} labeled passes, {summary['n_stations']} stations, "
        f"{summary['time_range'][0]} to {summary['time_range'][1]}. "
        f"Status counts: {summary['status_counts']}. Failure = bad or failed.",
        "",
        "## Threshold 0.5",
        "",
        "| split | variant | AUC | AP | precision | recall | F1 | accuracy | confusion [[TN, FP], [FN, TP]] |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in summary["results"]:
        lines.append(
            f"| {r['split']} | {r['variant']} | {_fmt(r['auc_roc'])} | {_fmt(r['auc_pr'])} | "
            f"{_fmt(r['precision'])} | {_fmt(r['recall'])} | {_fmt(r['f1'])} | "
            f"{_fmt(r['accuracy'])} | {r['confusion_matrix']} |")
    lines += [
        "",
        "## Precision targets (threshold chosen on inner OOF, measured on the outer fold)",
        "",
        "| split | variant | target | precision | 95% CI | recall | recall failed / bad | flagged |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in summary["results"]:
        for t, a in r["at_precision_target"].items():
            lo, hi = a["precision_95ci"]
            lines.append(
                f"| {r['split']} | {r['variant']} | {t} | {_fmt(a['precision'])} | "
                f"{_fmt(lo, 2)}–{_fmt(hi, 2)} | {_fmt(a['recall'])} | "
                f"{_fmt(a['recall_failed_only'], 2)} / {_fmt(a['recall_bad_only'], 2)} | {a['flagged']} |")
    return "\n".join(lines) + "\n"


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="v110")
    parser.add_argument("--variants", default=",".join([
        "v110_station_id", "v110_no_station_id", "physical", "physical+history",
        "physical+history+weight", "physical+history+isotonic",
        "physical+online1h", "physical+online1h+weight", "physical+online1h+isotonic",
        "physical+history+online1h", "physical+online3h"]))
    parser.add_argument("--splits", default="random,station,time")
    parser.add_argument("--out", default=str(REPORT_DIR))
    args = parser.parse_args()
    run(args.dataset, args.variants.split(","), args.splits.split(","), Path(args.out))


if __name__ == "__main__":
    main()
