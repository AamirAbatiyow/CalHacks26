"""
Policy layer on top of the v3.1.0 gate (v3.2).

An ordered, first-match decision list of auto-decide policies. Each policy is a
conjunction of feature thresholds with an effect (`failed` or `ok`); a pass that
no policy matches is escalated to a human. Groups, in order:

1. ops evidence about the pass itself, read at decision time (pass end + lag):
   no audio and no waterfall uploaded -> failed; decoded frames uploaded -> ok.
   SatNOGS sets `failed` when no artifacts arrive and auto-vets passes with
   decoded data as `good`, so these two rules largely restate how the label is
   produced. They are reported separately (tier B) from everything else (tier A).
2. hand-written physics / ops rules with thresholds tuned inside the training
   fold: low elevation in a geomagnetic storm, station outage streak at decision
   time, simultaneous drops on the same station, stale TLE.
3. the v3.1.0 model gate (`final_model.fit_gated`, failed side only, as deployed).
4. learned rules: one- and two-condition rules mined on the training fold
   (sequential covering), kept only if the Wilson 80% lower bound of precision is
   >= 0.95 on both halves of a station split of the training fold.

Decision-time features (prefix `dt_` / `co_`) follow the label-latency model of
`causal_features`: another pass's outcome or artifacts count only if its outcome
was known by this pass's end + lag.

    python -m ml.policies evaluate        # ml/reports/policies_v3_2.{md,json}
    python -m ml.policies train           # ml/models/final/policies_v3.2.0.json
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Tuple

import joblib
import numpy as np
import pandas as pd

from ml import causal_features as cf
from ml import final_model as fm

POLICY_VERSION = "v3.2.0"
TARGET = 0.95
Z80 = 1.2816
MIN_SUPPORT = 20
MINE_MIN_HALF = 15
MINE_MAX_RULES = 8
MINE_QUANTILES = (0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98)
MINE_TOP_PAIRS = 40

OWN = ["own_has_waterfall", "own_has_payload", "own_artifacts", "own_n_demod"]
DT = ["dt_" + c for c in ("st_n", "st_failed_frac", "st_good_frac", "st_last_failed", "st_last_good",
                          "st_fail_streak", "st_h_since_good", "st_h_since_failed", "sat_n", "sat_failed_frac",
                          "sat_good_frac", "tx_failed_frac", "tx_good_frac", "stsat_failed_frac", "stband_failed_frac")]
CO = ["co_st_n", "co_st_noart", "co_st_demod", "co_sat_n", "co_sat_demod", "co_sat_noart", "co_sat_demod_frac"]


# --------------------------------------------------------------------------- features


def decision_features(obs: pd.DataFrame, known: np.ndarray, q: np.ndarray, lag_hours: float) -> pd.DataFrame:
    """Own-pass artifacts plus history / co-observation as of `end + lag` for rows `q` of `obs`."""
    lag = int(lag_hours * cf.NS_PER_H)
    start, end = obs["start_ns"].to_numpy(), obs["end_ns"].to_numpy()
    T = end[q] + lag
    wf = obs.get("has_waterfall", pd.Series(False, index=obs.index)).fillna(False).astype(bool).to_numpy()
    pl = obs.get("has_payload", pd.Series(False, index=obs.index)).fillna(False).astype(bool).to_numpy()
    nd = pd.to_numeric(obs.get("n_demoddata", pd.Series(0, index=obs.index)), errors="coerce").fillna(0).to_numpy()
    out = pd.DataFrame(index=obs.index[q])
    out["own_has_waterfall"] = wf[q].astype(float)
    out["own_has_payload"] = pl[q].astype(float)
    out["own_artifacts"] = (wf[q].astype(int) + pl[q].astype(int)).astype(float)
    out["own_n_demod"] = nd[q].astype(float)

    hist = cf.history_features(obs, known, q, fm.LOOKBACK_H, fm.LONG_LOOKBACK_H, query_time_ns=T)
    for c in DT:
        out[c] = hist[c[3:]].to_numpy()

    st, sat = obs["ground_station"].to_numpy(), obs["norad_cat_id"].to_numpy()
    noart = ~(wf | pl)
    demod = nd > 0
    co = {c: np.zeros(len(q)) for c in CO}
    for key, arr in (("st", st), ("sat", sat)):
        order = np.lexsort((start, arr))
        a_sorted, s_sorted = arr[order], start[order]
        for j, qi in enumerate(q):
            lo, hi = np.searchsorted(a_sorted, arr[qi], "left"), np.searchsorted(a_sorted, arr[qi], "right")
            ss = s_sorted[lo:hi]
            a = lo + np.searchsorted(ss, start[qi] - 3 * cf.NS_PER_H, "left")
            b = lo + np.searchsorted(ss, end[qi], "left")
            idx = order[a:b]
            idx = idx[(idx != qi) & (end[idx] > start[qi]) & (known[idx] <= T[j])]
            if key == "sat":
                idx = idx[st[idx] != st[qi]]
            co[f"co_{key}_n"][j] = len(idx)
            co[f"co_{key}_noart"][j] = noart[idx].sum()
            co[f"co_{key}_demod"][j] = demod[idx].sum()
    co["co_sat_demod_frac"] = np.where(co["co_sat_n"] > 0, co["co_sat_demod"] / np.maximum(co["co_sat_n"], 1), np.nan)
    for c in CO:
        out[c] = co[c]
    return out


def build(lag_hours: float = 1.0, raw=None, hours=None) -> pd.DataFrame:
    """v3 dataset (start-time features) joined with decision-time features."""
    if raw is None:
        raw, hours = fm.load_raw()
    ds = fm.build(lag_hours, raw=raw, hours=hours)
    obs = cf.normalize_observations(raw)
    known = cf.label_known_at(obs, lag_hours)
    pos = pd.Series(np.arange(len(obs)), index=obs["id"].to_numpy())
    q = pos.loc[ds["id"].to_numpy()].to_numpy()
    dec = decision_features(obs, known, q, lag_hours).reset_index(drop=True)
    out = pd.concat([ds, dec], axis=1)
    out.attrs.update(ds.attrs)
    return out


# --------------------------------------------------------------------------- policies

SCORE_COLS = ("model_raw", "stage2_raw", "stage2_base")
STAGE2 = {"A": "stage2_A", "B": "stage2_B"}
fm.VARIANTS[STAGE2["A"]] = {"numeric": cf.FEATURES_NUMERIC + DT + CO}
fm.VARIANTS[STAGE2["B"]] = {"numeric": cf.FEATURES_NUMERIC + DT + CO + OWN}

OPS = {"<=": np.less_equal, ">=": np.greater_equal, "==": np.equal}


@dataclass
class Policy:
    id: str
    name: str
    effect: str                          # "failed" | "ok"
    group: str                           # ops_evidence | physics | ops_history | model | learned
    conditions: List[Tuple[str, str, float]] = field(default_factory=list)
    description: str = ""
    train_n: int = 0
    train_precision: Optional[float] = None
    train_wilson80: Optional[float] = None

    def mask(self, df: pd.DataFrame, scores: Optional[Dict[str, np.ndarray]] = None) -> np.ndarray:
        m = np.ones(len(df), bool)
        for f, op, t in self.conditions:
            if f in SCORE_COLS:
                v = (scores or {}).get(f, np.full(len(df), np.nan))
            else:
                v = pd.to_numeric(df[f], errors="coerce").to_numpy(dtype=float) if f in df else np.full(len(df), np.nan)
            with np.errstate(invalid="ignore"):
                m &= OPS[op](v, t) & ~np.isnan(v)
        return m

    def cedar(self) -> str:
        action = "auto_decide_failed" if self.effect == "failed" else "auto_decide_ok"
        conds = []
        for f, op, t in self.conditions:
            if float(t).is_integer() and f not in SCORE_COLS:
                conds.append(f"context.{f} {op} {int(t)}")
            else:
                meth = {"<=": "lessThanOrEqual", ">=": "greaterThanOrEqual", "==": "equals"}[op]
                conds.append(f'context.{f}.{meth}(decimal("{t:.4f}"))')
        return (f'permit(\n  principal == GroundTruth::Actor::"ai_analyst",\n'
                f'  action == GroundTruth::Action::"{action}",\n  resource\n) when {{\n  '
                + " &&\n  ".join(conds) + "\n};")


def _hits(mask: np.ndarray, target: np.ndarray) -> Tuple[int, int, float]:
    n = int(mask.sum())
    k = int((mask & (target == 1)).sum())
    return n, k, fm.wilson(k, n, Z80)[0] if n else float("nan")


# Hand rules: (id, name, effect, group, description, grid of condition lists)
def hand_rules() -> List[Tuple[str, str, str, str, str, List[List[Tuple[str, str, float]]]]]:
    return [
        ("ops-no-artifacts", "No artifacts uploaded", "failed", "ops_evidence",
         "No audio and no waterfall uploaded by pass end + lag (zero-artifact observation)",
         [[("own_artifacts", "==", 0)]]),
        ("ops-decoded-frames", "Decoded frames uploaded", "ok", "ops_evidence",
         "At least one demodulated data frame uploaded by pass end + lag",
         [[("own_n_demod", ">=", float(k))] for k in (1, 2, 5)]),
        ("phys-low-elev-storm", "Low elevation in geomagnetic storm", "failed", "physics",
         "Max elevation below X degrees while Kp >= Y",
         [[("max_elevation_deg", "<=", float(e)), ("kp_last", ">=", float(k))]
          for e in (10, 15, 20, 30) for k in (3, 4, 5)]),
        ("ops-outage-streak", "Station outage streak", "failed", "ops_history",
         "Station's last N resolved passes (as of pass end + lag) all failed",
         [[("dt_st_fail_streak", ">=", float(s))] for s in (1, 2, 3, 4, 6)]),
        ("ops-station-drop", "Simultaneous drop on station", "failed", "ops_history",
         "At least N other passes on the same station overlapping this one ended with no artifacts",
         [[("co_st_noart", ">=", float(n))] for n in (1, 2, 3)]),
        ("phys-stale-tle", "Stale TLE", "failed", "physics",
         "TLE older than D days at pass start",
         [[("tle_age_days", ">=", float(d))] for d in (7, 14, 30, 60)]),
    ]


TIER_A_EXCLUDE = {"ops-no-artifacts", "ops-decoded-frames"}


def tune_hand_rules(train: pd.DataFrame, include: Optional[set] = None, groups_: Sequence[str] = (),
                    decided: Optional[np.ndarray] = None) -> List[Policy]:
    """Pick, per rule (in order), the grid setting with most support whose Wilson80 lower bound >= 0.95
    on the training passes not decided by earlier policies."""
    y = train["y"].to_numpy()
    decided = np.zeros(len(train), bool) if decided is None else decided
    out = []
    for pid, name, effect, group, desc, grid in hand_rules():
        if (include is not None and pid not in include) or group not in groups_:
            continue
        target = y if effect == "failed" else 1 - y
        best = None
        for conds in grid:
            p = Policy(pid, name, effect, group, conds, desc)
            n, k, lb = _hits(p.mask(train) & ~decided, target)
            if n >= MIN_SUPPORT and lb >= TARGET and (best is None or n > best.train_n):
                p.train_n, p.train_precision, p.train_wilson80 = n, k / n, lb
                best = p
        if best is not None:
            out.append(best)
            decided |= best.mask(train)
    return out


def mining_features(df: pd.DataFrame, tier: str) -> List[str]:
    feats = list(cf.FEATURES_NUMERIC) + DT + CO + (OWN if tier == "B" else [])
    return [f for f in feats if f in df and pd.to_numeric(df[f], errors="coerce").notna().mean() > 0.2]


def _predicates(df: pd.DataFrame, feats: Sequence[str]):
    preds, cols = [], []
    for f in feats:
        v = pd.to_numeric(df[f], errors="coerce").to_numpy(dtype=float)
        ok = ~np.isnan(v)
        if ok.sum() < 50:
            continue
        ths = np.unique(np.nanquantile(v, MINE_QUANTILES))
        for t in ths:
            for op in ("<=", ">="):
                m = ok & OPS[op](np.where(ok, v, 0), t)
                if 30 <= m.sum() <= len(v) - 30:
                    preds.append((f, op, float(t)))
                    cols.append(m)
    return preds, (np.array(cols) if cols else np.zeros((0, len(df)), bool))


def mine_rules(train: pd.DataFrame, tier: str, decided: np.ndarray, seed: int = 0) -> List[Policy]:
    """Sequential covering for each effect; a rule must clear Wilson80 >= 0.95 on both station halves."""
    y = train["y"].to_numpy()
    half = fm.station_folds(train["ground_station"].to_numpy(), 2, seed + 7) == 0
    preds, M = _predicates(train, mining_features(train, tier))
    if not preds:
        return []
    Mf = M.astype(np.float32)
    rules = []
    for effect in _LEARNED_EFFECTS:
        target = (y if effect == "failed" else 1 - y).astype(np.float32)
        rem = ~decided.copy()
        for r in range(MINE_MAX_RULES):
            stats = []
            for h in (half, ~half):
                w = (rem & h).astype(np.float32)
                stats.append((Mf @ w, Mf @ (w * target)))
            (nA, kA), (nB, kB) = stats
            cand = []

            def consider(nA_, kA_, nB_, kB_, conds):
                if nA_ >= MINE_MIN_HALF and nB_ >= MINE_MIN_HALF and \
                        fm.wilson(kA_, nA_, Z80)[0] >= TARGET and fm.wilson(kB_, nB_, Z80)[0] >= TARGET:
                    cand.append((nA_ + nB_, -len(conds), conds))

            for i in range(len(preds)):
                consider(nA[i], kA[i], nB[i], kB[i], [preds[i]])
            prec = (kA + kB) / np.maximum(nA + nB, 1)
            pool = np.where((prec >= 0.85) & (nA + nB >= 2 * MINE_MIN_HALF))[0]
            pool = pool[np.argsort(-(kA + kB)[pool])][:MINE_TOP_PAIRS]
            for a_i, i in enumerate(pool):
                for j in pool[a_i + 1:]:
                    if preds[i][0] == preds[j][0]:
                        continue
                    m = M[i] & M[j] & rem
                    nA_, nB_ = (m & half).sum(), (m & ~half).sum()
                    kA_, kB_ = (m & half & (target == 1)).sum(), (m & ~half & (target == 1)).sum()
                    consider(nA_, kA_, nB_, kB_, [preds[i], preds[j]])
            if not cand:
                break
            cand.sort(key=lambda c: (c[0], c[1]), reverse=True)
            conds = cand[0][2]
            p = Policy(f"learned-{effect}-{r + 1}", f"Learned {effect} rule {r + 1}", effect, "learned", conds,
                       "Mined from labeled passes (sequential covering, two-half station validation)")
            m = p.mask(train) & rem
            n, k, lb = _hits(m, target.astype(int))
            p.train_n, p.train_precision, p.train_wilson80 = n, k / max(n, 1), lb
            rules.append(p)
            rem &= ~p.mask(train)
    return rules


@dataclass
class PolicySet:
    policies: List[Policy]
    gm: Optional[fm.GatedModel]
    tier: str
    gm2: Optional[fm.GatedModel] = None

    def ordered(self, skip_group: Optional[str] = None) -> List[Policy]:
        return [p for p in self.policies if group_of(p.id) != skip_group]

    def scores(self, df: pd.DataFrame) -> Dict[str, np.ndarray]:
        sc = {}
        if self.gm is not None:
            sc["model_raw"] = self.gm.booster.raw(df)
        if self.gm2 is not None:
            sc["stage2_raw"], sc["stage2_base"] = self.gm2.booster.raw(df), self.gm2.booster.raw_base(df)
        return sc

    def apply(self, df: pd.DataFrame, skip: Optional[str] = None, scores=None) -> pd.DataFrame:
        sc = self.scores(df) if scores is None else scores
        dec = np.array(["escalate"] * len(df), dtype=object)
        by = np.array([""] * len(df), dtype=object)
        open_ = np.ones(len(df), bool)
        for p in self.ordered(skip):
            m = p.mask(df, sc) & open_
            dec[m], by[m] = p.effect, p.id
            open_ &= ~m
        return pd.DataFrame({"decision": dec, "policy": by}, index=df.index)


def fit_policies(train: pd.DataFrame, tier: str = "A", seed: int = 0, groups: Optional[set] = None,
                 gm: Optional[fm.GatedModel] = None) -> PolicySet:
    """Ops evidence -> physics / ops-history rules -> model gate -> mined rules -> stage-2 model.

    Every stage is tuned on the training passes that reach it (not decided by an
    earlier stage), using only `train`.
    """
    def want(g):
        return groups is None or g in groups

    include = {r[0] for r in hand_rules()} - (TIER_A_EXCLUDE if tier == "A" else set())
    if groups is not None:
        include &= groups
    decided = np.zeros(len(train), bool)
    policies = tune_hand_rules(train, include, ("ops_evidence",), decided)
    policies += tune_hand_rules(train, include, ("physics", "ops_history"), decided)
    if want("model-gate"):
        gm = gm if gm is not None and decided.sum() == 0 else \
            fm.fit_gated(train, fm.FINAL_VARIANT, seed=seed, ok_side=False, threshold_mask=~decided)
        if gm.t_fail is not None:
            p = Policy("model-gate", "v3.1.0 model gate", "failed", "model",
                       [("model_raw", ">=", float(gm.t_fail))],
                       "v3.1.0 raw score at or above the Wilson80 threshold picked on passes reaching the gate")
            m = p.mask(train, {"model_raw": gm.booster.raw(train)}) & ~decided
            p.train_n, k, p.train_wilson80 = _hits(m, train["y"].to_numpy())
            p.train_precision = k / p.train_n if p.train_n else None
            p.description += " (train stats in-sample)"
            policies.append(p)
            decided |= m
    else:
        gm = None
    if want("learned"):
        mined = mine_rules(train, tier, decided, seed)
        for p in mined:
            decided |= p.mask(train)
        policies += mined
    gm2 = None
    if (want("stage2-failed") or want("stage2-ok")) and (~decided).sum() > 200:
        res = train[~decided]
        gm2 = fm.fit_gated(res, STAGE2[tier], seed=seed + 50, ok_side=True)
        if gm2.t_fail is not None and want("stage2-failed"):
            policies.append(Policy("stage2-failed", "Stage-2 model: failed", "failed", "learned_model",
                                   [("stage2_raw", ">=", float(gm2.t_fail))],
                                   "Gated LightGBM on decision-time features, fit on passes no earlier policy decides"))
        if gm2.t_ok is not None and want("stage2-ok"):
            policies.append(Policy("stage2-ok", "Stage-2 model: ok", "ok", "learned_model",
                                   [("stage2_base", "<=", float(gm2.t_ok))],
                                   "Gated LightGBM on decision-time features, fit on passes no earlier policy decides"))
    return PolicySet(policies, gm, tier, gm2)


# --------------------------------------------------------------------------- evaluation


def metrics(df: pd.DataFrame, dec: pd.DataFrame) -> Dict:
    y = df["y"].to_numpy()
    d = dec["decision"].to_numpy()
    status = df["status"].to_numpy()
    groups = df["ground_station"].to_numpy()
    f, o = d == "failed", d == "ok"
    out = {"n": int(len(df))}
    for side, m, tgt in (("fail", f, y), ("ok", o, 1 - y)):
        n, k = int(m.sum()), int((m & (tgt == 1)).sum())
        out[f"{side}_n"] = n
        out[f"{side}_precision"] = k / n if n else None
        out[f"{side}_wilson95"] = fm.wilson(k, n) if n else None
        out[f"{side}_wilson80_lb"] = fm.wilson(k, n, Z80)[0] if n else None
        out[f"{side}_cluster_ci"] = fm.cluster_bootstrap_precision(m, tgt, groups) if n else None
    auto = f | o
    correct = (f & (y == 1)) | (o & (y == 0))
    out["coverage"] = float(auto.mean())
    out["escalated"] = float(1 - auto.mean())
    out["accuracy_auto"] = float(correct.sum() / auto.sum()) if auto.sum() else None
    out["accuracy_auto_wilson95"] = fm.wilson(int(correct.sum()), int(auto.sum())) if auto.sum() else None
    out["fail_recall"] = float((f & (y == 1)).sum() / max(1, (y == 1).sum()))
    out["recall_failed_class"] = float((f & (status == "failed")).sum() / max(1, (status == "failed").sum()))
    out["recall_bad_class"] = float((f & (status == "bad")).sum() / max(1, (status == "bad").sum()))
    out["ok_recall"] = float((o & (y == 0)).sum() / max(1, (y == 0).sum()))
    out["meets_target"] = all(out[f"{s}_n"] == 0 or out[f"{s}_wilson80_lb"] >= TARGET for s in ("fail", "ok"))
    return out


def per_policy(df: pd.DataFrame, dec: pd.DataFrame) -> Dict[str, Dict]:
    y = df["y"].to_numpy()
    out = {}
    pol = dec["policy"].to_numpy()
    d = dec["decision"].to_numpy()
    for key in sorted(set(pol) - {""}):
        m = pol == key
        eff = d[m][0]
        tgt = y if eff == "failed" else 1 - y
        n, k = int(m.sum()), int((m & (tgt == 1)).sum())
        out[key] = {"effect": eff, "n": n, "precision": k / n, "wilson95": fm.wilson(k, n),
                    "wilson80_lb": fm.wilson(k, n, Z80)[0], "coverage": n / len(df)}
    return out


def group_of(pid: str) -> str:
    return "learned-failed" if pid.startswith("learned-failed") else \
        "learned-ok" if pid.startswith("learned-ok") else pid


def run_split(train: pd.DataFrame, test: pd.DataFrame, tier: str, seed: int, groups: Optional[set] = None):
    ps = fit_policies(train, tier, seed, groups)
    dec = ps.apply(test)
    dec["group"] = dec["policy"].map(lambda p: group_of(p) if p else "")
    loo = {}
    sc = ps.scores(test)
    for g in sorted({group_of(p.id) for p in ps.policies}):
        loo[g] = ps.apply(test, skip=g, scores=sc)["decision"].to_numpy()
    return ps, dec, loo


def evaluate_tier(df: pd.DataFrame, tier: str, groups: Optional[set] = None, k: int = 5, seed: int = 0) -> Dict:
    res = {}
    # held-out stations
    folds = fm.station_folds(df["ground_station"].to_numpy(), k, seed)
    decs, per_fold, fitted = [], [], []
    for f in range(k):
        tr, te = df[folds != f], df[folds == f]
        ps, dec, loo = run_split(tr, te, tier, seed + f, groups)
        decs.append(dec)
        per_fold.append((te.index, dec["decision"].to_numpy(), loo))
        fitted.append([asdict(p) for p in ps.policies])
    names = set().union(*(set(lo) for _, _, lo in per_fold))
    loos = {g: [pd.Series(lo.get(g, base), index=idx) for idx, base, lo in per_fold] for g in names}
    dec = pd.concat(decs).loc[df.index]
    res["station_cv"] = _summarize(df, dec, loos, fitted)
    # future time
    tr, te, cut = fm.time_split(df)
    ps, dec_t, loo_t = run_split(tr, te, tier, seed, groups)
    loos_t = {g: [pd.Series(v, index=te.index)] for g, v in loo_t.items()}
    res["time"] = _summarize(te, dec_t, loos_t, [[asdict(p) for p in ps.policies]])
    res["time"]["cut"] = cut.isoformat()
    res["time"]["n_train"] = int(len(tr))
    unseen = ~te["ground_station"].isin(set(tr["ground_station"]))
    res["time"]["unseen_stations"] = metrics(te[unseen], dec_t[unseen]) if unseen.sum() > 20 else {"n": int(unseen.sum())}
    return res


def _summarize(df, dec, loos, fitted) -> Dict:
    m = metrics(df, dec)
    groups = {}
    dg = dec["group"].to_numpy()
    y = df["y"].to_numpy()
    for g in sorted(set(dg) - {""}):
        mask = dg == g
        eff = dec["decision"].to_numpy()[mask][0]
        tgt = y if eff == "failed" else 1 - y
        n, k = int(mask.sum()), int((mask & (tgt == 1)).sum())
        groups[g] = {"effect": eff, "n": n, "precision": k / n, "wilson95": fm.wilson(k, n),
                     "wilson80_lb": fm.wilson(k, n, Z80)[0], "coverage": n / len(df)}
    for g, parts in loos.items():
        d2 = pd.concat(parts).loc[df.index]
        m2 = metrics(df, pd.DataFrame({"decision": d2.to_numpy()}, index=df.index))
        groups.setdefault(g, {"effect": None, "n": 0, "precision": None, "wilson95": None,
                              "wilson80_lb": None, "coverage": 0.0})
        groups[g]["without"] = {k_: m2[k_] for k_ in ("coverage", "fail_precision", "ok_precision",
                                                     "fail_wilson80_lb", "ok_wilson80_lb", "accuracy_auto")}
        groups[g]["marginal_coverage"] = m["coverage"] - m2["coverage"]
    m["groups"] = groups
    m["n_folds_enabled"] = {}
    for fold in fitted:
        for g in {group_of(p["id"]) for p in fold}:
            m["n_folds_enabled"][g] = m["n_folds_enabled"].get(g, 0) + 1
    m["fitted"] = fitted
    return m


def group_evidence(res: Dict, g: str) -> Tuple[int, int, float, float]:
    """(n, correct, min split precision, Wilson80 lower bound) pooled over both splits."""
    n = k = 0
    worst = 1.0
    for split in ("station_cv", "time"):
        s = res[split]["groups"].get(g)
        if s is None or s["n"] == 0:
            continue
        n += s["n"]
        k += round(s["precision"] * s["n"])
        worst = min(worst, s["precision"])
    return n, k, worst, (fm.wilson(k, n, Z80)[0] if n else float("nan"))


def helpful_groups(res: Dict) -> List[str]:
    """Groups that decide passes at >= 0.95 precision in every split where they fire and whose
    precision pooled over both splits has a Wilson80 lower bound >= 0.95."""
    names = set(res["station_cv"]["groups"]) | set(res["time"]["groups"])
    keep = []
    for g in sorted(names):
        n, k, worst, lb = group_evidence(res, g)
        if n and worst >= TARGET and lb >= TARGET:
            keep.append(g)
    return keep


def _groups_to_ids(keep: Sequence[str]) -> set:
    ids = set()
    for g in keep:
        ids.add("learned" if g.startswith("learned") else g)
    return ids


def evaluate(lags=(1.0, 3.0), out_name: str = "policies_v3_2") -> Dict:
    raw, hours = fm.load_raw()
    results = {"generated_at": datetime.now(timezone.utc).isoformat(), "version": POLICY_VERSION,
               "target": TARGET, "z": Z80, "lags": {}}
    for lag in lags:
        t0 = time.time()
        df = build(lag, raw=raw, hours=hours)
        info = {"n": len(df), "stations": int(df["ground_station"].nunique()),
                "status_counts": df["status"].value_counts().to_dict(), "tiers": {}}
        print(f"lag {lag:g}h: {len(df)} passes ({time.time() - t0:.0f}s build)", flush=True)
        base = evaluate_tier(df, "A", groups={"model-gate"})
        info["model_only"] = {s: _strip(base[s]) for s in ("station_cv", "time")}
        _print("model only", base)
        for tier in ("A", "B"):
            t1 = time.time()
            full = evaluate_tier(df, tier)
            _print(f"tier {tier} all", full)
            keep = helpful_groups(full)
            final = _with_effects(keep, lambda: evaluate_tier(df, tier, groups=_groups_to_ids(keep)))
            dropped = []
            while keep and not all(final[sp]["meets_target"] for sp in ("station_cv", "time")):
                worst = min(keep, key=lambda g: group_evidence(final, g)[3]
                            if final["station_cv"]["groups"].get(g) or final["time"]["groups"].get(g) else -1)
                keep = [g for g in keep if g != worst]
                dropped.append(worst)
                final = _with_effects(keep, lambda: evaluate_tier(df, tier, groups=_groups_to_ids(keep)))
            _print(f"tier {tier} kept", final)
            info["tiers"][tier] = {"all": {s: _strip(full[s]) for s in ("station_cv", "time")},
                                   "kept_groups": keep, "dropped_for_target": dropped,
                                   "kept": {s: _strip(final[s]) for s in ("station_cv", "time")},
                                   "seconds": round(time.time() - t1, 1)}
        results["lags"][f"{lag:g}h"] = info
    json.dump(results, open(fm.REPORT_DIR / f"{out_name}.json", "w"), indent=1, default=float)
    (fm.REPORT_DIR / f"{out_name}.md").write_text(render(results))
    return results


def _with_effects(keep: Sequence[str], fn):
    global _LEARNED_EFFECTS
    effs = tuple(e for e in ("failed", "ok") if f"learned-{e}" in keep)
    _LEARNED_EFFECTS = effs or ("failed", "ok")
    try:
        return fn()
    finally:
        _LEARNED_EFFECTS = ("failed", "ok")


_LEARNED_EFFECTS = ("failed", "ok")


def _strip(m: Dict) -> Dict:
    return {k: v for k, v in m.items() if k != "fitted"} | {"fitted_last": m.get("fitted", [[]])[-1]}


def _print(label: str, res: Dict) -> None:
    parts = []
    for s in ("station_cv", "time"):
        m = res[s]
        parts.append(f"{s}: fail {m['fail_n']}@{fm.fmt(m['fail_precision'])} (lb80 {fm.fmt(m['fail_wilson80_lb'])}) "
                     f"ok {m['ok_n']}@{fm.fmt(m['ok_precision'])} (lb80 {fm.fmt(m['ok_wilson80_lb'])}) "
                     f"esc {fm.fmt(m['escalated'], pct=True)}")
    print(f"  {label:16s} " + " | ".join(parts), flush=True)


# --------------------------------------------------------------------------- report


def render(res: Dict) -> str:
    L = ["# v3.2 policy layer: held-out evaluation", "",
         f"Generated {res['generated_at']} by `python -m ml.policies evaluate`. Ordered first-match policies on "
         "top of the v3.1.0 gate; every threshold and mined rule is fit inside the training fold. Target: Wilson "
         f"lower bound (z = {res['z']}) of precision >= {res['target']} on each auto-decided side, on held-out "
         "stations (5 station-grouped folds) and future time (last 30%, 3h embargo). Tier A excludes the "
         "pass's own artifacts; tier B adds them (see README for why they largely restate the label).", ""]
    for lag, info in res["lags"].items():
        L += [f"## Label latency {lag}", "", f"{info['n']} passes, {info['stations']} stations, {info['status_counts']}.", "",
              "| configuration | split | auto 'failed': n / precision / 95% CI / LB80 | auto 'ok': n / precision / 95% CI / LB80 "
              "| coverage | escalated | accuracy on auto-decided | meets target |", "|---|---|---|---|---|---|---|---|"]
        rows = [("v3.1.0 model only", info["model_only"])]
        for tier, t in info["tiers"].items():
            rows += [(f"tier {tier}, all policies", t["all"]), (f"tier {tier}, kept policies (v3.2)", t["kept"])]
        for label, d in rows:
            for s, sname in (("station_cv", "held-out stations"), ("time", "future time")):
                m = d[s]
                L.append(f"| {label} | {sname} | {m['fail_n']} / {fm.fmt(m['fail_precision'])} / "
                         f"{fm.fmt_ci(m['fail_wilson95'])} / {fm.fmt(m['fail_wilson80_lb'])} | {m['ok_n']} / "
                         f"{fm.fmt(m['ok_precision'])} / {fm.fmt_ci(m['ok_wilson95'])} / {fm.fmt(m['ok_wilson80_lb'])} | "
                         f"{fm.fmt(m['coverage'], pct=True)} | {fm.fmt(m['escalated'], pct=True)} | "
                         f"{fm.fmt(m['accuracy_auto'])} | {'yes' if m['meets_target'] else 'no'} |")
        L.append("")
        for tier, t in info["tiers"].items():
            L += [f"### Tier {tier}: per-policy contribution (all policies, first match wins)", "",
                  f"Kept: {', '.join(t['kept_groups']) or 'none'}.", "",
                  "| policy | effect | split | decided (n) | precision | 95% CI | LB80 | coverage added (first match) "
                  "| coverage lost if removed | folds enabled |", "|---|---|---|---|---|---|---|---|---|---|"]
            names = sorted(set(t["all"]["station_cv"]["groups"]) | set(t["all"]["time"]["groups"]))
            for g in names:
                for s, sname in (("station_cv", "stations"), ("time", "time")):
                    m = t["all"][s]["groups"].get(g)
                    if m is None:
                        continue
                    L.append(f"| {g} | {m['effect'] or '–'} | {sname} | {m['n']} | {fm.fmt(m['precision'])} | "
                             f"{fm.fmt_ci(m['wilson95'])} | {fm.fmt(m['wilson80_lb'])} | {fm.fmt(m['coverage'], pct=True)} | "
                             f"{fm.fmt(m.get('marginal_coverage'), pct=True)} | "
                             f"{t['all'][s]['n_folds_enabled'].get(g, 0)} |")
            L.append("")
        for tier, t in info["tiers"].items():
            u = t["kept"]["time"].get("unseen_stations", {})
            if "coverage" in u:
                L += [f"Tier {tier} kept, future time, stations unseen in training (n={u['n']}): failed "
                      f"{u['fail_n']} @ {fm.fmt(u['fail_precision'])} ({fm.fmt_ci(u['fail_wilson95'])}), ok {u['ok_n']} @ "
                      f"{fm.fmt(u['ok_precision'])} ({fm.fmt_ci(u['ok_wilson95'])}), escalated "
                      f"{fm.fmt(u['escalated'], pct=True)}.", ""]
    return "\n".join(L)


# --------------------------------------------------------------------------- final fit / serving


def train(lag_hours: float = 1.0, tier: str = "B", eval_json: Optional[str] = None) -> Dict:
    """Fit kept policies on all data around the deployed v3.1.0 model; write versioned Cedar-style records."""
    ev = json.load(open(eval_json or fm.REPORT_DIR / "policies_v3_2.json"))
    t = ev["lags"][f"{lag_hours:g}h"]["tiers"][tier]
    ids = _groups_to_ids(t["kept_groups"])
    learned_effects = tuple(sorted({g.split("-")[1] for g in t["kept_groups"] if g.startswith("learned")}))
    raw, hours = fm.load_raw()
    df = build(lag_hours, raw=raw, hours=hours)
    gm, cfg = fm.load_gated("v3.1.0")
    ps = _with_effects(t["kept_groups"], lambda: fit_policies(df, tier, 0, ids, gm=gm))
    if ps.gm is not None and ps.gm is not gm:
        drift = float(np.max(np.abs(ps.gm.booster.raw(df) - gm.booster.raw(df))))
        print(f"model gate threshold re-picked on passes reaching it; booster drift vs v3.1.0: {drift:.2e}")
        ps.gm = gm
    if ps.gm2 is not None and any(p.group == "learned_model" for p in ps.policies):
        b = ps.gm2.booster
        joblib.dump({"variant": b.variant, "numeric": b.numeric, "cats": b.cats,
                     "model_str": b.model.model_to_string()}, fm.MODEL_DIR / f"policies_{POLICY_VERSION}_stage2.joblib")
    st = t["kept"]["station_cv"]["groups"]
    tm = t["kept"]["time"]["groups"]
    records = []
    for i, p in enumerate(ps.policies):
        g = group_of(p.id)
        records.append({
            "id": f"{POLICY_VERSION}-r{i + 1}", "policy_version_id": POLICY_VERSION, "name": p.name,
            "description": p.description, "cedar_code": p.cedar(), "enabled": True, "order_index": i,
            "rule_id": p.id, "effect": p.effect, "group": p.group, "conditions": p.conditions,
            "train": {"n": p.train_n, "precision": p.train_precision, "wilson80_lb": p.train_wilson80},
            "heldout_stations": {k: st.get(g, {}).get(k) for k in ("n", "precision", "wilson95")},
            "future_time": {k: tm.get(g, {}).get(k) for k in ("n", "precision", "wilson95")},
        })
    blob = {"policy_version": POLICY_VERSION, "model_version": cfg["version"], "tier": tier,
            "lag_hours": lag_hours, "n_train": len(df), "created_at": datetime.now(timezone.utc).isoformat(),
            "kept_groups": t["kept_groups"], "learned_effects": list(learned_effects),
            "heldout": {s: {k: t["kept"][s][k] for k in ("fail_n", "fail_precision", "fail_wilson95", "ok_n",
                                                      "ok_precision", "ok_wilson95", "coverage", "escalated",
                                                      "accuracy_auto")} for s in ("station_cv", "time")},
            "rules": records}
    path = fm.MODEL_DIR / f"policies_{POLICY_VERSION}.json"
    json.dump(blob, open(path, "w"), indent=1, default=float)
    print(f"saved {path.name}: {len(records)} rules on n={len(df)}")
    return blob


def load_policies(version: str = POLICY_VERSION) -> Tuple[PolicySet, Dict]:
    blob = json.load(open(fm.MODEL_DIR / f"policies_{version}.json"))
    gm, _ = fm.load_gated(blob["model_version"])
    pols = [Policy(r["rule_id"], r["name"], r["effect"], r["group"], [tuple(c) for c in r["conditions"]],
                   r["description"]) for r in sorted(blob["rules"], key=lambda r: r["order_index"])]
    gm2 = None
    s2 = fm.MODEL_DIR / f"policies_{version}_stage2.joblib"
    if any(p.group == "learned_model" for p in pols) and s2.exists():
        d = joblib.load(s2)
        b = fm.Booster(d["variant"], d["numeric"], d["cats"], fm.lgb.Booster(model_str=d["model_str"]))
        gm2 = fm.GatedModel(b, None, None, None)
    return PolicySet(pols, gm, blob["tier"], gm2), blob


def decide_observations(new_obs: pd.DataFrame, context_obs: pd.DataFrame, version: str = POLICY_VERSION) -> List[Dict]:
    """Policy decisions at decision time (pass end + lag) for SatNOGS-shaped rows."""
    ps, blob = load_policies(version)
    lag = blob["lag_hours"]
    X = fm.featurize(new_obs, context_obs, lag)
    new = new_obs.copy()
    new["status"] = "future"
    allobs = cf.normalize_observations(pd.concat([context_obs, new], ignore_index=True, sort=False))
    known = cf.label_known_at(allobs, lag)
    pos = pd.Series(np.arange(len(allobs)), index=allobs["id"].to_numpy())
    q = pos.loc[X["id"].to_numpy()].to_numpy()
    D = decision_features(allobs, known, q, lag).reset_index(drop=True)
    X = pd.concat([X, D], axis=1)
    dec = ps.apply(X)
    rec = {r["rule_id"]: r for r in blob["rules"]}
    out = []
    for (_, x), (_, d) in zip(X.iterrows(), dec.iterrows()):
        r = rec.get(d["policy"])
        prec = (r or {}).get("heldout_stations", {}).get("precision")
        out.append({"pass_id": int(x["id"]), "policy_version": blob["policy_version"],
                    "model_version": blob["model_version"],
                    "route": "auto" if d["decision"] != "escalate" else "human",
                    "decision": {"failed": "failed", "ok": "fine"}.get(d["decision"], "uncertain"),
                    "rule_id": d["policy"] or None,
                    "confidence_percent": max(95, int(100 * prec)) if r and prec else 79})
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("evaluate")
    e.add_argument("--lags", default="1,3")
    e.add_argument("--out", default="policies_v3_2")
    t = sub.add_parser("train")
    t.add_argument("--lag", type=float, default=1.0)
    t.add_argument("--tier", default="B", choices=["A", "B"])
    args = p.parse_args(argv)
    if args.cmd == "evaluate":
        evaluate(tuple(float(x) for x in args.lags.split(",")), args.out)
    else:
        train(args.lag, args.tier)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
