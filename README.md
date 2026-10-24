# Ground Truth

AI dispute and billing analyst for satellite ground-station operators. Built for Cal Hacks 2026, targeting the SpacetimeDB "Best Use" prize.

## Overview

Ground Truth provides real-time visibility into ground station operations, pass scheduling, space weather impacts, and financial KPIs. The system uses SpacetimeDB for real-time data synchronization, with a three.js-powered globe visualization showing:

- **Ground stations** - Markers sized by monthly revenue
- **Satellites and routes** - Live TLE-based positioning with orbit tracks
- **Pass traffic** - Active satellite-to-station communication links
- **Space weather** - Auroral oval visualization based on Kp index

## Architecture

```
/server/spacetimedb   - SpacetimeDB Rust module
/server/fixtures      - JSON fixture data for seeding
/web                  - Vite + React + TypeScript frontend
```

## Prerequisites

- [SpacetimeDB CLI](https://spacetimedb.com/install)
- Node.js 20+
- Rust (for building the SpacetimeDB module)

## Quick Start

### 1. Install SpacetimeDB CLI

```bash
curl -sSf https://install.spacetimedb.com | sh
export PATH="$HOME/.local/bin:$PATH"
```

### 2. Start Local SpacetimeDB Server

```bash
spacetime start
```

### 3. Build and Publish the Module

```bash
cd server/spacetimedb
spacetime build
spacetime publish ground-truth --server local --yes
```

### 4. Seed the Database

```bash
# Run the seed script (from server directory)
cd server
./seed.sh
```

### 5. Start the Web Client

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Environment Configuration

### Local Development

Copy `.env.example` to `.env` in the `/web` directory:

```bash
cp web/.env.example web/.env
```

Default configuration:
```
VITE_SPACETIMEDB_HOST=http://localhost:3000
VITE_SPACETIMEDB_MODULE=ground-truth
```

### Deploying to SpacetimeDB Maincloud

From a fresh checkout, deploy to Maincloud with these commands:

```bash
# 1. Install SpacetimeDB CLI (if not already installed)
curl -sSf https://install.spacetimedb.com | sh
export PATH="$HOME/.local/bin:$PATH"

# 2. Login to SpacetimeDB (opens browser for authentication)
spacetime login

# 3. Build and publish to Maincloud
cd server/spacetimedb
spacetime build
spacetime publish ground-truth --server maincloud --yes

# 4. Seed the database on Maincloud
cd ..
SPACETIMEDB_SERVER=maincloud SPACETIMEDB_MODULE=ground-truth ./seed.sh

# 5. Build the web client for production
cd ../web
echo "VITE_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com" > .env
echo "VITE_SPACETIMEDB_MODULE=ground-truth" >> .env
npm install
npm run build
```

The `dist/` folder is now ready to deploy to any static hosting (Vercel, Netlify, Cloudflare Pages, etc.).

**Environment Variables for Maincloud:**
```
VITE_SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
VITE_SPACETIMEDB_MODULE=ground-truth
```

**Server-side seed script environment:**
```bash
SPACETIMEDB_SERVER=maincloud  # or 'local' for local development
SPACETIMEDB_MODULE=ground-truth
```

## SpacetimeDB Tables

| Table | Description |
|-------|-------------|
| `station` | Ground station locations and revenue data |
| `satellite` | Satellite catalog with TLE data |
| `pass` | Scheduled/active/completed passes |
| `space_weather` | Kp index, flare events, Dst index |
| `sim_clock` | Simulation time control |
| `kpi` | Financial KPIs, all derived from other tables by `sync_kpis` (see below); never written by hand |
| `escalated_claim` | Approvals queue: claims the confidence gate escalated for human review |
| `claim`, `claim_pass`, `claim_evidence`, `claim_decision`, `claim_outcome`, `claim_weather` | Claim page (`#/claims/<id>`): the disputed pass, evidence, gated decision and outcome |
| `claim_reason` | SHAP contributions behind a claim decision's confidence |
| `decision_record` | Audit log for AI decisions with `policy_version` and `model_version` |

### Decision Record Schema

All AI-driven decisions (disputes, credits, pass classifications) are logged to `decision_record` with:
- `policy_version` - Version of the policy rules used for the decision
- `model_version` - Version of the AI model that made or assisted the decision
- `decision_type` - Type: DisputeCreated, DisputeResolved, CreditIssued, PassDropped, PassRecovered
- `outcome` - Result: Pending, Approved, Denied, AutoApproved, Escalated

## Reducers

| Reducer | Description |
|---------|-------------|
| `seed_station` | Add a ground station |
| `seed_satellite` | Add a satellite |
| `seed_pass` | Add a pass |
| `seed_passes` | Add a batch of passes (used by `seed.sh` for the generated history) |
| `settle_pass_history` | Settle the generated history: credits, recoveries, disputes and denials, gated by confidence |
| `seed_space_weather` | Add space weather data |
| `set_playback_speed` | Set simulation speed (1x/4x/16x) |
| `set_playback_playing` | Play/pause simulation |
| `seek_to_time` | Jump to specific time |
| `go_live` | Return to live time |
| `record_decision` | Log an AI decision with policy/model versions |
| `seed_finance_history` | Seed audit decisions and ledger entries against already-seeded passes |
| `seed_escalated_claim` | Add a claim to the Approvals queue (only if the confidence gate escalates it) |
| `approve_escalated_claim` / `deny_escalated_claim` / `edit_escalated_claim` | Human decisions on escalated claims |
| `seek_replay` | Jump a policy replay to a given claim |
| `seed_claim_decision` | Credit a claim's verified loss; gate, rule and policy version come from the confidence gate and active Cedar policy |
| `seed_claim_weather` | Attach the `space_weather` reading nearest a claim's signal loss |
| `seed_claim_reason` | Add a SHAP reason to a claim decision |

## UI Features

### Layer Panel
Toggle visibility of:
- Ground stations (white markers)
- Satellites and routes (gray markers with orbit tracks)
- Pass traffic (white/amber lines)
- Space weather (auroral oval, storm-affected station highlights)

### Playback Bar
- Play/pause simulation
- Speed control (1x, 4x, 16x)
- Scrubber showing last 24 hours
- Event ticks (amber for disputes/dropped passes)
- Live button to return to real-time

### KPI Strip
- Billed this month
- Revenue at risk (amber highlight)
- Credits paid
- Recovered

### How the KPIs are computed

`server/spacetimedb/src/kpis.rs` recomputes the single `kpi` row every sim tick and after ledger writes, seeding and Approvals decisions. The Overview strip and the Finance summary both render that row.

| KPI | Formula |
|-----|---------|
| Billed this month | Revenue of every non-scheduled pass that started in the trailing 30 days (dropped passes included) |
| Revenue at risk | Per pass, the larger of: full revenue of a dropped pass, or the amount of a pending decision or open SLA dispute, capped at that pass's revenue. Only passes with no credit, recovery or final decision yet |
| Credits paid | Sum of `Credit` ledger entries |
| Recovered | Sum of `Recovery` ledger entries |
| Leakage avoided | Recovered + denied claim amounts (capped at pass revenue) + denied SLA disputes + the unpaid part of human-reviewed escalations |
| Review cost saved | Auto-approved decisions x ($300 human review - $15 Ground Truth) |

Seeded credits, recoveries and claims are percentages of the revenue of the pass they refer to, and seeded invoices are one per station totalling billed pass revenue, so the Ledger invoices sum to Billed this month at seed time.

There are no dollar approval caps anywhere. The confidence gate is the only gate: confidence of 95% or more auto-decides, anything lower escalates to Approvals. Every auto-approval writes its ledger credit. The $300 in Review cost saved is the cost of a human review, not a cap.

## Seeded volume

The seed models an operator the size of KSAT, priced at AWS Ground Station on-demand rates. Only the inputs below are hand-written; every pass, price, station revenue, credit, dispute and KPI is derived from them by `seed.sh`.

### Reference points

| Fact | Value | Source |
|------|-------|--------|
| KSAT ground stations | 28 | KSAT 2025 annual report |
| KSAT antennas | ~375 | KSAT 2025 annual report |
| KSAT contacts | ~2.1M/year (~175K/month) | KSAT 2025 annual report |
| KSAT revenue | NOK 2.36B (~$220M) | KSAT 2025 annual report |
| Narrowband price | $15 per minute | AWS Ground Station on-demand |
| Wideband price | $25 per minute | AWS Ground Station on-demand |

### Inputs (`server/fixtures/`)

| Input | File | Value |
|-------|------|-------|
| Stations | `stations.json` | 28 stations with 322 antennas in total (SvalSat 100, Tromso 40, TrollSat 12, Hartebeesthoek 12, the rest 2 to 10). No revenue figures: each station's monthly revenue is the sum of its billed passes |
| Satellites | `satellites.json` | 169 satellites with real CelesTrak TLEs: the 30 curated demo satellites plus Planet (40), Spire (30, narrowband), ICEYE (40), Satellogic (15), Capella (9) and Umbra (5). Each satellite has a `band` that sets its price |
| Contracts | `contracts.json` | Six enterprise contracts, one per customer, each covering a constellation with a daily contact quota per satellite (10 to 12). Together they ask for about 1,580 contacts per day |
| Pricing | `contracts.json` `pricing` | $15/min narrowband, $25/min wideband, billed per started minute |
| History | `contracts.json` | 30 days of history plus 24 hours of scheduled passes |
| Drops | `contracts.json` | 1.5% of contacts drop; 6% at stations above 60° latitude during Kp ≥ 5 storms |
| Settlement | `contracts.json` `settlement` | Passes settle 72 hours after they end. Of dropped passes, 60% are credited in full, 25% are recovered (re-downlinked) and the rest are denied. 2% of completed passes are disputed; 65% of those are credited 25% to 50% of the pass, the rest denied, and recent ones stay open. 65% of decisions carry confidence ≥ 95% and auto-decide; the rest go through human review |
| Escalated claims | `claims.json` | Six Approvals claims, each tied to 20 to 120 of the customer's most recent open passes and sized as a percentage of those passes' revenue |

### How passes are generated

`server/scripts/generate-passes.mjs` propagates every contracted satellite with SGP4 (satellite.js) against every station, keeps contacts above 10° elevation lasting at least 4 minutes, and books them highest-elevation first, subject to the satellite's daily quota, a 5-minute slew gap between its contacts and each station's antenna count. Each pass is priced at its band's rate per started minute. The curated passes in `passes.json` (used by Break It and the Overview) and the Claim page's NOAA-20 pass are added on top. `seed.sh` loads the result in batches through `seed_passes`, then `settle_pass_history` writes the dispute and credit history above.

### Resulting figures (fresh seed)

| Figure | Value |
|--------|-------|
| Passes | 48,954 (about 47,000 billed in the trailing 30 days, roughly a quarter of KSAT's monthly contacts) |
| Billed this month | $8.05M (about $97M a year, in line with KSAT's ~$220M total revenue) |
| Revenue at risk | $85.3K |
| Credits paid | $100.9K |
| Recovered | $28.7K |
| Leakage avoided | $96.3K |
| Review cost saved | $180.1K (632 auto-approved decisions x $285) |

The annual figures are 12 times the trailing-30-day KPIs:

| Annual figure | Formula | Value |
|---------------|---------|-------|
| Dispute cost | 12 x (Credits paid + Revenue at risk) | ~$2.2M |
| Leakage avoided | 12 x Leakage avoided | ~$1.2M |
| Review cost saved | 12 x Review cost saved | ~$2.2M |

Exact figures move slightly with the seed time, because pass geometry and the trailing 30-day window depend on `now`.

## Development

### Generate TypeScript Bindings

After modifying the SpacetimeDB module:

```bash
cd web
npm run generate
```

### Build for Production

```bash
cd web
npm run build
```

### Check Logs

```bash
spacetime logs ground-truth --server local -f
```

## ML Pass-Failure Prediction

The `/ml` directory contains a gradient-boosted model (LightGBM) for predicting satellite pass failures. The model uses real SatNOGS observation outcomes combined with space weather and local conditions to estimate failure probability per pass.

### v3.0.0: final high-precision gate (current)

`ml/final_model.py` + `ml/causal_features.py` + `ml/hitl.py` + `ml/satnogs_fetcher.py` combine the three earlier ML
branches (PR #12 outage streaks, PR #17 past-only station health / co-observation, PR #18 physics features and
random-window sampling) into one strictly causal model whose only job is to auto-decide "this pass failed" when it
is very sure and escalate everything else to a human.

**Data.** One continuously running collector (`python -m ml.satnogs_fetcher daemon`, see below) stores whole UTC
hours of SatNOGS observations, so class mix is natural and every station's pass history is complete. Snapshot used
for v3.0.0: 18 contiguous hours (2026-10-20 21:00 to 2026-10-21 15:00 UTC, fetched 72h+ after the passes so `failed`/
`good` have settled), 3,188 observations, 2,406 labeled. After dropping passes whose 1h+6h history window is not
fully inside the store, **1,467 labeled passes, 304 stations** (806 good, 364 bad, 297 failed; failure = bad or failed,
base rate 0.45). A commit-sized copy is in `data/processed/satnogs_store_snapshot.parquet`.

**Features (all known at pass start).**
- Physics (PR #18): elevation and margin over the station's mask/culmination limit, duration, azimuth span, antenna
  coverage of the downlink, frequency/band, baud, mode, TLE age, B* drag, perigee/apogee, inclination, satellite age,
  Kp of the last *completed* 3h bin and 24h max, geomagnetic latitude, sun elevation. No station id, name, raw
  lat/lon, or post-hoc station fields (`status`, `last_seen`, `success_rate`, `client_version`).
- Outcome history with an explicit label-latency model: a past pass counts only once its outcome was known
  (`failed`/`good`: pass end + lag, lag = 1h or 3h; vetted `good`/`bad`: vetting timestamp; `unknown`: never).
  Station: outage streak, failed/good share, last outcome, hours since last good/failed (PR #12/#17); satellite,
  transmitter, station×band, station×satellite failed/good shares over the last 6h (PR #17 co-observation,
  PR #18 rates). Satellite target encoding over the same window is **not** used (non-causal, PR #17).

**Model and gate.** LightGBM with monotone constraints on the station outage features, isotonic calibration. The
auto-"failed" threshold is picked *inside each training fold* on station-grouped out-of-fold scores: the lowest
threshold whose Wilson lower bound (z = 1.28) of inner precision is ≥ 0.95. Everything below it escalates.

**Held-out results (lag 1h, `ml/reports/final_v3.md`).**

| Split | Auto "failed" calls | Precision | 95% CI (Wilson) | 95% CI (station bootstrap) | Recall (all failures) | Recall `failed` / `bad` | Coverage (share of passes) | AUC |
|---|---|---|---|---|---|---|---|---|
| Held-out stations (5 folds) | 70 | **1.000** | 0.948–1.000 | 1.000–1.000 | 10.6% | 19.9% / 3.0% | 4.8% | 0.881 |
| Future time (last 30%, 3h embargo) | 52 | **0.962** | 0.870–0.989 | 0.896–1.000 | 25.0% | 45.7% / 10.9% | 11.8% | 0.819 |
| Future time, stations unseen in training | 2 | 0.500 | 0.095–0.905 | – | 3.4% | – | – | – |

Accuracy on auto-decided passes equals the precision above (the OK side found no in-fold threshold meeting the rule
in the time split; on held-out stations it auto-cleared 3.7% of passes at 0.891 precision, so two-sided accuracy is
0.952). Per-fold precision on held-out stations: 1.000 (n=25), 1.000 (n=28), no calls, 1.000 (n=16), 1.000 (n=1).

Comparison (same folds and rule; full table incl. other threshold rules in the report):

| Variant | Held-out stations: calls / precision / recall | Future time: calls / precision / recall |
|---|---|---|
| physics only | 0 / – / 0% | 0 / – / 0% |
| PR #12 station state + physics | 41 / 0.927 / 5.7% | 0 / – / 0% |
| full causal | 40 / 1.000 / 6.1% | 48 / 0.938 / 22.5% |
| **full causal + monotone (v3.0.0)** | **70 / 1.000 / 10.6%** | **52 / 0.962 / 25.0%** |
| full causal + monotone, outage-evidence only | 77 / 0.883 / 10.3% | 44 / 0.955 / 21.0% |
| transparent streak rule | 85 / 0.953 / 12.3% | 0 / – / 0% |

With 3h label latency, history is thinner and the gate becomes very conservative (v3.0.0 recipe: 17 calls at 0.941
on held-out stations, none in the time split). Honest caveats: 18 hours of one day is a small sample, the CIs are
wide, the threshold rule (`wilson80`) and variant were chosen by looking at these same folds after an earlier
smaller run, and recall is lower than PR #12's 0.35 because this gate is stricter (Wilson bound rather than point
precision) and evaluated on a natural, settled sample. PR curves (the outage-evidence curve coincides with v3.0.0 because it shares its calibrated score): `ml/reports/final_v3_pr_station.png`,
`ml/reports/final_v3_pr_time.png`.

**Human-in-the-loop (`ml/hitl.py`, `ml/reports/hitl_v3.md`).** Each human ruling on an escalated pass becomes a
labeled example *and* makes that pass's outcome known immediately to later passes' history features. The System 1
worker calls `ml.hitl.ingest_labeled_decision(features, label, pass_id=..., reviewer=...)`; it appends the ruling to
`ml/models/final/human_labels.jsonl`, refits, bumps the version (v3.0.0 -> v3.0.1 ...) and registers it in
`ml/models/final/registry.json`. Refits are warm (continued boosting on the new rulings plus a replay sample,
0.12s) with a full nested refit (inner OOF -> isotonic + threshold, 1.3s) every 25 rulings. Replay of the last 60%
of the snapshot in time order (587 initial passes, 880 replayed, rulings arrive 1h after pass end, refit every 2h):

| Mode | Auto "failed" calls | Precision (Wilson CI) | Failures auto-decided, bucket 1 -> 4 | Overall |
|---|---|---|---|---|
| frozen | 93 | 0.925 | 18.5% -> 19.8% -> 21.4% -> 28.9% | 22.2% |
| rulings feed history only | 90 | 0.944 (0.876–0.976) | 18.5% -> 20.8% -> 19.4% -> 28.9% | 22.0% |
| **warm refit** | 103 | 0.932 (0.866–0.967) | 18.5% -> 23.6% -> 24.3% -> **32.0%** | 24.8% |
| full refit every 2h | 36 | 0.917 (0.782–0.971) | 18.5% -> 15.1% -> 0.0% -> 2.1% | 8.5% |

Warm refits add about 3 points of failure coverage over the frozen model in each later bucket at similar precision.
Full refits on escalated-only rulings collapse coverage: escalations are the hard cases, so adding only them makes
the in-fold Wilson bound fail and the gate stops auto-deciding. That is why production uses warm steps plus full
refits on the whole store (scheduled retrain below), not full refits on rulings alone. The replay precision (0.93)
is below the 0.95 target; the gate is not yet proven at 0.95 on a small initial training set.

**Serving.**

```python
from ml import final_model as fm
out = fm.score_observations(new_passes_df, recent_passes_df)   # SatNOGS-shaped rows
# -> pass_id, model_version, failure_probability, route ("auto"/"human"), decision, confidence_percent, features
from ml.hitl import ingest_labeled_decision
ingest_labeled_decision(out[0]["features"], "failed", pass_id=out[0]["pass_id"], reviewer="ops")
```

`confidence_percent` feeds `confidence_gate::process_claim_decision`: auto calls carry the measured held-out
precision (≥ 95), escalations are capped at 94 (clears the 0.90 operating point) or 79.

**Continuous collection and scheduled retrain.** `ml/satnogs_fetcher.py` replaces the three earlier fetchers
(`fetch_labeled.py` is now a thin shim). It keeps a rolling-hour request budget (70/h, spread evenly, persisted
across restarts), sleeps the server's `Retry-After` on 429 and lowers the budget, checkpoints every page, dedupes by
id, fetches only resolved statuses (one listing per status, ~40% fewer requests; features ignore unresolved passes
either way), crawls the forward edge (now − 72h) first and then backfills, re-fetches hours after 10 days to pick
up late vetting, refreshes Kp (GFZ definitive + NOAA SWPC recent) every 3h and SatNOGS DB TLEs every 6h, and
fetches metadata only for stations it has not seen. Every 6h (default) it runs
`python -m ml.final_model retrain --scheduled` when the labeled count has grown 10%.

```bash
ml/run_collector.sh                       # restart loop; run under tmux/nohup
sudo cp ml/systemd/ground-truth-collector.service /etc/systemd/system/ && sudo systemctl enable --now ground-truth-collector
python -m ml.satnogs_fetcher status       # hours stored, labeled count, requests, 429s
python -m ml.final_model evaluate         # ml/reports/final_v3.{md,json} + PR curves
python -m ml.hitl simulate                # ml/reports/hitl_v3.{md,json,png}
python -m ml.final_model train            # ml/models/final/
```

### Architecture (v1.x)

```
/ml
├── satnogs_fetcher.py   # v3: unified resumable collector daemon (Kp, TLEs, stations, scheduled retrain)
├── causal_features.py   # v3: physics + label-latency-aware history features
├── final_model.py       # v3: evaluation, gated LightGBM, training, serving
├── hitl.py              # v3: human-in-the-loop ingest + replay simulation
├── fetch_labeled.py     # shim over satnogs_fetcher (kept for datasets.load_window / verify_labels)
├── datasets.py          # Labeled datasets + leakage-safe physical / station-state features
├── heldout_eval.py      # Random vs station-grouped vs time split, nested threshold tuning
├── gate.py              # Score -> confidence_percent for confidence_gate.rs
├── verify_labels.py     # Compare v1.1.0 labels with an unfiltered re-fetch
├── train.py             # --pipeline heldout (v1.2+) or legacy (v1.0/v1.1)
├── score.py             # Scoring with SHAP explanations and gate fields
├── data_loader.py       # Legacy loader + synthetic augmentation (legacy pipeline only)
├── features.py          # Legacy feature engineering (station_id removed)
├── models/              # Model artifacts (v1.2.0 adds calibrator + PR curve)
├── reports/             # Held-out evaluation tables, JSON and PR curves
└── tests/
```

### Training data and its problems

`data/processed/passes_features.parquet` holds 3,500 real SatNOGS observations.
Its statuses are real SatNOGS values, but the 2,000 good / 1,000 bad / 500 failed
split was set by hand: v1.1.0 fetched each status separately, newest first,
until a quota was reached. As a result:

- The class ratio is chosen, not observed. Unvetted (`unknown`) passes, roughly
  40% of all passes, are excluded entirely.
- Each class covers a different time window. Bad passes go back to Oct 22 20:38,
  good to Oct 23 06:01 and failed only to Oct 23 21:17. Kp, and anything else that
  varies with time, therefore leaks the label. On this data `kp_max_6h` becomes the
  top feature.
- `bad` is set by a human vetter, while `good` is set automatically when decoded
  frames exist. A pass labelled `bad` therefore also means someone vetted it.

From Oct 23 21:17:20 onward, all three statuses were fetched completely, so that
window (1,559 passes, 253 stations: 815 good, 500 failed, 244 bad) has no
class-window bias. v1.2.0 trains on it, and `ml/reports/heldout_v110_census.md`
is the evaluation to rely on. `fetch_labeled.py` now fetches every status per time
slice. Anonymous API access allows about 60 requests (1,500 observations) per hour.

Failures are dominated by station outages. After a `failed` pass, 90% of the same
station's next passes also fail, and 61 stations failed every pass in the window.

### Features (v1.2.0)

- **Pass geometry**: max elevation, duration, margin above the station's elevation mask (`min_horizon`)
- **Station hardware/location**: latitude, longitude, altitude, antenna type, station age.
  There is no station ID.
- **Radio**: downlink frequency (log) and band, transmitter mode
- **Space weather / time**: GFZ Kp at pass time and the 6h max, Kp × latitude, solar elevation and day/night
- **TLE age**: only for slices from the new fetcher; the v1.1.0 parquet has no TLEs
- **Station state, past only**: over the station's passes that ended at least 1h before this
  pass starts, the fraction and recency of `failed` passes. `failed` (no artifacts uploaded)
  is known within that lag; `bad` waits for a vetter and is never used. In production the caller
  must supply `recent_*_lag1h` from its own record of the station's passes.

An in-fold station target encoding is implemented as `physical+history`. It helps on random and
time splits but hurts on unseen stations, so v1.2.0 does not use it.

### Held-out metrics (census window, failure = bad or failed, base rate 0.48)

At a 0.5 threshold:

| Model | Split | AUC | Precision | Recall | F1 | Accuracy |
|---|---|---|---|---|---|---|
| v1.1.0 features + station ID | random 5-fold | 0.85 | 0.75 | 0.75 | 0.75 | 0.76 |
| v1.1.0 features + station ID | **held-out stations** | **0.71** | 0.70 | 0.40 | 0.51 | 0.63 |
| v1.2.0 (physical + station state, isotonic) | random 5-fold | 0.89 | 0.81 | 0.77 | 0.79 | 0.80 |
| v1.2.0 | **held-out stations** | **0.85** | 0.79 | 0.73 | 0.76 | 0.78 |
| v1.2.0 | time (last 30%) | 0.92 | 0.88 | 0.76 | 0.82 | 0.83 |

The v1.1.0 figure of AUC 0.89 / accuracy 0.82 came from a random split, with early stopping
on the test set, on the quota-sampled data.

With precision targets on held-out stations (5-fold GroupKFold), each threshold is chosen on
inner station-grouped out-of-fold predictions of the training fold and then measured once on the
outer fold:

| Target | Measured precision (95% CI) | Recall | Recall on failed / bad | Flagged |
|---|---|---|---|---|
| 0.90 | 0.908 (0.87–0.93) | 0.45 | 0.59 / 0.17 | 369 |
| 0.95 | 0.953 (0.92–0.97) | 0.35 | 0.51 / 0.03 | 274 |
| 0.98 | 0.967 (0.93–0.99) | 0.20 | 0.29 / 0.00 | 153 |

Per-fold precision at the 0.95 target ranges from 0.91 to 1.00. The v1.1.0 feature set with
station ID never reaches 0.90 precision on held-out stations at any threshold that flags 20 or more
passes, even when the threshold is tuned on the test folds. Full tables,
confusion matrices and PR curves are in `ml/reports/` and `ml/models/pr_curve_v1.2.0.png`.

What helped, from the ablation in `ml/reports/heldout_v110_census_ablation.md`:

- **Past-only station state** is the only large gain: held-out-station AUC goes from 0.755 to 0.855,
  and recall at 0.95 precision from about 0 to 0.35–0.39.
- **Frequency/band and transmitter mode** help a little (about +0.02 AUC, +3–5 points of recall).
- **Kp, day/night, geometry and station hardware** make no measurable difference on this data. Kp
  only ranges from 1.3 to 4.3 within the 12h window, so its effect is untested rather than shown
  to be zero.
- **Class weighting and isotonic calibration** change held-out precision and recall by less than
  the confidence interval. Calibration is kept because the gate needs meaningful probabilities.

### Confidence gate

`score.py` emits `gate_confidence_percent` and `gate_route` for
`confidence_gate::process_claim_decision`, which auto-decides at confidence ≥ 95 and escalates
everything else to a human. A "pass failed" call is sent as ≥ 95 only when its calibrated score
clears the lowest threshold whose *measured* held-out-station precision is ≥ 0.95. In v1.2.0 that
threshold is 0.923, at 0.953 measured precision and 0.35 recall. Every other call, including every
"pass was fine" call, escalates: passes that clear only the 0.90 operating point carry its measured
precision capped at 94, and the rest carry the calibrated probability capped at 79.

### Running the ML Pipeline

```bash
pip install -r ml/requirements.txt
python -m ml.fetch_labeled --start 2026-10-05 --end 2026-10-22 --hours-per-day 4  # optional, rate limited
python -m ml.heldout_eval --dataset v110_census       # or v110, window, window_census
python -m ml.heldout_eval --dataset v110_census --variants ablation --splits station,time
python -m ml.train --version v1.2.0                   # heldout pipeline (default)
python -m ml.train --pipeline legacy --version v1.1.x # old pipeline, station_id removed
python -m ml.score --input passes.json --output predictions.json
pytest ml/tests/ -v
```

### Output Format

Each prediction includes:
- `failure_probability`: calibrated probability in [0.0, 1.0] (v1.2+)
- `estimated_loss_cents`: failure_probability × pass_value_cents
- `shap_contributions`: per-factor explanations (raw model log-odds)
- `model_version`: version string for the audit trail
- `gate_confidence_percent`, `gate_route` (v1.2+): inputs for the confidence gate

### SpacetimeDB Integration

The `model_prediction` table stores predictions with SHAP breakdown:

| Column | Type | Description |
|--------|------|-------------|
| `pass_id` | u64 | Reference to pass table |
| `model_version` | String | Model version for audit |
| `failure_probability` | f32 | Predicted failure prob |
| `estimated_loss_cents` | i64 | Expected dollar loss |
| `shap_factors` | Vec | Top contributing factors |

Use these reducers to insert predictions:
- `insert_model_prediction` - Single prediction
- `batch_insert_predictions` - Batch insert from JSON
- `register_model_version` - Register new model with metrics

Decision records reference `model_version` to maintain audit trail.

### Extending with More Data

`python -m ml.fetch_labeled` writes unfiltered time slices to `data/raw/satnogs_window/`
(gitignored). `python -m ml.train` then trains on the census window plus any slices whose passes
ended at least 24h before they were fetched, which gives vetting time to settle. Run
`python -m ml.verify_labels` to compare slices that overlap the v1.1.0 data against its labels.

## Mock Data Note

All financial data is simulated from the seed inputs described in [Seeded volume](#seeded-volume). In production, the passes, contracts and ledger would come from real scheduling and billing systems.

## License

MIT
