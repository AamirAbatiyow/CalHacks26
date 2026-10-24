"""
Check the v1.1.0 labels against an unfiltered re-fetch of the same time window.

For every window slice fetched by `ml/fetch_labeled.py` that overlaps the
v1.1.0 data, report whether each v1.1.0 pass is present with the same
status, and whether v1.1.0 captured every good/bad/failed pass in the slice
(it should inside the census window, and should not outside it).

Usage:
    python -m ml.verify_labels
"""

import json
from collections import Counter
from pathlib import Path

import pandas as pd

from . import datasets as ds
from .fetch_labeled import WINDOW_DIR

REPORT_DIR = Path(__file__).parent / "reports"


def verify() -> dict:
    v110 = pd.read_parquet(ds.PROCESSED_DIR / "passes_features.parquet")
    v110["t"] = pd.to_datetime(v110["start_time"], utc=True)
    by_id = v110.set_index("pass_id")["status"]
    report = {"slices": []}
    for path in sorted(WINDOW_DIR.glob("*_*.json")):
        payload = json.load(open(path))
        start = pd.Timestamp(payload["window_start"])
        end = pd.Timestamp(payload["window_end"])
        in_window = v110[(v110["t"] >= start) & (v110["t"] < end)]
        if in_window.empty:
            continue
        fresh = pd.DataFrame(payload["observations"])
        fresh_status = fresh.set_index("id")["status"]
        ids = in_window["pass_id"]
        present = ids.isin(fresh_status.index)
        now = fresh_status.reindex(ids.values)
        same = (now.values == in_window["status"].values)
        transitions = Counter(zip(in_window["status"].values, now.fillna("missing").values))
        labeled_fresh = fresh[fresh["status"].isin(ds.LABELED_STATUSES)]
        missed = labeled_fresh[~labeled_fresh["id"].isin(by_id.index)]
        report["slices"].append({
            "window": [str(start), str(end)],
            "fetched_at": payload["fetched_at"],
            "inside_census_window": bool(start >= ds.V110_CENSUS_START),
            "v110_rows_in_window": int(len(in_window)),
            "v110_rows_found": int(present.sum()),
            "v110_status_unchanged": int(same.sum()),
            "status_transitions_v110_to_now": {f"{a}->{b}": n for (a, b), n in transitions.items()},
            "fresh_status_counts_all": fresh["status"].value_counts().to_dict(),
            "fresh_labeled_not_in_v110": missed["status"].value_counts().to_dict(),
            "bad_vetted_by_human": float(fresh.loc[fresh["status"] == "bad", "vetted_user"].notna().mean())
            if (fresh["status"] == "bad").any() else None,
            "good_vetted_by_human": float(fresh.loc[fresh["status"] == "good", "vetted_user"].notna().mean())
            if (fresh["status"] == "good").any() else None,
        })
    return report


def main():
    report = verify()
    REPORT_DIR.mkdir(exist_ok=True)
    with open(REPORT_DIR / "label_verification.json", "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
