"""
v3 abstaining models for the time-uniform dataset (ml/uniform_data.py).

Pieces, all switchable per experiment:
  * base learners: CatBoost, logistic regression (splines + one-hot), optional XGBoost
  * combiner: fixed-weight average, or a stacked logistic-regression meta-learner
    fit on out-of-fold base scores
  * conformal: global Mondrian (class-conditional), or group-conditional Mondrian
    (separate class-conditional thresholds per group, e.g. station-history bucket x band)
  * routing: single binary model, or two stages (P(no data); P(bad | data produced))

Every model is cross-fitted on station groups: one fold model per held-out
station group gives out-of-fold scores on all training passes; calibration,
conformal thresholds and alpha selection use only those OOF scores.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.compose import ColumnTransformer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, SplineTransformer, StandardScaler

from .conformal_ensemble import (
    ABSTAIN, ALPHA_GRID, FAIL, OK, MondrianConformal, decision_metrics,
)

FAIL_NODATA, FAIL_BAD = "FAIL_NODATA", "FAIL_BAD"


@dataclass
class V3Config:
    numeric: List[str]
    categorical: List[str]
    use_xgb: bool = False
    stacked: bool = False
    weights: Dict[str, float] = field(default_factory=lambda: {"cb": 0.6, "lr": 0.4})
    cb_iterations: int = 600
    cb_depth: int = 5
    cb_lr: float = 0.03
    lr_C: float = 0.3
    seed: int = 42


class BaseLearners:
    def __init__(self, cfg: V3Config):
        self.cfg = cfg
        self.medians_: Dict[str, float] = {}
        self.models_: Dict[str, object] = {}

    def _prep(self, X: pd.DataFrame) -> pd.DataFrame:
        X = X[self.cfg.numeric + self.cfg.categorical].copy()
        for c in self.cfg.numeric:
            X[c] = pd.to_numeric(X[c], errors="coerce").astype(float)
        for c in self.cfg.categorical:
            X[c] = X[c].astype(str)
        return X

    def _filled(self, Xp: pd.DataFrame) -> pd.DataFrame:
        Xf = Xp.copy()
        for c in self.cfg.numeric:
            Xf[c] = Xf[c].fillna(self.medians_.get(c, 0.0))
        return Xf

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> "BaseLearners":
        cfg = self.cfg
        Xp = self._prep(X)
        self.medians_ = {c: float(Xp[c].median()) if Xp[c].notna().any() else 0.0 for c in cfg.numeric}
        Xf = self._filled(Xp)
        cb = CatBoostClassifier(iterations=cfg.cb_iterations, depth=cfg.cb_depth, learning_rate=cfg.cb_lr,
                                l2_leaf_reg=5.0, random_seed=cfg.seed, verbose=False,
                                allow_writing_files=False, thread_count=-1)
        cb.fit(Xf, y, cat_features=cfg.categorical)
        self.models_["cb"] = cb

        spline = [c for c in ("max_elevation_deg", "log_duration", "elevation_margin_deg") if c in cfg.numeric]
        linear = [c for c in cfg.numeric if c not in spline]
        lr = Pipeline([
            ("pre", ColumnTransformer([
                ("spl", Pipeline([("sc", StandardScaler()), ("sp", SplineTransformer(n_knots=5, degree=3))]), spline),
                ("num", StandardScaler(), linear),
                ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=10), cfg.categorical),
            ])),
            ("lr", LogisticRegression(C=cfg.lr_C, max_iter=5000)),
        ])
        lr.fit(Xf, y)
        self.models_["lr"] = lr

        if cfg.use_xgb:
            from xgboost import XGBClassifier
            Xx = Xp.copy()
            for c in cfg.categorical:
                Xx[c] = Xx[c].astype("category")
            self.xgb_categories_ = {c: Xx[c].cat.categories for c in cfg.categorical}
            xgb = XGBClassifier(n_estimators=500, max_depth=4, learning_rate=0.03, subsample=0.8,
                                colsample_bytree=0.8, min_child_weight=3, reg_lambda=2.0,
                                tree_method="hist", enable_categorical=True, random_state=cfg.seed, n_jobs=-1)
            xgb.fit(Xx, y)
            self.models_["xgb"] = xgb
        return self

    def scores(self, X: pd.DataFrame) -> pd.DataFrame:
        Xp = self._prep(X)
        Xf = self._filled(Xp)
        out = {"cb": self.models_["cb"].predict_proba(Xf)[:, 1], "lr": self.models_["lr"].predict_proba(Xf)[:, 1]}
        if "xgb" in self.models_:
            Xx = Xp.copy()
            for c in self.cfg.categorical:
                Xx[c] = pd.Categorical(Xx[c], categories=self.xgb_categories_[c])
            out["xgb"] = self.models_["xgb"].predict_proba(Xx)[:, 1]
        return pd.DataFrame(out, index=X.index)


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


class GroupConformal:
    """Class-conditional conformal thresholds per group; groups with too few calibration points use the global fit."""

    def __init__(self, min_per_class: int = 40):
        self.min_per_class = min_per_class
        self.global_: Optional[MondrianConformal] = None
        self.by_group_: Dict[str, MondrianConformal] = {}

    def fit(self, p: np.ndarray, y: np.ndarray, groups: Optional[np.ndarray]) -> "GroupConformal":
        self.global_ = MondrianConformal().fit(p, y)
        self.by_group_ = {}
        if groups is not None:
            for g in np.unique(groups):
                m = groups == g
                if (y[m] == 1).sum() >= self.min_per_class and (y[m] == 0).sum() >= self.min_per_class:
                    self.by_group_[g] = MondrianConformal().fit(p[m], y[m])
        return self

    def decide(self, p: np.ndarray, alpha, groups: Optional[np.ndarray] = None) -> np.ndarray:
        out = self.global_.decide(p, alpha)
        if groups is not None:
            for g, conf in self.by_group_.items():
                m = groups == g
                if m.any():
                    out[m] = conf.decide(p[m], alpha)
        return out


def _select_alpha_escalation(decide, p, target):
    esc = [np.mean(decide(p, a) == ABSTAIN) for a in ALPHA_GRID]
    return ALPHA_GRID[int(np.argmin(np.abs(np.array(esc) - target)))]


def _select_alpha_precision(decide, p, y, target, min_calls=10):
    grid = [0.0] + ALPHA_GRID
    best, best_cov = (0.0, 0.0), 0.0
    for af in grid:
        for ao in grid:
            m = decision_metrics(y, _binary(decide(p, (af, ao))))
            okf = m["n_fail_calls"] == 0 or (m["n_fail_calls"] >= min_calls and m["precision_fail"] >= target)
            oko = m["n_ok_calls"] == 0 or (m["n_ok_calls"] >= min_calls and m["precision_ok"] >= target)
            if okf and oko and m["coverage"] > best_cov:
                best, best_cov = (af, ao), m["coverage"]
    return best


def _binary(d: np.ndarray) -> np.ndarray:
    d = d.copy()
    d[(d == FAIL_NODATA) | (d == FAIL_BAD)] = FAIL
    return d


class AbstainV3:
    """Single-stage binary abstainer (fail = bad or failed)."""

    def __init__(self, cfg: V3Config, n_inner: int = 4, group_col: Optional[str] = None,
                 escalation_target: float = 0.17, precision_target: float = 0.95):
        self.cfg = cfg
        self.n_inner = n_inner
        self.group_col = group_col
        self.escalation_target = escalation_target
        self.precision_target = precision_target

    def _groups(self, X):
        return X[self.group_col].astype(str).to_numpy() if self.group_col else None

    def _combine(self, S: pd.DataFrame) -> np.ndarray:
        if self.cfg.stacked:
            return self.meta_.predict_proba(_logit(S[self.base_names_].to_numpy()))[:, 1]
        w = self.cfg.weights
        tot = sum(w.get(k, 0) for k in S.columns)
        return sum(w.get(k, 0) * S[k].to_numpy() for k in S.columns) / tot

    def fit(self, X: pd.DataFrame, y: np.ndarray, status: np.ndarray) -> "AbstainV3":
        self.models_: List[BaseLearners] = []
        oof = None
        for fi, ci in GroupKFold(self.n_inner).split(X, y, X["station_id"]):
            m = BaseLearners(self.cfg).fit(X.iloc[fi], y[fi])
            s = m.scores(X.iloc[ci])
            if oof is None:
                oof = pd.DataFrame(0.0, index=X.index, columns=s.columns)
            oof.iloc[ci] = s.values
            self.models_.append(m)
        self.base_names_ = list(oof.columns)
        if self.cfg.stacked:
            self.meta_ = LogisticRegression(C=1.0).fit(_logit(oof.to_numpy()), y)
        p = self._combine(oof)
        self.oof_score_ = p
        self.iso_ = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(p, y)
        g = self._groups(X)
        self.conf_ = GroupConformal().fit(p, y, g)
        decide = lambda s, a: self.conf_.decide(s, a, g)
        self.alphas_ = {
            "esc17": _select_alpha_escalation(decide, p, self.escalation_target),
            "prec95": _select_alpha_precision(decide, p, y, self.precision_target),
        }
        return self

    def score(self, X: pd.DataFrame) -> np.ndarray:
        S = sum(m.scores(X) for m in self.models_) / len(self.models_)
        return self._combine(S)

    def decide(self, X: pd.DataFrame) -> Dict[str, np.ndarray]:
        s = self.score(X)
        g = self._groups(X)
        return {k: self.conf_.decide(s, a, g) for k, a in self.alphas_.items()}


class TwoStageV3:
    """
    Stage A: P(no data) on all passes. Stage B: P(bad | data produced) on passes
    that produced data. Each stage gets its own Mondrian conformal predictor.

        A says no-data (singleton)                  -> FAIL_NODATA
        A says data (singleton), B says bad         -> FAIL_BAD
        A says data, B says good                    -> OK
        anything else                               -> ABSTAIN

    Alphas are an (alpha_A, alpha_B) pair chosen on OOF scores; each may be a
    per-class (alpha_fail, alpha_ok) pair so a route can be switched off.
    """

    def __init__(self, cfg: V3Config, n_inner: int = 4, escalation_target: float = 0.17,
                 precision_target: float = 0.95):
        self.cfg = cfg
        self.n_inner = n_inner
        self.escalation_target = escalation_target
        self.precision_target = precision_target

    def _crossfit(self, X, y, mask_fit):
        models, oof = [], np.zeros(len(y))
        for fi, ci in GroupKFold(self.n_inner).split(X, y, X["station_id"]):
            fi = fi[mask_fit[fi]]
            m = BaseLearners(self.cfg).fit(X.iloc[fi], y[fi])
            s = m.scores(X.iloc[ci])
            w = self.cfg.weights
            oof[ci] = sum(w.get(k, 0) * s[k] for k in s.columns) / sum(w.get(k, 0) for k in s.columns)
            models.append(m)
        return models, oof

    def _score(self, models, X):
        S = sum(m.scores(X) for m in models) / len(models)
        w = self.cfg.weights
        return (sum(w.get(k, 0) * S[k] for k in S.columns) / sum(w.get(k, 0) for k in S.columns)).to_numpy()

    def _route(self, pa, pb, alpha_pair):
        aa, ab = alpha_pair
        da = self.conf_a_.decide(pa, aa)
        db = self.conf_b_.decide(pb, ab)
        out = np.full(len(pa), ABSTAIN, dtype=object)
        out[da == FAIL] = FAIL_NODATA
        data = da == OK
        out[data & (db == FAIL)] = FAIL_BAD
        out[data & (db == OK)] = OK
        return out

    def fit(self, X: pd.DataFrame, y: np.ndarray, status: np.ndarray) -> "TwoStageV3":
        ya = (status == "failed").astype(int)
        yb = (status == "bad").astype(int)
        data = status != "failed"
        self.models_a_, pa = self._crossfit(X, ya, np.ones(len(y), bool))
        self.models_b_, pb = self._crossfit(X, yb, data)
        self.conf_a_ = MondrianConformal().fit(pa, ya)
        self.conf_b_ = MondrianConformal().fit(pb[data], yb[data])
        self.oof_score_ = pa + (1 - pa) * pb

        best_e, best_gap = (ALPHA_GRID[0], ALPHA_GRID[0]), np.inf
        for aa in ALPHA_GRID:
            for ab in ALPHA_GRID:
                esc = np.mean(self._route(pa, pb, (aa, ab)) == ABSTAIN)
                if abs(esc - self.escalation_target) < best_gap:
                    best_e, best_gap = (aa, ab), abs(esc - self.escalation_target)
        coarse = [0.0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2]
        best_p, best_cov = None, 0.0
        for aaf in coarse:
            for aao in coarse:
                for abf in coarse:
                    for abo in coarse:
                        a = ((aaf, aao), (abf, abo))
                        m = decision_metrics(y, _binary(self._route(pa, pb, a)))
                        okf = m["n_fail_calls"] == 0 or (m["n_fail_calls"] >= 10 and m["precision_fail"] >= self.precision_target)
                        oko = m["n_ok_calls"] == 0 or (m["n_ok_calls"] >= 10 and m["precision_ok"] >= self.precision_target)
                        if okf and oko and m["coverage"] > best_cov:
                            best_p, best_cov = a, m["coverage"]
        self.alphas_ = {"esc17": best_e, "prec95": best_p or ((0.0, 0.0), (0.0, 0.0))}
        return self

    def score(self, X: pd.DataFrame) -> np.ndarray:
        pa = self._score(self.models_a_, X)
        pb = self._score(self.models_b_, X)
        return pa + (1 - pa) * pb

    def decide(self, X: pd.DataFrame) -> Dict[str, np.ndarray]:
        pa = self._score(self.models_a_, X)
        pb = self._score(self.models_b_, X)
        return {k: self._route(pa, pb, a) for k, a in self.alphas_.items()}
