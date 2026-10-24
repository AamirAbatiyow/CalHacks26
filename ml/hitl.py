"""
Human-in-the-loop learning for the v3 pass-failure gate.

Every pass the gate escalates gets a human ruling. That ruling is used twice:

1. as a labeled training example (features as they were at decision time);
2. as an *early label*: the pass's outcome becomes known at ruling time
   instead of when a SatNOGS vetter gets to it, so later passes at the same
   station / satellite see it in their causal history features.

Two refit paths, both measured by `simulate`:

* `full`: nested refit (inner station-grouped OOF -> isotonic + 0.95 Wilson
  threshold, then final booster). Thresholds stay honest; takes seconds.
* `warm`: continue boosting the current LightGBM on the new rulings plus an
  equal-size replay sample of older data (sub-second); calibration and
  thresholds are re-picked at the next full refit (every `full_every` warm steps).

System 1 worker entry point:

    from ml.hitl import ingest_labeled_decision
    out = ingest_labeled_decision(features, "failed", pass_id=123, reviewer="ops@...")
    out["model_version"]  # bumped when a refit happened, e.g. v3.0.0 -> v3.0.1

Simulation (replays escalations in time order with human labels):

    python -m ml.hitl simulate          # writes ml/reports/hitl_v3.{md,json,png}
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd

from . import causal_features as cf
from . import final_model as fm

LABELS_FILE = fm.MODEL_DIR / "human_labels.jsonl"
FULL_EVERY = 25          # full nested refit after this many rulings (warm refits in between)
WARM_TREES = 20


def _rows_to_frame(rows: Sequence[Dict]) -> pd.DataFrame:
    df = pd.DataFrame(list(rows))
    for c in cf.FEATURES_CATEGORICAL:
        if c not in df:
            df[c] = "unknown"
    return df


def label_to_y(label: str) -> int:
    label = label.lower()
    if label in ("failed", "bad", "fail", "1", "true"):
        return 1
    if label in ("good", "fine", "ok", "0", "false"):
        return 0
    raise ValueError(f"unknown label {label!r}")


class HitlLearner:
    """Keeps the base training set + human rulings and refits on demand."""

    def __init__(self, base: pd.DataFrame, gm: fm.GatedModel, version: str, variant: str = fm.FINAL_VARIANT,
                 mode: str = "auto", full_every: int = FULL_EVERY, model_dir: Optional[Path] = None,
                 persist: bool = True, inner_folds: int = 4, seed: int = 0):
        self.base = base.reset_index(drop=True)
        self.gm = gm
        self.version = version
        self.variant = variant
        self.mode = mode
        self.full_every = full_every
        self.model_dir = model_dir
        self.persist = persist
        self.inner_folds = inner_folds
        self.human: List[Dict] = []
        self.since_full = 0
        self.seed = seed
        self.lock = threading.Lock()
        self.log: List[Dict] = []

    @property
    def training_frame(self) -> pd.DataFrame:
        if not self.human:
            return self.base
        h = _rows_to_frame(self.human)
        h = h.loc[:, ~h.columns.duplicated()]
        return pd.concat([self.base, h], ignore_index=True, sort=False)

    def add(self, row: Dict, y: int) -> None:
        r = dict(row)
        r["y"] = int(y)
        r.setdefault("status", "failed" if y else "good")
        r.setdefault("ground_station", -1)
        self.human.append(r)
        self.since_full += 1

    def refit(self, kind: Optional[str] = None, reason: str = "hitl") -> Dict:
        kind = kind or ("full" if self.mode == "full" or self.since_full >= self.full_every else "warm")
        if self.mode == "warm" and kind == "full" and self.full_every <= 0:
            kind = "warm"
        t0 = time.time()
        train = self.training_frame
        if kind == "full":
            gm = fm.fit_gated(train, self.variant, inner_folds=self.inner_folds, seed=self.seed)
            self.since_full = 0
        else:
            new = _rows_to_frame(self.human[-max(1, min(len(self.human), 200)):])
            replay = self.base.sample(n=min(len(self.base), max(len(new), 50)), random_state=len(self.human))
            chunk = pd.concat([replay, new], ignore_index=True, sort=False)
            b = fm.Booster(self.variant).fit(chunk, init=self.gm.booster, n_trees=WARM_TREES)
            b.numeric = self.gm.booster.numeric
            gm = fm.GatedModel(b, self.gm.calibrator, self.gm.t_fail, self.gm.t_ok, self.gm.targets, self.gm.inner,
                              {}, self.gm.rule)
            # Continued boosting shifts raw scores; keep the gate at the same calibrated
            # operating point until the next full refit re-derives it from OOF scores.
            gm = _realign_thresholds(self.gm, gm, train)
        secs = time.time() - t0
        self.gm = gm
        self.version = fm._next_version(self.version)
        entry = {"version": self.version, "kind": kind, "fit_seconds": round(secs, 3), "n_train": len(train),
                 "n_human_labels": len(self.human), "t_fail": gm.t_fail}
        self.log.append(entry)
        if self.persist:
            fm.save_artifacts(gm, self.version, {"reason": f"{reason}:{kind}", "n_train": len(train),
                                                  "n_human_labels": len(self.human), "fit_seconds": round(secs, 3),
                                                  "variant": self.variant}, model_dir=self.model_dir)
        return entry

    def ingest(self, features: Dict, label: str, refit: bool = True, **meta) -> Dict:
        with self.lock:
            y = label_to_y(label)
            self.add(features, y)
            if self.persist:
                path = Path(self.model_dir or fm.MODEL_DIR) / "human_labels.jsonl"
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "a") as f:
                    f.write(json.dumps({"label": label, "y": y, "features": features,
                                        "ingested_at": datetime.now(timezone.utc).isoformat(), **meta},
                                       default=str) + "\n")
            entry = self.refit() if refit else None
            return {"model_version": self.version, "refit": entry, "n_human_labels": len(self.human)}


def _realign_thresholds(old: fm.GatedModel, new: fm.GatedModel, train: pd.DataFrame) -> fm.GatedModel:
    """Map old raw thresholds to the new booster by matching flagged-set size on `train`."""
    r_old, r_new = old.booster.raw(train), new.booster.raw(train)

    def remap(t):
        if t is None:
            return None
        q = (r_old >= t).mean()
        return float(np.quantile(r_new, 1 - q)) if q > 0 else float(r_new.max() + 1)

    def remap_ok(t):
        if t is None:
            return None
        q = (r_old <= t).mean()
        return float(np.quantile(r_new, q)) if q > 0 else float(r_new.min() - 1)

    new.t_fail = remap(old.t_fail)
    new.t_ok = remap_ok(old.t_ok)
    new.targets = {k: remap(v) for k, v in (old.targets or {}).items()}
    return new


# --------------------------------------------------------------------------- production singleton

_LEARNER: Optional[HitlLearner] = None


def get_learner(model_dir: Optional[Path] = None) -> HitlLearner:
    """Lazy singleton: current registered model + the training set it was built from + past rulings."""
    global _LEARNER
    if _LEARNER is None:
        gm, cfg = fm.load_gated(model_dir=model_dir)
        base = fm.build(cfg.get("lag_hours", 1.0))
        learner = HitlLearner(base, gm, cfg["version"], cfg.get("variant", fm.FINAL_VARIANT), model_dir=model_dir)
        path = Path(model_dir or fm.MODEL_DIR) / "human_labels.jsonl"
        if path.exists():
            for line in open(path):
                rec = json.loads(line)
                learner.add(rec["features"], rec["y"])
            learner.since_full = 0
        _LEARNER = learner
    return _LEARNER


def ingest_labeled_decision(features: Dict, label: str, *, pass_id=None, reviewer: Optional[str] = None,
                            ruled_at: Optional[str] = None, refit: bool = True,
                            model_dir: Optional[Path] = None) -> Dict:
    """System 1 worker hook: record a human ruling on an escalated pass and refit.

    `features` is the feature row the gate scored (the `features` field returned
    by `score_pass`), `label` is the ruling: "failed"/"bad" (pass failed) or
    "good"/"fine". Returns the (possibly bumped) model version and refit timing.
    """
    learner = get_learner(model_dir)
    return learner.ingest(features, label, refit=refit, pass_id=pass_id, reviewer=reviewer, ruled_at=ruled_at)


def score_pass(features: Dict, model_dir: Optional[Path] = None) -> Dict:
    """Gate decision for one feature row with the current (possibly HITL-updated) model."""
    learner = get_learner(model_dir)
    df = _rows_to_frame([features])
    dec = learner.gm.decide(df).iloc[0]
    cfg = json.load(open(Path(model_dir or fm.MODEL_DIR) / f"config_{fm.load_registry(model_dir)['current']}.json"))
    return {"model_version": learner.version, "failure_probability": float(dec["p_fail"]),
            **fm.gate_fields(learner.gm, cfg, dec), "features": features}


# --------------------------------------------------------------------------- simulation


def simulate(lag_hours: float = 1.0, start_frac: float = 0.4, step_hours: float = 1.0,
             refit_every_hours: float = 2.0, human_latency_hours: float = 1.0,
             modes: Sequence[str] = ("frozen", "enrich_only", "warm", "full"), variant: str = fm.FINAL_VARIANT,
             n_buckets: int = 6, out_name: str = "hitl_v3", seed: int = 0) -> Dict:
    raw, hours = fm.load_raw()
    obs = cf.normalize_observations(raw)
    stations, kp = fm.load_stations(), fm.load_kp()
    lookback = fm.LOOKBACK_H
    known0 = cf.label_known_at(obs, lag_hours)
    covered = cf.history_coverage(obs, hours, lookback + lag_hours)
    long_ok = cf.history_coverage(obs, hours, fm.LONG_LOOKBACK_H + lag_hours)
    long_cols = ["st_n_long", "st_failed_frac_long"]
    q_all = np.where(obs["labeled"].to_numpy() & covered)[0]
    phys = cf.physical_features(obs.iloc[q_all], stations, kp)
    base_cols = obs.iloc[q_all][["id", "ground_station", "norad_cat_id", "start_ns", "end_ns", "status", "y"]]
    t_start = obs["start_ns"].to_numpy()[q_all]
    T0 = np.quantile(t_start, start_frac)
    T_end = t_start.max() + 1

    init_q = q_all[t_start < T0]
    hist0 = cf.history_features(obs, known0, init_q, lookback, fm.LONG_LOOKBACK_H)
    hist0.loc[~long_ok[init_q], long_cols] = np.nan
    init = pd.concat([base_cols.loc[init_q], phys.loc[init_q], hist0], axis=1).reset_index(drop=True)
    gm0 = fm.fit_gated(init, variant, seed=seed)
    print(f"sim: {len(init)} initial training passes before {pd.Timestamp(int(T0), tz='UTC')}, "
          f"{(t_start >= T0).sum()} replayed passes", flush=True)

    steps = np.arange(T0, T_end + step_hours * cf.NS_PER_H, step_hours * cf.NS_PER_H)
    results = {"generated_at": datetime.now(timezone.utc).isoformat(), "lag_hours": lag_hours,
               "n_initial": len(init), "T0": pd.Timestamp(int(T0), tz="UTC").isoformat(),
               "refit_every_hours": refit_every_hours, "human_latency_hours": human_latency_hours, "modes": {}}
    for mode in modes:
        known = known0.copy()
        learner = HitlLearner(init, gm0, fm.BASE_VERSION, variant, mode="full" if mode == "full" else "warm",
                              full_every=10 ** 9 if mode == "warm" else 0, persist=False, seed=seed)
        recs, last_refit, pending = [], T0, []
        lat = int(human_latency_hours * cf.NS_PER_H)
        for a, b in zip(steps[:-1], steps[1:]):
            sel = q_all[(t_start >= a) & (t_start < b)]
            if len(sel):
                k = known if mode != "frozen" else known0
                h = cf.history_features(obs, k, sel, lookback, fm.LONG_LOOKBACK_H)
                h.loc[~long_ok[sel], long_cols] = np.nan
                X = pd.concat([base_cols.loc[sel], phys.loc[sel], h], axis=1)
                dec = learner.gm.decide(X)
                esc = ~(dec["auto_fail"] | dec["auto_ok"]).to_numpy()
                for (i, row), d, e in zip(X.iterrows(), dec.itertuples(), esc):
                    recs.append({"t": int(row["start_ns"]), "y": int(row["y"]), "status": row["status"],
                                 "auto_fail": bool(d.auto_fail), "auto_ok": bool(d.auto_ok), "escalated": bool(e),
                                 "version": learner.version, "n_human": len(learner.human)})
                if mode in ("enrich_only", "warm", "full"):
                    esc_idx = sel[esc]
                    known[esc_idx] = np.minimum(known[esc_idx], obs["end_ns"].to_numpy()[esc_idx]
                                                + int(human_latency_hours * cf.NS_PER_H))
                if mode in ("warm", "full"):
                    for (_, row), e in zip(X.iterrows(), esc):
                        if e:
                            pending.append((int(row["end_ns"]) + lat, row.to_dict()))
            arrived = [r for r in pending if r[0] <= b]
            pending = [r for r in pending if r[0] > b]
            for _, row in arrived:
                learner.add(row, int(row["y"]))
            if mode in ("warm", "full") and b - last_refit >= refit_every_hours * cf.NS_PER_H and learner.human:
                learner.refit()
                last_refit = b
        R = pd.DataFrame(recs)
        results["modes"][mode] = summarize_sim(R, n_buckets, learner.log)
        s = results["modes"][mode]["overall"]
        print(f"  {mode:12s} precision {fm.fmt(s['precision'])} coverage-of-failures {fm.fmt(s['failure_coverage'], pct=True)} "
              f"refits={len(learner.log)} mean fit {np.mean([e['fit_seconds'] for e in learner.log]) if learner.log else 0:.2f}s",
              flush=True)
    fm.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    json.dump(results, open(fm.REPORT_DIR / f"{out_name}.json", "w"), indent=1, default=float)
    plot_sim(results, fm.REPORT_DIR / f"{out_name}.png")
    (fm.REPORT_DIR / f"{out_name}.md").write_text(render_sim(results, out_name))
    return results


def summarize_sim(R: pd.DataFrame, n_buckets: int, log: List[Dict]) -> Dict:
    def stats(D):
        f = D["auto_fail"].to_numpy()
        y = D["y"].to_numpy()
        tp, nf = int((f & (y == 1)).sum()), int(f.sum())
        ok = D["auto_ok"].to_numpy()
        tn, no = int((ok & (y == 0)).sum()), int(ok.sum())
        return {"n": len(D), "failures": int((y == 1).sum()), "auto_fail": nf, "tp": tp,
                "precision": tp / nf if nf else None, "precision_wilson": fm.wilson(tp, nf) if nf else None,
                "failure_coverage": tp / max(1, int((y == 1).sum())),
                "failed_class_coverage": float((f & (D["status"] == "failed").to_numpy()).sum()
                                               / max(1, (D["status"] == "failed").sum())),
                "auto_ok": no, "ok_precision": tn / no if no else None,
                "escalated": float(D["escalated"].mean()), "human_labels_end": int(D["n_human"].max())}
    edges = np.quantile(R["t"], np.linspace(0, 1, n_buckets + 1))
    buckets = []
    for i in range(n_buckets):
        D = R[(R["t"] >= edges[i]) & ((R["t"] < edges[i + 1]) if i < n_buckets - 1 else (R["t"] <= edges[i + 1]))]
        s = stats(D)
        s["from"] = pd.Timestamp(int(edges[i]), tz="UTC").isoformat()
        s["to"] = pd.Timestamp(int(edges[i + 1]), tz="UTC").isoformat()
        s["version_end"] = D["version"].iloc[-1] if len(D) else None
        buckets.append(s)
    return {"overall": stats(R), "buckets": buckets, "refits": log,
            "mean_fit_seconds": float(np.mean([e["fit_seconds"] for e in log])) if log else None}


def plot_sim(res: Dict, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))
    for mode, r in res["modes"].items():
        b = r["buckets"]
        x = np.arange(1, len(b) + 1)
        axes[0].plot(x, [100 * s["failure_coverage"] for s in b], marker="o", label=mode)
        axes[1].plot(x, [s["precision"] if s["precision"] is not None else np.nan for s in b], marker="o", label=mode)
    axes[0].set_title("Failures auto-decided (share of all failures)", fontsize=10)
    axes[0].set_ylabel("%")
    axes[1].set_title("Precision of auto 'failed' calls", fontsize=10)
    axes[1].axhline(0.95, color="grey", ls="--", lw=1)
    axes[1].set_ylim(0.8, 1.005)
    for ax in axes:
        ax.set_xlabel("replay time bucket (equal pass counts, oldest -> newest)")
        ax.legend(fontsize=8)
    fig.suptitle(f"Human-in-the-loop replay: {res['n_initial']} initial passes, refit every "
                 f"{res['refit_every_hours']:g}h of replay time", fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def render_sim(res: Dict, out_name: str) -> str:
    L = ["# Human-in-the-loop replay (v3)", "",
         f"Generated {res['generated_at']} by `python -m ml.hitl simulate`. Initial model trained on "
         f"{res['n_initial']} passes before {res['T0'][:16]} UTC; later passes are replayed in time order. "
         f"Every escalated pass gets its true SatNOGS label as the human ruling {res['human_latency_hours']:g}h "
         f"after the pass ends. Refit every {res['refit_every_hours']:g}h of replay time.", "",
         "- `frozen`: no updates.",
         "- `enrich_only`: rulings only make outcomes known earlier to the history features; model unchanged.",
         "- `warm`: enrich + continued boosting on rulings (+ replay sample), gate re-aligned to the same flagged share.",
         "- `full`: enrich + nested refit (inner station-grouped OOF -> isotonic + Wilson 0.95 threshold).", "",
         "| mode | auto 'failed' calls | precision | 95% CI (Wilson) | failures auto-decided | `failed` class auto-decided "
         "| escalated | human labels | refits | mean refit time |", "|---|---|---|---|---|---|---|---|---|---|"]
    for mode, r in res["modes"].items():
        o = r["overall"]
        L.append(f"| {mode} | {o['auto_fail']} | {fm.fmt(o['precision'])} | {fm.fmt_ci(o['precision_wilson'])} | "
                 f"{fm.fmt(o['failure_coverage'], pct=True)} | {fm.fmt(o['failed_class_coverage'], pct=True)} | "
                 f"{fm.fmt(o['escalated'], pct=True)} | {o['human_labels_end']} | {len(r['refits'])} | "
                 f"{fm.fmt(r['mean_fit_seconds'], 2)}s |")
    L += ["", "Failures auto-decided per replay bucket (equal pass counts, oldest first); precision in brackets:", "",
          "| mode | " + " | ".join(f"b{i + 1}" for i in range(len(next(iter(res['modes'].values()))['buckets']))) + " |",
          "|---|" + "---|" * len(next(iter(res["modes"].values()))["buckets"])]
    for mode, r in res["modes"].items():
        L.append(f"| {mode} | " + " | ".join(
            f"{fm.fmt(s['failure_coverage'], pct=True)} ({fm.fmt(s['precision'], 2)}, n={s['auto_fail']})"
            for s in r["buckets"]) + " |")
    L += ["", f"![HITL replay]({out_name}.png)", ""]
    return "\n".join(L)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("simulate")
    s.add_argument("--lag", type=float, default=1.0)
    s.add_argument("--start-frac", type=float, default=0.4)
    s.add_argument("--refit-every-hours", type=float, default=2.0)
    s.add_argument("--modes", default="frozen,enrich_only,warm,full")
    s.add_argument("--buckets", type=int, default=6)
    args = p.parse_args(argv)
    if args.cmd == "simulate":
        simulate(args.lag, args.start_frac, refit_every_hours=args.refit_every_hours,
                 modes=args.modes.split(","), n_buckets=args.buckets)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
