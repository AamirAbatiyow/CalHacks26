"""
Calibrated ensemble + split-conformal abstention for pass-failure prediction.

Every pass gets one of three decisions:

    FAIL     - confident the pass will fail (conformal set == {fail})
    OK       - confident the pass will succeed (conformal set == {ok})
    ABSTAIN  - conformal set is {fail, ok} or empty; escalate to a human

Model: CatBoost + L2 logistic regression, probabilities averaged, then
isotonic-calibrated on a held-out calibration split. Decisions come from
class-conditional (Mondrian) split-conformal thresholds fitted on the same
calibration split. Isotonic is monotone in the ensemble score, so the conformal
sets are computed on the raw ensemble score; this keeps the finite-sample
coverage guarantee exact while still exposing calibrated probabilities.

Features deliberately exclude:
    station_id / station_name  - identity leak; evaluation holds out stations
    kp_at_time                 - each status was fetched over a different time
                                 window, so Kp encodes the label via time
    weather columns            - 100% null in the current dataset
    start_time / pass_id       - same time-window leak as Kp
    station status / last_seen - snapshotted after the passes ran (ablation only)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.compose import ColumnTransformer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, SplineTransformer, StandardScaler

DATA_DIR = Path(__file__).parent.parent / "data" / "processed"
REFERENCE_DATE = pd.Timestamp("2026-10-24", tz="UTC")

OMNI_ANTENNAS = {
    "turnstile", "quadrafilar", "eggbeater", "other omni", "ground",
    "vertical", "dipole", "discone", "v-dipole", "lindenblad",
}
DIRECTIONAL_ANTENNAS = {
    "yagi", "cross-yagi", "helical", "parabolic", "patch", "other direct",
}
ANTENNA_FLAGS = ["yagi", "cross-yagi", "turnstile", "quadrafilar", "eggbeater", "helical"]
BAND_FLAGS = ["VHF", "UHF", "L", "S", "HF"]

NUMERIC_FEATURES = [
    "max_elevation_deg",
    "duration_sec",
    "log_duration",
    "elevation_margin_deg",
    "station_min_horizon",
    "station_lat",
    "station_lon",
    "station_abs_lat",
    "station_altitude_m",
    "station_age_days",
    "n_antennas",
    "n_bands",
    "has_omni",
    "has_directional",
    "sat_fail_rate_te",
    "sat_bad_rate_te",
    "sat_failed_rate_te",
    "satmode_fail_rate_te",
    "sat_n_obs_log",
] + [f"ant_{a}" for a in ANTENNA_FLAGS] + [f"band_{b}" for b in BAND_FLAGS]

CATEGORICAL_FEATURES = ["transmitter_mode", "mode_family"]

ABLATION_FEATURES = ["station_status"]

FAIL, OK, ABSTAIN = "FAIL", "OK", "ABSTAIN"

Alpha = Union[float, Tuple[float, float]]


def load_passes(path: Optional[Path] = None) -> pd.DataFrame:
    path = path or DATA_DIR / "passes_features.parquet"
    return pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path)


def load_station_meta(path: Optional[Path] = None) -> pd.DataFrame:
    path = path or DATA_DIR / "stations.json"
    with open(path) as f:
        st = pd.DataFrame(json.load(f))
    st = st[st["source"] == "satnogs"].copy()
    st["id"] = pd.to_numeric(st["id"], errors="coerce")
    return st.dropna(subset=["id"]).astype({"id": int}).drop_duplicates("id")


def get_target(df: pd.DataFrame) -> np.ndarray:
    """1 = failed/bad pass, 0 = good pass."""
    return (1 - df["outcome_label"].astype(int)).to_numpy()


def _mode_family(mode: str) -> str:
    m = str(mode).upper()
    for fam in ("GMSK", "GFSK", "MSK", "BPSK", "QPSK", "AFSK", "FSK", "LORA", "SSTV", "CW", "FM", "USB"):
        if fam in m:
            return fam
    return "OTHER"


def build_features(df: pd.DataFrame, stations: pd.DataFrame) -> pd.DataFrame:
    """Label-free features. Satellite target encoding is added separately (fold-aware)."""
    st = stations.set_index("id")
    sid = df["station_id"].astype(int)
    meta = st.reindex(sid.values)

    out = pd.DataFrame(index=df.index)
    out["max_elevation_deg"] = df["max_elevation_deg"].astype(float).values
    out["duration_sec"] = df["duration_sec"].astype(float).values
    out["log_duration"] = np.log1p(out["duration_sec"])

    min_hor = pd.to_numeric(meta["min_horizon"], errors="coerce").to_numpy()
    out["station_min_horizon"] = min_hor
    out["elevation_margin_deg"] = out["max_elevation_deg"].values - np.nan_to_num(min_hor, nan=0.0)

    out["station_lat"] = df["station_lat"].astype(float).values
    out["station_lon"] = df["station_lon"].astype(float).values
    out["station_abs_lat"] = out["station_lat"].abs()
    out["station_altitude_m"] = pd.to_numeric(meta["altitude_m"], errors="coerce").to_numpy()
    created = pd.to_datetime(meta["created"], errors="coerce", utc=True)
    out["station_age_days"] = (REFERENCE_DATE - created).dt.days.to_numpy().astype(float)

    antennas = [
        [str(a).lower() for a in lst] if isinstance(lst, (list, np.ndarray)) else []
        for lst in meta["antennas"].tolist()
    ]
    bands = [
        sorted({b.strip().upper() for entry in lst for b in str(entry).split(",")})
        if isinstance(lst, (list, np.ndarray)) else []
        for lst in meta["bands"].tolist()
    ]
    out["n_antennas"] = [len(a) for a in antennas]
    out["n_bands"] = [len(b) for b in bands]
    out["has_omni"] = [int(any(x in OMNI_ANTENNAS for x in a)) for a in antennas]
    out["has_directional"] = [int(any(x in DIRECTIONAL_ANTENNAS for x in a)) for a in antennas]
    for a in ANTENNA_FLAGS:
        out[f"ant_{a}"] = [int(a in lst) for lst in antennas]
    for b in BAND_FLAGS:
        out[f"band_{b}"] = [int(b in lst) for lst in bands]

    mode = df["transmitter_mode"].fillna("UNKNOWN").astype(str)
    out["transmitter_mode"] = mode.values
    out["mode_family"] = mode.map(_mode_family).values
    out["station_status"] = meta["status"].fillna("NA").astype(str).values

    out["satellite_norad_id"] = df["satellite_norad_id"].astype(int).values
    out["station_id"] = sid.values
    return out


SAT_TE_FEATURES = [
    "sat_fail_rate_te",
    "sat_bad_rate_te",
    "sat_failed_rate_te",
    "satmode_fail_rate_te",
    "sat_n_obs_log",
]


class SatelliteTargetEncoder:
    """
    Smoothed satellite outcome history learned from training stations only.

    Emits the satellite's failure rate, its 'bad' (no signal) and 'failed'
    (station produced nothing) rates separately, the satellite x transmitter
    mode failure rate, and log(1 + n observations).
    """

    def __init__(self, smoothing: float = 10.0):
        self.smoothing = smoothing
        self.priors_: Dict[str, float] = {}
        self.tables_: Dict[str, pd.DataFrame] = {}

    @staticmethod
    def _keys(X: pd.DataFrame) -> Dict[str, pd.Series]:
        sat = X["satellite_norad_id"].astype(str)
        return {"sat": sat, "satmode": sat + "|" + X["transmitter_mode"].astype(str)}

    def fit(self, X: pd.DataFrame, y: np.ndarray, status: np.ndarray) -> "SatelliteTargetEncoder":
        targets = pd.DataFrame({
            "fail": y.astype(float),
            "bad": (status == "bad").astype(float),
            "failed": (status == "failed").astype(float),
        }, index=X.index)
        self.priors_ = targets.mean().to_dict()
        for name, key in self._keys(X).items():
            self.tables_[name] = targets.groupby(key.values).agg(["sum", "count"])
        return self

    def _rate(self, table: pd.DataFrame, keys: pd.Series, target: str) -> np.ndarray:
        s = keys.map(table[(target, "sum")]).fillna(0).to_numpy()
        n = keys.map(table[(target, "count")]).fillna(0).to_numpy()
        prior = self.priors_[target]
        denom = n + self.smoothing
        return np.where(denom > 0, (s + self.smoothing * prior) / np.maximum(denom, 1e-12), prior)

    def transform(self, X: pd.DataFrame) -> pd.DataFrame:
        k = self._keys(X)
        sat_t = self.tables_["sat"]
        return pd.DataFrame({
            "sat_fail_rate_te": self._rate(sat_t, k["sat"], "fail"),
            "sat_bad_rate_te": self._rate(sat_t, k["sat"], "bad"),
            "sat_failed_rate_te": self._rate(sat_t, k["sat"], "failed"),
            "satmode_fail_rate_te": self._rate(self.tables_["satmode"], k["satmode"], "fail"),
            "sat_n_obs_log": np.log1p(k["sat"].map(sat_t[("fail", "count")]).fillna(0).to_numpy()),
        }, index=X.index)


def add_satellite_encoding(
    X_train: pd.DataFrame,
    y_train: np.ndarray,
    status_train: np.ndarray,
    X_other: Sequence[pd.DataFrame],
    n_inner: int = 5,
    smoothing: float = 10.0,
) -> tuple[pd.DataFrame, List[pd.DataFrame], SatelliteTargetEncoder]:
    """Out-of-fold (by station) encoding for training rows; full-train encoding for the rest."""
    X_train = X_train.copy()
    enc_tr = pd.DataFrame(index=X_train.index, columns=SAT_TE_FEATURES, dtype=float)
    gkf = GroupKFold(n_splits=min(n_inner, X_train["station_id"].nunique()))
    for tr, va in gkf.split(X_train, y_train, X_train["station_id"]):
        enc = SatelliteTargetEncoder(smoothing).fit(X_train.iloc[tr], y_train[tr], status_train[tr])
        enc_tr.iloc[va] = enc.transform(X_train.iloc[va]).values
    X_train[SAT_TE_FEATURES] = enc_tr.values

    full = SatelliteTargetEncoder(smoothing).fit(X_train, y_train, status_train)
    others = []
    for X in X_other:
        X = X.copy()
        X[SAT_TE_FEATURES] = full.transform(X).values
        others.append(X)
    return X_train, others, full


@dataclass
class EnsembleConfig:
    numeric: List[str] = field(default_factory=lambda: list(NUMERIC_FEATURES))
    categorical: List[str] = field(default_factory=lambda: list(CATEGORICAL_FEATURES))
    catboost_iterations: int = 600
    catboost_depth: int = 5
    catboost_lr: float = 0.03
    lr_C: float = 0.3
    weight_catboost: float = 0.6
    seed: int = 42


class CalibratedEnsemble:
    """CatBoost + logistic regression, probability-averaged, isotonic-calibrated."""

    def __init__(self, config: Optional[EnsembleConfig] = None):
        self.config = config or EnsembleConfig()
        self.cb_: Optional[CatBoostClassifier] = None
        self.lr_: Optional[Pipeline] = None
        self.iso_: Optional[IsotonicRegression] = None
        self.medians_: Dict[str, float] = {}

    @property
    def features(self) -> List[str]:
        return self.config.numeric + self.config.categorical

    def _prep(self, X: pd.DataFrame) -> pd.DataFrame:
        X = X[self.features].copy()
        for c in self.config.numeric:
            X[c] = pd.to_numeric(X[c], errors="coerce").fillna(self.medians_.get(c, 0.0))
        for c in self.config.categorical:
            X[c] = X[c].astype(str)
        return X

    def fit(self, X: pd.DataFrame, y: np.ndarray) -> "CalibratedEnsemble":
        cfg = self.config
        self.medians_ = {c: float(pd.to_numeric(X[c], errors="coerce").median()) for c in cfg.numeric}
        Xp = self._prep(X)

        self.cb_ = CatBoostClassifier(
            iterations=cfg.catboost_iterations,
            depth=cfg.catboost_depth,
            learning_rate=cfg.catboost_lr,
            l2_leaf_reg=5.0,
            loss_function="Logloss",
            random_seed=cfg.seed,
            verbose=False,
            allow_writing_files=False,
            thread_count=-1,
        )
        self.cb_.fit(Xp, y, cat_features=cfg.categorical)

        spline_cols = [c for c in ("max_elevation_deg", "log_duration", "elevation_margin_deg") if c in cfg.numeric]
        linear_cols = [c for c in cfg.numeric if c not in spline_cols]
        self.lr_ = Pipeline([
            ("pre", ColumnTransformer([
                ("spl", Pipeline([("sc", StandardScaler()), ("sp", SplineTransformer(n_knots=5, degree=3))]), spline_cols),
                ("num", StandardScaler(), linear_cols),
                ("cat", OneHotEncoder(handle_unknown="ignore", min_frequency=10), cfg.categorical),
            ])),
            ("lr", LogisticRegression(C=cfg.lr_C, max_iter=5000)),
        ])
        self.lr_.fit(Xp, y)
        return self

    def raw_score(self, X: pd.DataFrame) -> np.ndarray:
        Xp = self._prep(X)
        w = self.config.weight_catboost
        return w * self.cb_.predict_proba(Xp)[:, 1] + (1 - w) * self.lr_.predict_proba(Xp)[:, 1]

    def calibrate(self, X_cal: pd.DataFrame, y_cal: np.ndarray) -> "CalibratedEnsemble":
        self.iso_ = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        self.iso_.fit(self.raw_score(X_cal), y_cal)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        s = self.raw_score(X)
        return self.iso_.predict(s) if self.iso_ is not None else s


class MondrianConformal:
    """
    Class-conditional split conformal on a scalar failure score p in [0, 1].

    Nonconformity: 1 - p for label fail, p for label ok. With n_c calibration
    points of class c, the label c is in the prediction set iff its score is
    <= the ceil((n_c + 1)(1 - alpha)) / n_c empirical quantile, giving
    P(y in C(x) | y = c) >= 1 - alpha for each class.
    """

    def __init__(self, alpha: float = 0.1):
        self.alpha = alpha
        self.fail_cal_: Optional[np.ndarray] = None
        self.ok_cal_: Optional[np.ndarray] = None

    @staticmethod
    def _quantile(scores: np.ndarray, alpha: float) -> float:
        n = len(scores)
        k = int(np.ceil((n + 1) * (1 - alpha)))
        if k > n:
            return np.inf
        return float(np.sort(scores)[k - 1])

    def fit(self, p_cal: np.ndarray, y_cal: np.ndarray) -> "MondrianConformal":
        self.fail_cal_ = 1.0 - p_cal[y_cal == 1]
        self.ok_cal_ = p_cal[y_cal == 0]
        return self

    def thresholds(self, alpha: Optional[Alpha] = None) -> tuple[float, float]:
        """
        Returns (fail_min, ok_max): fail in set iff p >= fail_min; ok in set iff p <= ok_max.

        `alpha` is a float or an (alpha_fail, alpha_ok) pair. alpha_ok = 0 keeps
        'ok' in every set, so the model never auto-calls FAIL (and vice versa).
        """
        a = self.alpha if alpha is None else alpha
        a_fail, a_ok = (a, a) if np.isscalar(a) else a
        return 1.0 - self._quantile(self.fail_cal_, a_fail), self._quantile(self.ok_cal_, a_ok)

    def decide(self, p: np.ndarray, alpha: Optional[Alpha] = None) -> np.ndarray:
        fail_min, ok_max = self.thresholds(alpha)
        has_fail = p >= fail_min
        has_ok = p <= ok_max
        out = np.full(len(p), ABSTAIN, dtype=object)
        out[has_fail & ~has_ok] = FAIL
        out[has_ok & ~has_fail] = OK
        return out


ALPHA_GRID = [0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.125, 0.15, 0.175, 0.2, 0.25]


def select_alpha_for_escalation(conf: MondrianConformal, p_cal: np.ndarray, target: float) -> float:
    """Alpha whose escalation rate on the calibration scores is closest to `target`."""
    esc = [np.mean(conf.decide(p_cal, a) == ABSTAIN) for a in ALPHA_GRID]
    return ALPHA_GRID[int(np.argmin(np.abs(np.array(esc) - target)))]


def select_alpha_for_precision(
    conf: MondrianConformal, p_cal: np.ndarray, y_cal: np.ndarray, target: float, min_calls: int = 10,
) -> tuple[float, float]:
    """
    (alpha_fail, alpha_ok) maximizing calibration coverage subject to every
    enabled side reaching `target` precision. A side whose calls cannot reach
    the target is disabled (alpha 0) and those passes escalate.
    """
    grid = [0.0] + ALPHA_GRID
    best, best_cov = (0.0, 0.0), 0.0
    for a_fail in grid:
        for a_ok in grid:
            m = decision_metrics(y_cal, conf.decide(p_cal, (a_fail, a_ok)))
            ok_fail = m["n_fail_calls"] == 0 or (m["n_fail_calls"] >= min_calls and m["precision_fail"] >= target)
            ok_ok = m["n_ok_calls"] == 0 or (m["n_ok_calls"] >= min_calls and m["precision_ok"] >= target)
            if ok_fail and ok_ok and m["coverage"] > best_cov:
                best, best_cov = (a_fail, a_ok), m["coverage"]
    return best


class AbstainingPassModel:
    """
    Cross-fitted ensemble + isotonic + Mondrian conformal, trained on passes.

    The training stations are split into `n_inner` station groups. One
    CalibratedEnsemble is fit per held-out group, giving out-of-fold scores for
    every training pass; isotonic calibration and conformal thresholds are fit
    on those OOF scores. New passes are scored with the mean of the fold models.
    """

    def __init__(
        self,
        config: Optional[EnsembleConfig] = None,
        n_inner: int = 4,
        sat_smoothing: float = 5.0,
        escalation_target: float = 0.15,
        precision_targets: Sequence[float] = (0.98, 0.95, 0.90, 0.85),
    ):
        self.config = config or EnsembleConfig()
        self.n_inner = n_inner
        self.sat_smoothing = sat_smoothing
        self.escalation_target = escalation_target
        self.precision_targets = tuple(precision_targets)
        self.models_: List[CalibratedEnsemble] = []
        self.sat_encoder_: Optional[SatelliteTargetEncoder] = None
        self.iso_: Optional[IsotonicRegression] = None
        self.conformal_: Optional[MondrianConformal] = None
        self.alphas_: Dict[str, Alpha] = {}
        self.oof_score_: Optional[np.ndarray] = None

    def fit(self, X: pd.DataFrame, y: np.ndarray, status: np.ndarray) -> "AbstainingPassModel":
        X, _, self.sat_encoder_ = add_satellite_encoding(X, y, status, [], smoothing=self.sat_smoothing)
        oof = np.zeros(len(y))
        self.models_ = []
        for fi, ci in GroupKFold(self.n_inner).split(X, y, X["station_id"]):
            m = CalibratedEnsemble(self.config).fit(X.iloc[fi], y[fi])
            oof[ci] = m.raw_score(X.iloc[ci])
            self.models_.append(m)
        self.oof_score_ = oof
        self.iso_ = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(oof, y)
        self.conformal_ = MondrianConformal().fit(oof, y)
        self.alphas_ = {"demo": select_alpha_for_escalation(self.conformal_, oof, self.escalation_target)}
        for t in self.precision_targets:
            self.alphas_[f"precision_{t:.2f}"] = select_alpha_for_precision(self.conformal_, oof, y, t)
        return self

    def _encode(self, X: pd.DataFrame) -> pd.DataFrame:
        X = X.copy()
        X[SAT_TE_FEATURES] = self.sat_encoder_.transform(X).values
        return X

    def raw_score(self, X: pd.DataFrame) -> np.ndarray:
        Xe = self._encode(X)
        return np.mean([m.raw_score(Xe) for m in self.models_], axis=0)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        return self.iso_.predict(self.raw_score(X))

    def predict(self, X: pd.DataFrame, policy: str = "demo", alpha: Optional[Alpha] = None) -> pd.DataFrame:
        a = alpha if alpha is not None else self.alphas_[policy]
        s = self.raw_score(X)
        fail_min, ok_max = self.conformal_.thresholds(a)
        return pd.DataFrame({
            "failure_probability": self.iso_.predict(s),
            "score": s,
            "decision": self.conformal_.decide(s, a),
            "fail_in_set": s >= fail_min,
            "ok_in_set": s <= ok_max,
            "alpha": a,
        }, index=X.index)


def complete_sampling_window(df: pd.DataFrame) -> np.ndarray:
    """
    Mask of passes inside the time window where every status class was sampled.

    The labeled fetch pulls the newest N passes per status (good/bad/failed), so
    each class covers a different time span; outside the overlap the class mix is
    an artifact of collection order. Inside it the sample is unbiased.
    """
    t = pd.to_datetime(df["start_time"], utc=True)
    spans = t.groupby(df["status"].values).agg(["min", "max"])
    return ((t >= spans["min"].max()) & (t <= spans["max"].min())).to_numpy()


def decision_metrics(y: np.ndarray, decisions: np.ndarray) -> Dict[str, float]:
    """Metrics on auto-decided passes; positive class = FAIL."""
    auto = decisions != ABSTAIN
    pred_fail = decisions == FAIL
    pred_ok = decisions == OK
    tp = int(np.sum(pred_fail & (y == 1)))
    fp = int(np.sum(pred_fail & (y == 0)))
    tn = int(np.sum(pred_ok & (y == 0)))
    fn = int(np.sum(pred_ok & (y == 1)))
    n_auto = int(auto.sum())
    safe = lambda a, b: float(a / b) if b else float("nan")
    return {
        "n": int(len(y)),
        "n_auto": n_auto,
        "n_escalated": int(len(y) - n_auto),
        "coverage": safe(n_auto, len(y)),
        "escalation_rate": safe(len(y) - n_auto, len(y)),
        "precision_fail": safe(tp, tp + fp),
        "precision_ok": safe(tn, tn + fn),
        "recall_fail_auto": safe(tp, tp + fn),
        "recall_fail_overall": safe(tp, int(np.sum(y == 1))),
        "accuracy_auto": safe(tp + tn, n_auto),
        "n_fail_calls": tp + fp,
        "n_ok_calls": tn + fn,
        "confusion_auto": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
        "escalated_fail_rate": safe(int(np.sum(~auto & (y == 1))), len(y) - n_auto),
    }
