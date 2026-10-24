"""
Final high-precision pass-failure classifier (v3) for the Ground Truth confidence gate.

Combines what PRs #12, #17 and #18 learned:

* data: the unified SatNOGS store (`ml/satnogs_fetcher.py`): whole UTC hours,
  every status, so the class mix is natural and station histories are complete;
* features (`ml/causal_features.py`): PR #18 physics + PR #12 outage streaks +
  PR #17 past-only station health and co-observation, all strictly causal under
  an explicit label-latency model (lag 1h or 3h); no station id, no satellite
  target encoding;
* model: LightGBM + isotonic calibration (stacking, Bayesian priors, group
  conformal and two-stage routing were within noise or worse in PR #17);
* gate: a pass is auto-decided only when the threshold picked *inside the
  training fold* (Wilson 95% lower bound of inner out-of-fold precision >=
  0.95) is cleared; everything else escalates to a human.

Evaluation (`evaluate`): held-out stations (5 station-grouped outer folds, inner
station-grouped folds for calibration + thresholds) and a forward time split
(train on the first 70% of time, test on the rest, also reported for test
stations never seen in training).

Usage:
    python -m ml.final_model evaluate            # writes ml/reports/final_v3.{md,json} + PR curves
    python -m ml.final_model train               # writes ml/models/final/*_v3.0.0.*
    python -m ml.final_model retrain --scheduled # refresh from the growing store (collector calls this)
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

from . import causal_features as cf
from . import satnogs_fetcher as sf

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(__file__).resolve().parent / "models" / "final"
REPORT_DIR = Path(__file__).resolve().parent / "reports"
SNAPSHOT = ROOT / "data" / "processed" / "satnogs_store_snapshot.parquet"
BASE_VERSION = "v3.0.0"
LOOKBACK_H = 6.0          # station / satellite / transmitter history window
LONG_LOOKBACK_H = 24.0   # station long-window failure share (NaN until the store covers it)

LGB_PARAMS = dict(objective="binary", learning_rate=0.05, num_leaves=15, min_child_samples=20,
                  feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                  verbose=-1, seed=0, num_threads=4)
N_TREES = 300

PR12_STATE = ["st_n", "st_failed_frac", "st_last_failed", "st_h_since_known"]
MONOTONE_UP = ["st_failed_frac", "st_fail_streak", "st_last_failed", "st_failed_frac_long"]
MONOTONE_DOWN = ["st_good_frac", "st_last_good"]

VARIANTS: Dict[str, dict] = {
    "physics": {"numeric": cf.PHYSICAL_NUMERIC, "monotone": False},
    "pr12_state": {"numeric": cf.PHYSICAL_NUMERIC + PR12_STATE, "monotone": False},
    "full_causal": {"numeric": cf.FEATURES_NUMERIC, "monotone": False},
    "full_causal_mono": {"numeric": cf.FEATURES_NUMERIC, "monotone": True},
    # Auto "failed" only for passes whose station's last resolved pass failed (outage
    # evidence, PR #12/#17); the OK side still uses the plain model score.
    "full_causal_mono_ev": {"numeric": cf.FEATURES_NUMERIC, "monotone": True, "evidence": True},
    "rule_streak": {"rule": True},
}
FINAL_VARIANT = "full_causal"


# --------------------------------------------------------------------------- data


def load_raw(prefer_store: bool = True) -> Tuple[pd.DataFrame, List[pd.Timestamp]]:
    """All stored observations and the list of complete hours they cover."""
    raw = sf.load_store() if prefer_store else pd.DataFrame()
    if raw.empty and SNAPSHOT.exists():
        raw = pd.read_parquet(SNAPSHOT)
        hours = sorted(pd.to_datetime(raw["_hour"].unique(), utc=True))
        return raw, hours
    hours = [pd.Timestamp(h) for h in sf.done_hours()]
    return raw, hours


def load_stations() -> Dict[int, dict]:
    if sf.STATIONS_FILE.exists():
        return {int(s["id"]): s for s in json.load(open(sf.STATIONS_FILE))}
    out = {}
    p = ROOT / "data" / "processed" / "satnogs_stations_natural.json"
    if p.exists():
        out = {int(s["id"]): s for s in json.load(open(p))}
    return out


def load_kp() -> cf.KpSeries:
    for p in (sf.KP_FILE, ROOT / "data" / "processed" / "kp_3h.json"):
        if Path(p).exists():
            k = cf.KpSeries.from_file(p)
            if len(k.t):
                return k
    return cf.KpSeries({})


def write_snapshot(raw: pd.DataFrame) -> None:
    """Commit-sized copy of the store (raw hour files are gitignored)."""
    keep = [c for c in sf.KEEP_FIELDS + ["fetched_at"] if c in raw.columns]
    snap = raw[keep].copy()
    snap["_hour"] = pd.to_datetime(snap["start"], utc=True).dt.floor("h")
    for c in snap.columns:
        if snap[c].dtype == object:
            snap[c] = snap[c].astype("string")
    snap.to_parquet(SNAPSHOT, compression="zstd", index=False)


def build(lag_hours: float = 1.0, lookback_hours: float = LOOKBACK_H, raw=None, hours=None) -> pd.DataFrame:
    if raw is None:
        raw, hours = load_raw()
    return cf.build_dataset(raw, load_stations(), load_kp(), hours, lag_hours=lag_hours,
                            lookback_hours=lookback_hours, long_lookback_hours=LONG_LOOKBACK_H)


# --------------------------------------------------------------------------- model


def wilson(k: float, n: float, z: float = 1.96) -> Tuple[float, float]:
    if n <= 0:
        return float("nan"), float("nan")
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return float(c - h), float(c + h)


def categories_for(df: pd.DataFrame) -> Dict[str, List[str]]:
    return {c: sorted(df[c].astype(str).unique().tolist()) for c in cf.FEATURES_CATEGORICAL}


def matrix(df: pd.DataFrame, numeric: Sequence[str], cats: Dict[str, List[str]]) -> pd.DataFrame:
    X = pd.DataFrame(index=df.index)
    for c in numeric:
        X[c] = pd.to_numeric(df[c], errors="coerce").astype(float) if c in df else np.nan
    for c, levels in cats.items():
        vals = df[c].astype(str) if c in df else pd.Series("unknown", index=df.index)
        X[c] = pd.Categorical(vals.where(vals.isin(levels)), categories=levels)
    return X


@dataclass
class Booster:
    """LightGBM (or the transparent streak rule) with fixed feature schema."""
    variant: str
    numeric: List[str] = field(default_factory=list)
    cats: Dict[str, List[str]] = field(default_factory=dict)
    model: Optional[lgb.Booster] = None
    n_trees: int = N_TREES

    @property
    def is_rule(self) -> bool:
        return bool(VARIANTS[self.variant].get("rule"))

    def fit(self, df: pd.DataFrame, init: Optional["Booster"] = None, n_trees: Optional[int] = None) -> "Booster":
        if self.is_rule:
            return self
        spec = VARIANTS[self.variant]
        self.numeric = list(spec["numeric"])
        if init is not None:
            self.cats = init.cats
        else:
            self.cats = categories_for(df)
        X = matrix(df, self.numeric, self.cats)
        params = dict(LGB_PARAMS)
        if spec.get("monotone"):
            params["monotone_constraints"] = [1 if c in MONOTONE_UP else -1 if c in MONOTONE_DOWN else 0
                                              for c in X.columns]
            params["monotone_constraints_method"] = "advanced"
        ds = lgb.Dataset(X, label=df["y"].to_numpy(), categorical_feature=list(self.cats), free_raw_data=False)
        self.model = lgb.train(params, ds, num_boost_round=n_trees or self.n_trees,
                               init_model=init.model if init is not None else None,
                               keep_training_booster=True)
        return self

    def raw(self, df: pd.DataFrame) -> np.ndarray:
        """Score used for the auto-'failed' side."""
        r = self.raw_base(df)
        if VARIANTS[self.variant].get("evidence"):
            r = np.where(df["st_last_failed"].fillna(0).to_numpy() == 1, r, r - 2.0)
        return r

    def raw_base(self, df: pd.DataFrame) -> np.ndarray:
        """Score used for the auto-'fine' side and for AUC."""
        if self.is_rule:
            s = df["st_fail_streak"].fillna(0).to_numpy() + df["st_failed_frac"].fillna(0).to_numpy()
            return s + 0.01 * df["st_failed_frac_long"].fillna(0).to_numpy()
        return self.model.predict(matrix(df, self.numeric, self.cats))

    @property
    def feature_names(self) -> List[str]:
        return self.numeric + list(self.cats)


def station_folds(stations: np.ndarray, k: int, seed: int) -> np.ndarray:
    uniq = np.unique(stations)
    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(uniq))
    fold_of = {s: perm[i] % k for i, s in enumerate(uniq)}
    return np.array([fold_of[s] for s in stations])


# In-fold threshold rules: (kind, target, z). The flagged set {score >= t} on the
# training fold's inner out-of-fold scores must satisfy precision >= target
# ("point") or Wilson lower bound (z) >= target ("wilson").
RULES = {
    "wilson95": ("wilson", 0.95, 1.96),
    "wilson80": ("wilson", 0.95, 1.2816),
    "point97": ("point", 0.97, 0.0),
    "point95": ("point", 0.95, 0.0),
}
DEFAULT_RULE = "wilson80"


def pick_threshold(scores: np.ndarray, y: np.ndarray, target: float, rule: str = "wilson",
                   min_flagged: int = 5, z: float = 1.96) -> Optional[float]:
    """Lowest score threshold whose flagged set {score >= t} meets the precision rule.

    rule="wilson": Wilson lower bound (z) >= target; rule="point": precision >= target.
    Ties are kept together, so the returned threshold flags exactly the evaluated set.
    """
    order = np.argsort(-scores, kind="stable")
    s, yy = scores[order], y[order]
    tp = np.cumsum(yy)
    n = np.arange(1, len(s) + 1)
    last_of_tie = np.r_[s[1:] != s[:-1], True]
    best = None
    for i in np.where(last_of_tie & (n >= min_flagged))[0]:
        k, m = tp[i], n[i]
        ok = wilson(k, m, z)[0] >= target if rule == "wilson" else k / m >= target
        if ok:
            best = s[i]
    return None if best is None else float(best)


def rule_thresholds(oof: np.ndarray, y: np.ndarray, rule: str, ok_side: bool = True):
    kind, target, z = RULES[rule]
    t_fail = pick_threshold(oof, y, target, kind, z=z)
    t_ok = None
    if ok_side:
        neg = pick_threshold(-oof, 1 - y, target, kind, z=z)
        t_ok = -neg if neg is not None else None
    return t_fail, t_ok


@dataclass
class GatedModel:
    booster: Booster
    calibrator: IsotonicRegression
    t_fail: Optional[float]       # raw-score threshold for auto "failed"
    t_ok: Optional[float]         # raw-score threshold for auto "fine" (score <= t_ok)
    targets: Dict[str, Optional[float]] = field(default_factory=dict)
    inner: Dict = field(default_factory=dict)
    rules: Dict[str, Tuple[Optional[float], Optional[float]]] = field(default_factory=dict)
    rule: str = DEFAULT_RULE

    def proba(self, df: pd.DataFrame) -> np.ndarray:
        return self.calibrator.predict(self.booster.raw_base(df))

    def decide(self, df: pd.DataFrame, rule: Optional[str] = None, raw=None) -> pd.DataFrame:
        raw, base = (self.booster.raw(df), self.booster.raw_base(df)) if raw is None else raw
        p = self.calibrator.predict(base)
        t_fail, t_ok = (self.rules[rule] if rule else (self.t_fail, self.t_ok))
        fail = (raw >= t_fail) if t_fail is not None else np.zeros(len(df), bool)
        ok = (base <= t_ok) if t_ok is not None else np.zeros(len(df), bool)
        ok &= ~fail
        return pd.DataFrame({"raw": raw, "score": base, "p_fail": p, "auto_fail": fail, "auto_ok": ok},
                            index=df.index)

    def scores(self, df: pd.DataFrame):
        return self.booster.raw(df), self.booster.raw_base(df)


def fit_gated(train: pd.DataFrame, variant: str, rule: str = DEFAULT_RULE, inner_folds: int = 4, seed: int = 0,
              extra_targets: Sequence[float] = (0.90, 0.98), ok_side: bool = True,
              threshold_mask: Optional[np.ndarray] = None) -> GatedModel:
    """Inner station-grouped OOF -> isotonic + thresholds for every rule; final booster on all of `train`.

    `threshold_mask` restricts threshold picking to the passes that reach this
    gate (e.g. those not already decided by earlier policies).
    """
    y = train["y"].to_numpy()
    folds = station_folds(train["ground_station"].to_numpy(), inner_folds, seed + 101)
    oof, oof_base = np.zeros(len(train)), np.zeros(len(train))
    for f in range(inner_folds):
        tr, va = folds != f, folds == f
        if va.sum() == 0 or tr.sum() == 0:
            continue
        b = Booster(variant).fit(train[tr])
        oof[va], oof_base[va] = b.raw(train[va]), b.raw_base(train[va])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(oof_base, y)
    sel = np.ones(len(train), bool) if threshold_mask is None else np.asarray(threshold_mask, bool)
    rules = {}
    for r in RULES:
        t_fail, _ = rule_thresholds(oof[sel], y[sel], r, ok_side=False)
        _, t_ok = rule_thresholds(oof_base[sel], y[sel], r, ok_side)
        rules[r] = (t_fail, t_ok)
    t_fail, t_ok = rules[rule]
    kind, _, z = RULES[rule]
    targets = {f"{t:.2f}": pick_threshold(oof[sel], y[sel], t, kind, z=z) for t in extra_targets}
    targets["0.95"] = t_fail
    booster = Booster(variant).fit(train)
    inner = {"oof_auc": float(roc_auc_score(y, oof_base)) if 0 < y.mean() < 1 else None,
             "oof_flagged": int((oof >= t_fail).sum()) if t_fail is not None else 0, "rule": rule}
    return GatedModel(booster, iso, t_fail, t_ok, targets, inner, rules, rule)


# --------------------------------------------------------------------------- metrics


def cluster_bootstrap_precision(flag: np.ndarray, y: np.ndarray, groups: np.ndarray,
                                reps: int = 1000, seed: int = 0) -> Tuple[float, float]:
    if flag.sum() == 0:
        return float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    uniq, inv = np.unique(groups, return_inverse=True)
    tp = np.bincount(inv, weights=(flag & (y == 1)).astype(float), minlength=len(uniq))
    nf = np.bincount(inv, weights=flag.astype(float), minlength=len(uniq))
    vals = []
    for _ in range(reps):
        idx = rng.integers(0, len(uniq), len(uniq))
        n = nf[idx].sum()
        if n > 0:
            vals.append(tp[idx].sum() / n)
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def gate_metrics(df: pd.DataFrame, dec: pd.DataFrame) -> Dict:
    y = df["y"].to_numpy()
    status = df["status"].to_numpy()
    fail, ok = dec["auto_fail"].to_numpy(), dec["auto_ok"].to_numpy()
    auto = fail | ok
    tp = int((fail & (y == 1)).sum())
    nf = int(fail.sum())
    tn = int((ok & (y == 0)).sum())
    nok = int(ok.sum())
    n_fail_all = int((y == 1).sum())
    out = {
        "n": int(len(df)), "n_failures": n_fail_all, "base_rate": float(y.mean()) if len(y) else None,
        "auc": float(roc_auc_score(y, dec["score"])) if 0 < y.mean() < 1 else None,
        "fail_flagged": nf, "fail_tp": tp,
        "fail_precision": tp / nf if nf else None,
        "fail_precision_wilson": wilson(tp, nf) if nf else None,
        "fail_precision_cluster_ci": cluster_bootstrap_precision(fail, y, df["ground_station"].to_numpy()),
        "fail_recall": tp / n_fail_all if n_fail_all else None,
        "recall_failed_class": float((fail & (status == "failed")).sum() / max(1, (status == "failed").sum())),
        "recall_bad_class": float((fail & (status == "bad")).sum() / max(1, (status == "bad").sum())),
        "ok_cleared": nok, "ok_precision": tn / nok if nok else None,
        "ok_precision_wilson": wilson(tn, nok) if nok else None,
        "ok_recall": tn / max(1, int((y == 0).sum())),
        "coverage_fail_only": nf / len(df) if len(df) else None,
        "coverage_two_sided": float(auto.mean()) if len(df) else None,
        "accuracy_auto_two_sided": (tp + tn) / (nf + nok) if (nf + nok) else None,
        "escalated_two_sided": float(1 - auto.mean()) if len(df) else None,
    }
    return out


# --------------------------------------------------------------------------- evaluation


def eval_station_cv(df: pd.DataFrame, variant: str, k: int = 5, seed: int = 0,
                    rules: Sequence[str] = tuple(RULES), **kw) -> Tuple[Dict, pd.DataFrame]:
    """Outer station-grouped folds; returns {rule: metrics} and the decisions of the first rule."""
    folds = station_folds(df["ground_station"].to_numpy(), k, seed)
    decs = {r: [] for r in rules}
    per_fold = {r: [] for r in rules}
    for f in range(k):
        tr, te = df[folds != f], df[folds == f]
        gm = fit_gated(tr, variant, seed=seed + f, **kw)
        raw = gm.scores(te)
        for r in rules:
            d = gm.decide(te, r, raw)
            d["fold"] = f
            decs[r].append(d)
            m = gate_metrics(te, d)
            per_fold[r].append({"fold": f, "fail_precision": m["fail_precision"], "fail_flagged": m["fail_flagged"],
                                "fail_recall": m["fail_recall"], "t_fail": gm.rules[r][0], "inner": gm.inner})
    out = {}
    for r in rules:
        dec = pd.concat(decs[r]).loc[df.index]
        out[r] = gate_metrics(df, dec)
        out[r]["per_fold"] = per_fold[r]
    return out, pd.concat(decs[rules[0]]).loc[df.index]


def time_split(df: pd.DataFrame, frac: float = 0.7, embargo_hours: float = 3.0):
    cut = df["start_ns"].quantile(frac)
    tr = df[df["end_ns"] < cut - embargo_hours * cf.NS_PER_H]
    te = df[df["start_ns"] >= cut]
    return tr, te, pd.Timestamp(int(cut), tz="UTC")


def eval_time(df: pd.DataFrame, variant: str, frac: float = 0.7, seed: int = 0,
              rules: Sequence[str] = tuple(RULES), **kw):
    tr, te, cut = time_split(df, frac)
    gm = fit_gated(tr, variant, seed=seed, **kw)
    raw = gm.scores(te)
    unseen = ~te["ground_station"].isin(set(tr["ground_station"]))
    out = {}
    for r in rules:
        dec = gm.decide(te, r, raw)
        m = gate_metrics(te, dec)
        m["cut"] = cut.isoformat()
        m["n_train"] = int(len(tr))
        m["unseen_stations"] = gate_metrics(te[unseen], dec[unseen]) if unseen.sum() > 20 else {"n": int(unseen.sum())}
        out[r] = m
    return out, gm.decide(te, rules[0], raw), te


def fmt(x, nd=3, pct=False):
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return "–"
    return f"{100 * x:.1f}%" if pct else f"{x:.{nd}f}"


def fmt_ci(ci):
    if not ci or ci[0] is None or (isinstance(ci[0], float) and np.isnan(ci[0])):
        return "–"
    return f"{ci[0]:.3f}–{ci[1]:.3f}"


def plot_pr(curves: Dict[str, Tuple[np.ndarray, np.ndarray, Optional[Tuple[float, float]]]], path: Path, title: str):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from sklearn.metrics import precision_recall_curve
    fig, ax = plt.subplots(figsize=(6.5, 4.8))
    for name, (y, s, pt) in curves.items():
        if len(np.unique(y)) < 2:
            continue
        p, r, _ = precision_recall_curve(y, s)
        line, = ax.plot(r, p, label=name, lw=1.6)
        if pt is not None and pt[0] is not None:
            ax.scatter([pt[1]], [pt[0]], color=line.get_color(), zorder=5, s=36, edgecolor="k")
    ax.axhline(0.95, color="grey", ls="--", lw=1)
    ax.text(0.99, 0.955, "0.95 auto-decide gate", ha="right", va="bottom", fontsize=8, color="grey")
    ax.set_xlabel("recall (share of real failures)")
    ax.set_ylabel("precision of 'failed' calls")
    ax.set_ylim(0.4, 1.01)
    ax.set_xlim(0, 1)
    ax.set_title(title, fontsize=10)
    ax.legend(fontsize=8, loc="lower left")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def evaluate(lags=(1.0, 3.0), variants: Sequence[str] = tuple(VARIANTS), rule: str = DEFAULT_RULE,
             out_name: str = "final_v3") -> Dict:
    """All variants x all in-fold threshold rules; `rule` is the one shown in the main tables."""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    raw, hours = load_raw()
    rules = [rule] + [r for r in RULES if r != rule]
    results = {"generated_at": datetime.now(timezone.utc).isoformat(), "rule": rule, "rules": RULES, "lags": {}}
    curves_station, curves_time = {}, {}
    for lag in lags:
        t0 = time.time()
        df = build(lag, raw=raw, hours=hours)
        info = {"n": len(df), "n_obs_all": df.attrs.get("n_obs_all"), "n_covered": df.attrs.get("n_covered"),
                "stations": int(df["ground_station"].nunique()),
                "status_counts": df["status"].value_counts().to_dict(),
                "span": [df["start_ts"].min().isoformat(), df["start_ts"].max().isoformat()],
                "build_s": round(time.time() - t0, 1), "variants": {}}
        print(f"lag {lag}h: {len(df)} labeled covered passes, {info['stations']} stations", flush=True)
        for v in variants:
            t1 = time.time()
            ms, dec_s = eval_station_cv(df, v, rules=rules)
            mt, dec_t, te = eval_time(df, v, rules=rules)
            info["variants"][v] = {"station_cv": ms, "time": mt, "seconds": round(time.time() - t1, 1)}
            a, b = ms[rule], mt[rule]
            print(f"  {v:18s} station: prec {fmt(a['fail_precision'])} rec {fmt(a['fail_recall'])} "
                  f"n={a['fail_flagged']} | time: prec {fmt(b['fail_precision'])} rec {fmt(b['fail_recall'])} "
                  f"n={b['fail_flagged']} ({time.time() - t1:.0f}s)", flush=True)
            if lag == lags[0]:
                curves_station[v] = (df["y"].to_numpy(), dec_s["p_fail"].to_numpy(),
                                     (a["fail_precision"], a["fail_recall"]))
                curves_time[v] = (te["y"].to_numpy(), dec_t["p_fail"].to_numpy(),
                                  (b["fail_precision"], b["fail_recall"]))
        results["lags"][f"{lag:g}h"] = info
    plot_pr(curves_station, REPORT_DIR / f"{out_name}_pr_station.png",
            f"Held-out stations (lag {lags[0]:g}h): dots = gate picked inside training folds ({rule})")
    plot_pr(curves_time, REPORT_DIR / f"{out_name}_pr_time.png",
            f"Future-time split (lag {lags[0]:g}h): dots = gate picked inside training folds ({rule})")
    json.dump(results, open(REPORT_DIR / f"{out_name}.json", "w"), indent=1, default=float)
    (REPORT_DIR / f"{out_name}.md").write_text(render_report(results, out_name))
    return results


def _rule_desc(r: str) -> str:
    kind, target, z = RULES[r]
    return (f"Wilson lower bound (z={z:g}) of inner OOF precision >= {target}" if kind == "wilson"
            else f"inner OOF precision >= {target}")


def render_report(res: Dict, out_name: str) -> str:
    rule = res["rule"]
    L = ["# Final pass-failure classifier (v3): held-out evaluation", "",
         f"Generated {res['generated_at']} by `python -m ml.final_model evaluate`. "
         f"Main tables use in-fold threshold rule `{rule}` ({_rule_desc(rule)}); the gate threshold is always "
         "picked on station-grouped out-of-fold scores *inside the training fold* and then applied once to the test fold. "
         "Failure = SatNOGS status `failed` or `bad`. Precision CIs: Wilson (binomial) and station-cluster "
         "bootstrap (resampling stations, 1,000 reps). Coverage = share of all test passes auto-decided as failed.", ""]
    for lag, info in res["lags"].items():
        L += [f"## Label latency {lag}", "",
              f"{info['n']} labeled passes with full {lag}+{LOOKBACK_H:g}h history coverage "
              f"(of {info['n_obs_all']} stored observations), {info['stations']} stations, "
              f"span {info['span'][0][:16]} to {info['span'][1][:16]} UTC. Status mix: {info['status_counts']}.", ""]
        for split, title in (("station_cv", "Held-out stations (5 station-grouped folds)"),
                             ("time", "Future time (train first 70%, 3h embargo)")):
            L += [f"### {title}", "",
                  "| variant | AUC | auto 'failed' calls | precision | 95% CI (Wilson) | 95% CI (station bootstrap) "
                  "| recall (all failures) | recall failed / bad | coverage | OK side: precision / coverage "
                  "| accuracy on auto-decided (both sides) |",
                  "|---|---|---|---|---|---|---|---|---|---|---|"]
            for v, r in info["variants"].items():
                m = r[split][rule]
                L.append(f"| {v} | {fmt(m['auc'])} | {m['fail_flagged']} | {fmt(m['fail_precision'])} | "
                         f"{fmt_ci(m['fail_precision_wilson'])} | {fmt_ci(m['fail_precision_cluster_ci'])} | "
                         f"{fmt(m['fail_recall'], pct=True)} | {fmt(m['recall_failed_class'], pct=True)} / "
                         f"{fmt(m['recall_bad_class'], pct=True)} | {fmt(m['coverage_fail_only'], pct=True)} | "
                         f"{fmt(m['ok_precision'])} / {fmt(m['ok_cleared'] / m['n'] if m['n'] else None, pct=True)} | "
                         f"{fmt(m['accuracy_auto_two_sided'])} |")
            L.append("")
            if split == "time":
                L += ["Future time, test stations never seen in training:", "",
                      "| variant | n | auto 'failed' calls | precision | 95% CI (Wilson) | recall |", "|---|---|---|---|---|---|"]
                for v, r in info["variants"].items():
                    u = r["time"][rule].get("unseen_stations", {})
                    if "fail_flagged" not in u:
                        L.append(f"| {v} | {u.get('n')} | – | – | – | – |")
                        continue
                    L.append(f"| {v} | {u['n']} | {u['fail_flagged']} | {fmt(u['fail_precision'])} | "
                             f"{fmt_ci(u['fail_precision_wilson'])} | {fmt(u['fail_recall'], pct=True)} |")
                L.append("")
        L += ["### In-fold threshold rule comparison (failed side)", "",
              "| variant | rule | held-out stations: calls / precision (Wilson CI) / recall | "
              "future time: calls / precision (Wilson CI) / recall |", "|---|---|---|---|"]
        for v, r in info["variants"].items():
            for rr in res["rules"]:
                a, b = r["station_cv"].get(rr), r["time"].get(rr)
                if a is None:
                    continue
                L.append(f"| {v} | {rr} | {a['fail_flagged']} / {fmt(a['fail_precision'])} "
                         f"({fmt_ci(a['fail_precision_wilson'])}) / {fmt(a['fail_recall'], pct=True)} | "
                         f"{b['fail_flagged']} / {fmt(b['fail_precision'])} ({fmt_ci(b['fail_precision_wilson'])}) / "
                         f"{fmt(b['fail_recall'], pct=True)} |")
        L.append("")
        fin = info["variants"].get(FINAL_VARIANT)
        if fin:
            L += [f"Per-fold precision of `{FINAL_VARIANT}` on held-out stations ({rule}): " + ", ".join(
                f"{fmt(p['fail_precision'])} (n={p['fail_flagged']})" for p in fin["station_cv"][rule]["per_fold"]), ""]
    L += [f"![held-out stations PR]({out_name}_pr_station.png)", "",
          f"![future time PR]({out_name}_pr_time.png)", ""]
    return "\n".join(L)


# --------------------------------------------------------------------------- final training / serving


def _next_version(prev: Optional[str]) -> str:
    if not prev:
        return BASE_VERSION
    core = prev.lstrip("v").split("+")[0]
    a, b, c = (int(x) for x in core.split("."))
    return f"v{a}.{b}.{c + 1}"


def registry_path(model_dir: Optional[Path] = None) -> Path:
    return Path(model_dir or MODEL_DIR) / "registry.json"


def load_registry(model_dir: Optional[Path] = None) -> Dict:
    p = registry_path(model_dir)
    return json.load(open(p)) if p.exists() else {"current": None, "history": []}


def save_artifacts(gm: GatedModel, version: str, meta: Dict, model_dir: Optional[Path] = None) -> Dict:
    model_dir = Path(model_dir or MODEL_DIR)
    model_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump({"booster_variant": gm.booster.variant, "numeric": gm.booster.numeric, "cats": gm.booster.cats,
                 "model_str": gm.booster.model.model_to_string() if gm.booster.model else None,
                 "calibrator": gm.calibrator, "t_fail": gm.t_fail, "t_ok": gm.t_ok, "targets": gm.targets,
                 "rules": gm.rules, "rule": gm.rule},
                model_dir / f"model_{version}.joblib", compress=3)
    cfg = {"version": version, "variant": gm.booster.variant, "feature_names": gm.booster.feature_names,
           "numeric_features": gm.booster.numeric, "categories": gm.booster.cats,
           "t_fail_raw": gm.t_fail, "t_ok_raw": gm.t_ok,
           "t_fail_calibrated": float(gm.calibrator.predict([gm.t_fail])[0]) if gm.t_fail is not None else None,
           "targets_raw": gm.targets, **meta}
    json.dump(cfg, open(model_dir / f"config_{version}.json", "w"), indent=1, default=float)
    reg = load_registry(model_dir)
    reg["current"] = version
    reg["history"].append({"version": version, "created_at": datetime.now(timezone.utc).isoformat(),
                           **{k: meta.get(k) for k in ("reason", "n_train", "n_human_labels", "fit_seconds")}})
    json.dump(reg, open(registry_path(model_dir), "w"), indent=1, default=float)
    return cfg


def load_gated(version: Optional[str] = None, model_dir: Optional[Path] = None) -> Tuple[GatedModel, Dict]:
    model_dir = Path(model_dir or MODEL_DIR)
    version = version or load_registry(model_dir)["current"]
    blob = joblib.load(model_dir / f"model_{version}.joblib")
    b = Booster(blob["booster_variant"], blob["numeric"], blob["cats"],
                lgb.Booster(model_str=blob["model_str"]) if blob["model_str"] else None)
    cfg = json.load(open(model_dir / f"config_{version}.json"))
    return GatedModel(b, blob["calibrator"], blob["t_fail"], blob["t_ok"], blob["targets"], {},
                      blob.get("rules", {}), blob.get("rule", DEFAULT_RULE)), cfg


def gate_fields(gm: GatedModel, cfg: Dict, dec_row) -> Dict:
    """Map a decision to `confidence_gate::process_claim_decision` inputs.

    Auto-decided calls carry the measured held-out precision of the gate
    (>= 95 by construction of the threshold rule, floored at 95); everything
    else is capped at 94 (cleared the 0.90 operating point) or 79.
    """
    measured = cfg.get("heldout_fail_precision") or 0.95
    if dec_row["auto_fail"]:
        return {"route": "auto", "decision": "failed", "confidence_percent": max(95, int(measured * 100))}
    if dec_row["auto_ok"]:
        ok_prec = cfg.get("heldout_ok_precision") or 0.95
        return {"route": "auto", "decision": "fine", "confidence_percent": max(95, int(ok_prec * 100))}
    t90 = (cfg.get("targets_raw") or {}).get("0.90")
    if t90 is not None and dec_row["raw"] >= t90:
        return {"route": "human", "decision": "likely_failed", "confidence_percent": 94}
    return {"route": "human", "decision": "uncertain",
            "confidence_percent": min(79, int(100 * max(dec_row["p_fail"], 1 - dec_row["p_fail"])))}


def featurize(new_obs: pd.DataFrame, context_obs: pd.DataFrame, lag_hours: float = 1.0,
              decision_time: Optional[pd.Timestamp] = None, human_known: Optional[Dict[int, str]] = None) -> pd.DataFrame:
    """Serving-time features for `new_obs` (SatNOGS-shaped rows, status ignored).

    `context_obs` is the operator's record of earlier passes (any statuses, with
    vetting timestamps); only outcomes known by the decision time are used.
    `human_known` maps observation id -> ISO time of a human ruling, which makes
    that outcome known from then on (the HITL early-label effect).
    """
    new = new_obs.copy()
    new["status"] = "future"
    allobs = cf.normalize_observations(pd.concat([context_obs, new], ignore_index=True, sort=False))
    known = cf.label_known_at(allobs, lag_hours)
    if human_known:
        ids = allobs["id"].to_numpy()
        for oid, t in human_known.items():
            known[ids == oid] = np.minimum(known[ids == oid], pd.Timestamp(t).value)
    q = np.where(allobs["id"].isin(set(new["id"])).to_numpy())[0]
    T = None if decision_time is None else np.full(len(q), pd.Timestamp(decision_time).value)
    hist = cf.history_features(allobs, known, q, LOOKBACK_H, LONG_LOOKBACK_H, query_time_ns=T)
    phys = cf.physical_features(allobs.iloc[q], load_stations(), load_kp())
    base = allobs.iloc[q][["id", "ground_station", "norad_cat_id", "start_ns", "end_ns"]]
    return pd.concat([base, phys, hist], axis=1).reset_index(drop=True)


def score_observations(new_obs: pd.DataFrame, context_obs: pd.DataFrame, version: Optional[str] = None,
                       **kw) -> List[Dict]:
    """Gate decisions (+ the feature rows, for `hitl.ingest_labeled_decision`)."""
    gm, cfg = load_gated(version)
    X = featurize(new_obs, context_obs, cfg.get("lag_hours", 1.0), **kw)
    dec = gm.decide(X)
    out = []
    for (_, x), (_, d) in zip(X.iterrows(), dec.iterrows()):
        out.append({"pass_id": int(x["id"]), "model_version": cfg["version"], "failure_probability": float(d["p_fail"]),
                    **gate_fields(gm, cfg, d),
                    "features": {k: (None if isinstance(v, float) and np.isnan(v) else v)
                                 for k, v in x.items() if k in gm.booster.feature_names}})
    return out


def train_final(lag_hours: float = 1.0, variant: str = FINAL_VARIANT, reason: str = "manual",
                version: Optional[str] = None, eval_json: Optional[Path] = None, write_snap: bool = True) -> Dict:
    raw, hours = load_raw()
    if write_snap and not raw.empty and "fetched_at" in raw:
        write_snapshot(raw)
    df = build(lag_hours, raw=raw, hours=hours)
    t0 = time.time()
    gm = fit_gated(df, variant, inner_folds=5)
    fit_s = time.time() - t0
    meta = {"reason": reason, "rule": gm.rule, "rule_spec": RULES[gm.rule], "lag_hours": lag_hours, "lookback_hours": LOOKBACK_H, "n_train": len(df),
            "n_human_labels": 0, "fit_seconds": round(fit_s, 2), "trained_at": datetime.now(timezone.utc).isoformat(),
            "status_counts": df["status"].value_counts().to_dict(), "inner": gm.inner}
    ev = eval_json or REPORT_DIR / "final_v3.json"
    if Path(ev).exists():
        r = json.load(open(ev))["lags"].get(f"{lag_hours:g}h", {}).get("variants", {}).get(variant)
        if r and gm.rule in r["station_cv"]:
            st, tm = r["station_cv"][gm.rule], r["time"][gm.rule]
            meta["heldout_fail_precision"] = st["fail_precision"]
            meta["heldout_fail_precision_wilson"] = st["fail_precision_wilson"]
            meta["heldout_fail_recall"] = st["fail_recall"]
            meta["heldout_ok_precision"] = st["ok_precision"]
            meta["time_fail_precision"] = tm["fail_precision"]
            meta["time_fail_recall"] = tm["fail_recall"]
    reg = load_registry()
    version = version or (BASE_VERSION if reg["current"] is None else _next_version(reg["current"]))
    cfg = save_artifacts(gm, version, meta)
    print(f"saved {version}: n={len(df)} t_fail={gm.t_fail} t_ok={gm.t_ok} fit {fit_s:.1f}s")
    return cfg


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("evaluate")
    e.add_argument("--lags", default="1,3")
    e.add_argument("--variants", default=",".join(VARIANTS))
    e.add_argument("--rule", default=DEFAULT_RULE, choices=list(RULES))
    e.add_argument("--out", default="final_v3")
    t = sub.add_parser("train")
    t.add_argument("--lag", type=float, default=1.0)
    t.add_argument("--variant", default=FINAL_VARIANT)
    t.add_argument("--version")
    r = sub.add_parser("retrain")
    r.add_argument("--scheduled", action="store_true")
    r.add_argument("--lag", type=float, default=1.0)
    args = p.parse_args(argv)
    if args.cmd == "evaluate":
        evaluate(tuple(float(x) for x in args.lags.split(",")), args.variants.split(","), args.rule, args.out)
    elif args.cmd == "train":
        train_final(args.lag, args.variant, version=args.version)
    elif args.cmd == "retrain":
        train_final(args.lag, reason="scheduled" if args.scheduled else "retrain", write_snap=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
