"""
Run the v3 experiment suite on the time-uniform dataset.

Each experiment is evaluated with held-out stations:
  station       GroupKFold(5) by station over all blocks
  station_time  same station folds, but train on the earliest 70% of time
                blocks and test on the latest 30% (held-out stations AND future)

Both operating points are selected on training-station OOF scores only:
  esc17   alpha closest to 17% escalation
  prec95  per-class alphas maximizing coverage with calibration precision >= 0.95

Usage:
    python -m ml.uniform_data            # build data/processed/passes_uniform.parquet
    python -m ml.experiments_v3 [--only E2 E3] [--splits station station_time]
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

from .abstain_v3 import ABSTAIN, FAIL_BAD, FAIL_NODATA, AbstainV3, TwoStageV3, V3Config, _binary
from .conformal_ensemble import FAIL, OK, SAT_TE_FEATURES, add_satellite_encoding, decision_metrics
from .uniform_data import OUT as DATA_PATH

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)
RESULTS = Path(__file__).parent / "models" / "experiments_v3.json"

BASE_NUM = ["max_elevation_deg", "duration_sec", "log_duration", "elevation_margin_deg", "station_min_horizon",
            "station_lat", "station_lon", "station_abs_lat", "station_altitude_m", "station_age_days",
            "n_antennas", "has_omni", "has_directional"]
BASE_CAT = ["transmitter_mode", "mode_family"]
TIME_KP = ["kp_at_time", "kp_max_24h", "hour_utc", "local_solar_hour"]
STATION_HEALTH = ["st_n_past", "st_hours_since_alive", "st_hours_since_good", "st_consec_nodata",
                  "st_fail_last5", "st_fail_last20", "st_nodata_last5", "st_nodata_last20",
                  "st_recent_n", "st_uptime_24h", "stsat_fail_last5", "stsat_cum_n_labeled"]
CO_OBS = ["sat_n_past", "sat_hours_since_alive", "sat_hours_since_good", "sat_consec_nodata",
          "sat_fail_last5", "sat_fail_last20", "sat_nodata_last20", "sat_recent_n", "sat_recent_good",
          "sat_recent_good_frac", "sat_recent_any_good", "tx_fail_last20", "tx_cum_n_labeled",
          "transmitter_unconfirmed", "sat_frequency_violator", "sat_decayed_before_pass"]
CO_OBS_CAT = ["transmitter_status_pre"]
BETTER = ["tle_age_days", "freq_mhz", "freq_in_antenna_range", "freq_dist_to_antenna_mhz", "culmination_margin_deg",
          "station_min_culmination", "azimuth_span_deg", "sat_inclination_deg", "sat_eccentricity",
          "sat_altitude_km", "log_baud"]
BETTER_CAT = ["band", "matched_antenna_class", "transmitter_type"]
BAYES = ["st_bayes_fail", "st_bayes_nodata", "sat_bayes_fail", "sat_bayes_bad"]
CONCURRENT = ["sat_conc_n", "sat_conc_good", "sat_conc_good_frac"]

FULL_NUM = BASE_NUM + TIME_KP + STATION_HEALTH + CO_OBS + BETTER
FULL_CAT = BASE_CAT + CO_OBS_CAT + BETTER_CAT


def experiments() -> Dict[str, Dict[str, Any]]:
    return {
        "E0_v2_baseline": dict(num=BASE_NUM + SAT_TE_FEATURES, cat=BASE_CAT, sat_te=True,
                               note="v2 recipe (hardware + fold-safe satellite TE) on the uniform data; TE is not time-causal"),
        "E1_time_kp": dict(num=BASE_NUM + SAT_TE_FEATURES + TIME_KP, cat=BASE_CAT, sat_te=True,
                           note="+ Kp and time of day (valid now that sampling is time-uniform)"),
        "E2_station_health": dict(num=BASE_NUM + SAT_TE_FEATURES + TIME_KP + STATION_HEALTH, cat=BASE_CAT, sat_te=True,
                                  note="+ past-only station health (rolling outcomes, last alive, 24h uptime)"),
        "E2c_station_health_causal": dict(num=BASE_NUM + TIME_KP + STATION_HEALTH, cat=BASE_CAT,
                                          note="E2 without satellite TE (TE uses same-block, partly future, outcomes)"),
        "E3_coobs_txstatus": dict(num=BASE_NUM + TIME_KP + STATION_HEALTH + CO_OBS, cat=BASE_CAT + CO_OBS_CAT,
                                  note="+ causal co-observation / satellite & transmitter history; replaces satellite TE"),
        "E4_better_features": dict(num=FULL_NUM, cat=FULL_CAT,
                                   note="+ TLE age, band vs antenna, culmination/horizon margins, orbit, baud"),
        "E5a_stacked": dict(num=FULL_NUM, cat=FULL_CAT, stacked=True, xgb=True,
                            note="E4 features, CatBoost + XGBoost + LR with stacked LR meta-learner"),
        "E5b_bayes_prior": dict(num=FULL_NUM + BAYES, cat=FULL_CAT,
                                note="E4 + beta-binomial shrunk station / satellite failure priors"),
        "E5c_group_mondrian": dict(num=FULL_NUM + BAYES, cat=FULL_CAT, group="conf_group",
                                   note="E5b + group-conditional conformal (station-history bucket x band)"),
        "E6_two_stage": dict(num=FULL_NUM + BAYES, cat=FULL_CAT, two_stage=True,
                             note="E5b features, separate no-data and bad-signal stages"),
        "X1_concurrent_triage": dict(num=FULL_NUM + BAYES + CONCURRENT, cat=FULL_CAT,
                                     note="NON-CAUSAL: + other stations' outcomes for the same pass window; post-pass triage only"),
    }


def load() -> pd.DataFrame:
    df = pd.read_parquet(DATA_PATH)
    hist = pd.cut(df["st_cum_n_labeled"], [-1, 2, 19, np.inf], labels=["new", "some", "rich"]).astype(str)
    df["conf_group"] = hist + "|" + df["band"].where(df["band"].isin(["UHF", "VHF"]), "OTHER")
    df["t0"] = pd.to_datetime(df["start_time"], utc=True)
    return df.sort_values("t0").reset_index(drop=True)


def _splits(df: pd.DataFrame, scheme: str, n_folds: int = 5):
    groups = df["station_id"].to_numpy()
    folds = list(GroupKFold(n_folds).split(df, groups=groups))
    if scheme == "station":
        yield from folds
        return
    blocks = sorted(df["block"].unique())
    n_test = max(1, int(round(0.3 * len(blocks))))
    late = df["block"].isin(blocks[-n_test:]).to_numpy()
    for tr, te in folds:
        yield tr[~late[tr]], te[late[te]]


def _summ(y, d, status, fold_ids):
    m = decision_metrics(y, _binary(d))
    out = {k: m[k] for k in ("coverage", "escalation_rate", "accuracy_auto", "precision_fail", "precision_ok",
                             "recall_fail_auto", "recall_fail_overall", "n_fail_calls", "n_ok_calls", "confusion_auto")}
    per = []
    for f in np.unique(fold_ids):
        mf = decision_metrics(y[fold_ids == f], _binary(d[fold_ids == f]))
        per.append([mf["coverage"], mf["accuracy_auto"], mf["precision_fail"], mf["precision_ok"], mf["recall_fail_overall"]])
    per = np.array(per, dtype=float)
    for i, k in enumerate(("coverage", "accuracy_auto", "precision_fail", "precision_ok", "recall_fail_overall")):
        out[f"{k}_std"] = float(np.nanstd(per[:, i]))
    out["false_ok_by_status"] = pd.Series(status[(d == OK) & (y == 1)]).value_counts().to_dict()
    if (d == FAIL_NODATA).any() or (d == FAIL_BAD).any():
        out["route_precision"] = {
            "FAIL_NODATA_is_failed": float(np.mean(status[d == FAIL_NODATA] == "failed")) if (d == FAIL_NODATA).any() else None,
            "FAIL_NODATA_is_any_fail": float(np.mean(y[d == FAIL_NODATA] == 1)) if (d == FAIL_NODATA).any() else None,
            "FAIL_BAD_is_any_fail": float(np.mean(y[d == FAIL_BAD] == 1)) if (d == FAIL_BAD).any() else None,
            "n_FAIL_NODATA": int((d == FAIL_NODATA).sum()), "n_FAIL_BAD": int((d == FAIL_BAD).sum()),
        }
    return out


def run_experiment(df: pd.DataFrame, spec: Dict[str, Any], scheme: str) -> Dict[str, Any]:
    y_all = (df["status"] != "good").astype(int).to_numpy()
    st_all = df["status"].to_numpy()
    cfg = V3Config(numeric=spec["num"], categorical=spec["cat"], use_xgb=spec.get("xgb", False),
                   stacked=spec.get("stacked", False),
                   weights={"cb": 0.45, "xgb": 0.25, "lr": 0.3} if spec.get("xgb") else {"cb": 0.6, "lr": 0.4})
    idx_all, score_all, fold_all = [], [], []
    dec_all: Dict[str, List[np.ndarray]] = {}
    aucs, alphas = [], []
    for k, (tr, te) in enumerate(_splits(df, scheme)):
        Xtr, Xte = df.iloc[tr], df.iloc[te]
        if spec.get("sat_te"):
            Xtr, (Xte,), _ = add_satellite_encoding(Xtr, y_all[tr], st_all[tr], [Xte], smoothing=5)
        if spec.get("two_stage"):
            model = TwoStageV3(cfg).fit(Xtr, y_all[tr], st_all[tr])
        else:
            model = AbstainV3(cfg, group_col=spec.get("group")).fit(Xtr, y_all[tr], st_all[tr])
        s = model.score(Xte)
        aucs.append(roc_auc_score(y_all[te], s))
        alphas.append({k2: str(v) for k2, v in model.alphas_.items()})
        for name, d in model.decide(Xte).items():
            dec_all.setdefault(name, []).append(d)
        idx_all.append(te), score_all.append(s), fold_all.append(np.full(len(te), k))
    idx = np.concatenate(idx_all)
    y, st, folds = y_all[idx], st_all[idx], np.concatenate(fold_all)
    res = {"n_test": int(len(idx)), "auc": float(roc_auc_score(y, np.concatenate(score_all))),
           "auc_fold_std": float(np.std(aucs)), "alphas": alphas, "note": spec["note"]}
    for name, ds in dec_all.items():
        res[name] = _summ(y, np.concatenate(ds), st, folds)
    return res


def fmt_row(name: str, r: Dict[str, Any], pol: str) -> str:
    m = r[pol]
    f = lambda k: f"{m[k]:.3f}±{m[k + '_std']:.3f}" if not np.isnan(m[k]) else "–"
    return (f"| {name} | {r['auc']:.3f}±{r['auc_fold_std']:.3f} | {m['escalation_rate']:.1%} | {f('coverage')} | "
            f"{f('accuracy_auto')} | {f('precision_fail')} | {f('precision_ok')} | {f('recall_fail_overall')} | "
            f"{m['n_fail_calls']}/{m['n_ok_calls']} |")


def print_tables(all_res: Dict[str, Dict[str, Any]]) -> None:
    for scheme, res in all_res.items():
        for pol, title in (("esc17", "~17% escalation"), ("prec95", "0.95 precision target")):
            print(f"\n### split={scheme}, policy={title}\n")
            print("| Experiment | AUC | Escalation | Coverage | Acc (auto) | Prec FAIL | Prec OK | Recall FAIL (all) | #FAIL/#OK calls |")
            print("|---|---|---|---|---|---|---|---|---|")
            for name, r in res.items():
                print(fmt_row(name, r, pol))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--only", nargs="*")
    p.add_argument("--splits", nargs="*", default=["station", "station_time"])
    args = p.parse_args()
    df = load()
    log.info("data: %d passes, %d stations, %d blocks, status %s", len(df), df["station_id"].nunique(),
             df["block"].nunique(), df["status"].value_counts().to_dict())
    exps = {k: v for k, v in experiments().items() if not args.only or k in args.only}
    prev = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    results: Dict[str, Dict[str, Any]] = {}
    for scheme in args.splits:
        results[scheme] = dict(prev.get("results", {}).get(scheme, {})) if args.only else {}
        for name, spec in exps.items():
            t = time.time()
            results[scheme][name] = run_experiment(df, spec, scheme)
            r = results[scheme][name]
            log.info("%s [%s] auc=%.3f esc17 acc=%.3f esc=%.3f | prec95 cov=%.3f (%.0fs)", name, scheme, r["auc"],
                     r["esc17"]["accuracy_auto"], r["esc17"]["escalation_rate"], r["prec95"]["coverage"], time.time() - t)
    meta = {"n_passes": int(len(df)), "n_stations": int(df["station_id"].nunique()), "n_blocks": int(df["block"].nunique()),
            "status_counts": df["status"].value_counts().to_dict(), "blocks": sorted(df["block"].unique().tolist())}
    RESULTS.parent.mkdir(exist_ok=True)
    RESULTS.write_text(json.dumps({"data": meta, "results": results}, indent=2, default=str))
    print_tables(results)


if __name__ == "__main__":
    main()
