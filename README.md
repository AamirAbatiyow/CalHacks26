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

### Architecture

```
/ml
├── fetch_labeled.py     # SatNOGS fetch: every status per time slice (no per-status quotas)
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

### Abstaining Model: Calibrated Ensemble + Split Conformal (v2.0.0-conformal)

`ml/conformal_ensemble.py` and `ml/train_conformal.py` add an alternative model that returns one of three decisions per pass: **FAIL** (confident failure), **OK** (confident success), or **ABSTAIN** (escalate to a human).

- **Model**: CatBoost (60%) + spline/one-hot logistic regression (40%), probability-averaged, isotonic-calibrated.
- **Abstention**: class-conditional (Mondrian) split conformal. A pass is auto-decided only when its conformal set is a single label; `{fail, ok}` or `{}` escalates. Calibration is cross-fitted. Four station-grouped fold models produce out-of-fold scores, and isotonic calibration plus the conformal thresholds are fit on those scores.
- **Evaluation**: nested `GroupKFold(5)` by station, so every reported number is on stations the model never saw. The satellite encodings, models, calibration and alpha selection all use only the outer-train stations.
- **Policies**: `demo` picks a single alpha that targets about 15% escalation. `precision_0.XX` picks per-class alphas that maximize coverage while keeping calibration precision ≥ 0.XX.

**Leaks removed.** `station_id` and the station name are not features. `kp_at_time` is dropped because the labeled fetch pulls the newest N passes *per status*. Each class therefore spans a different time window (before 06:00 UTC on Oct 23 the data contains only `bad` passes, and `failed` passes only appear after 21:17 UTC), so Kp, `start_time` and `pass_id` all encode the label. Weather columns are 100% null. Station `status` and `last_seen` were snapshotted after the passes ran, so they are excluded; adding `status` did not help anyway. Station identity is replaced by station hardware: antennas, bands, minimum horizon, altitude, age, and elevation margin over the horizon. Satellite outcome history is added as smoothed target encodings computed from training stations only.

**Headline evaluation set.** The 1,530 passes (251 stations) inside the time window where all three statuses were sampled completely, so the class mix is not an artifact of collection order. Run `python -m ml.train_conformal`.

| Held-out stations (1,530 passes, 48.4% fail) | Value |
|---|---|
| AUC-ROC (ensemble score) | 0.826 |
| AUC-ROC (after isotonic) / Brier / ECE | 0.818 / 0.176 / 0.059 |
| No-abstain accuracy @ 0.5 | 0.737 (cm `[[606,183],[219,522]]`) |

| Policy (alpha picked on training stations) | Escalation | Coverage | Precision FAIL | Precision OK | Accuracy on auto | Recall FAIL (all fails) | Auto confusion TP / FP / TN / FN |
|---|---|---|---|---|---|---|---|
| `demo` (target 15% escalation) | 17.3% | 82.7% | 0.775 | 0.822 | 0.798 | 0.671 | 497 / 144 / 513 / 111 |
| `precision_0.85` | 62.0% | 38.0% | 0.904 | 0.836 | 0.875 | 0.405 | 300 / 32 / 209 / 41 |
| `precision_0.90` | 82.7% | 17.3% | 0.931 | 0.688 | 0.860 | 0.236 | 175 / 13 / 53 / 24 |
| `precision_0.95` | 95.4% | 4.6% | 0.983 | 0.692 | 0.930 | 0.077 | 57 / 1 / 9 / 4 |
| `precision_0.98` | 100% | 0% | – | – | – | 0 | no auto-decisions |

**What this means**

- **The 95% and 98% precision targets cannot be met at 5–20% escalation.** At the demo operating point, about 80% of auto-decisions are correct. FAIL calls exceed 95% precision only for the most confident 3–4% of passes (α ≤ 0.005: 53 calls, 96% precision), so hitting that target means escalating almost everything.
- **Conformal coverage holds.** Per-class set coverage on held-out stations is 0.85 for fail and 0.82 for ok at the demo alphas (0.175–0.25). The conformal guarantee is about coverage, not precision; precision comes from how well the model separates the classes.
- **OK calls are less reliable on new stations than the calibration folds suggest.** Wrong OK calls are almost all `failed` passes, where the station produced no data. That is station health, which a held-out station gives no way to anticipate.
- **Satellite history carries most of the signal.** Without it, AUC drops to 0.716. Inside the clean window the encodings come from passes of the same satellite at other stations during the same 11.5-hour period. A deployment would have to use trailing history instead, which should be somewhat weaker.
- **Training on all 3,500 passes** (`--window all`) gives AUC 0.850 and, at 14.9% escalation, FAIL precision 0.773, OK precision 0.861 and 0.820 accuracy. These numbers are optimistic because of the collection-window artifact described above.
- Fold-to-fold spread is large (±5–10 points in precision), because each fold holds out about 50 stations.

#### v3 experiments (time-uniform data, past-only features). Work in progress, small sample

`ml/fetch_uniform.py` re-fetches SatNOGS with every status taken from the same time blocks: ten 8-hour blocks spaced across Aug 23 to Oct 14. `ml/uniform_data.py` builds features that use only information available before the pass:

- **Station health** from the station's own past passes, using only passes that ended at least 1 hour before this one.
- **Co-observation** of the same satellite at other stations under the same lag rule.
- **Transmitter status**, used only when its `updated` timestamp predates the pass.
- **Orbit and radio context:** TLE age, frequency versus antenna range, culmination margin, and Kp from GFZ.

Fields written after the pass (`client_metadata`, waterfall, vetting, `status_certainty`) are never used. Run `python -m ml.experiments_v3` to reproduce; full results are in `ml/models/experiments_v3.json`.

**Data limits:** the SatNOGS observations API allows about 50 requests per 35 minutes and ignores `page_size`, so only part of block 1 is fetched: **794 labeled passes, 187 stations**, 51% good, 26% failed (no data), 23% bad. The station × future-time split needs at least two blocks, so it has not run yet. Every number below comes from held-out stations within a single 8-hour block, and fold std is ±0.03–0.10, so most differences between experiments are within noise.

| Held-out stations, ~17% target (α picked on training OOF) | AUC | Escalation | Acc (auto) | Prec FAIL | Prec OK | Recall FAIL (all) |
|---|---|---|---|---|---|---|
| E0 v2 recipe (hardware + satellite TE) | 0.765±0.023 | 23.3% | 0.759±0.033 | 0.758 | 0.759 | 0.609 |
| E1 + Kp, time of day | 0.769±0.022 | 22.5% | 0.771±0.023 | 0.771 | 0.770 | 0.630 |
| E2 + past-only station health | 0.831±0.037 | 20.0% | 0.813±0.034 | 0.817 | 0.808 | 0.684 |
| E2c = E2 without satellite TE (strictly causal) | 0.747±0.076 | 22.3% | 0.713±0.067 | 0.721 | 0.704 | 0.622 |
| E3 causal co-observation + transmitter status (no TE) | 0.761±0.068 | 20.9% | 0.721±0.058 | 0.717 | 0.727 | 0.630 |
| E4 + TLE age, band vs antenna, margins | 0.761±0.067 | 21.4% | 0.724±0.061 | 0.716 | 0.734 | 0.614 |
| E5a stacked CatBoost + XGBoost + LR | 0.754±0.063 | 18.9% | 0.750±0.064 | 0.752 | 0.748 | 0.642 |
| E5b + beta-binomial station / satellite prior | 0.760±0.066 | 21.9% | 0.734±0.060 | 0.730 | 0.738 | 0.601 |
| E5c + group Mondrian (history bucket × band) | 0.760±0.066 | 22.2% | 0.725±0.067 | 0.722 | 0.729 | 0.645 |
| E6 two-stage (no-data / bad-signal) | 0.760±0.077 | 24.4% | 0.647±0.050 | 0.632 | 0.695 | 0.751 |
| X1 NON-CAUSAL: + same-pass outcomes at other stations | 0.821±0.042 | 18.0% | 0.802±0.043 | 0.782 | 0.823 | 0.679 |

| Held-out stations, 0.95 precision target | Coverage | Acc (auto) | Prec FAIL | #FAIL / #OK calls |
|---|---|---|---|---|
| E0 v2 recipe | 1.9%±3.5 | 0.800 | 0.846 | 13 / 2 |
| E2 + station health (with TE) | 15.1%±5.3 | 0.950 | 0.957 | 117 / 3 |
| E2c station health, causal | 13.2%±8.2 | 0.981 | 0.990 | 100 / 5 |
| E3 causal co-observation | 13.2%±8.8 | 0.971 | 0.989 | 93 / 12 |
| E4 better features | 11.1%±6.4 | 0.977 | 0.988 | 83 / 5 |
| E5a stacked | 11.8%±7.6 | 0.957 | 0.988 | 83 / 11 |
| E6 two-stage | 13.6%±7.3 | 0.944 | 0.951 | 102 / 6 |

What this shows so far:

- **The satellite target encoding behind E0–E2 and v2 is not time-causal.** Within a block it uses the same satellite's outcomes at other stations, including later passes. E2's apparent gain disappears once it is removed (E2c), and its numbers track X1, the explicitly non-causal triage ablation.
- **Past-only station health does not raise accuracy at 17% escalation on this sample, but it makes the high-precision mode real.** At the 0.95 target, coverage goes from about 2% (v2 recipe) to 11–15%, with FAIL precision about 0.99. Almost all of those calls are confident "no data" failures at stations with recent outages. Confident OK calls stay too rare to meet the target.
- **Stacking, the Bayesian prior, group Mondrian and the extra features** are within noise of each other on 794 passes. Two-stage routing is worse at 17% escalation, because the per-stage alpha search over-calls FAIL, though it is comparable at the 0.95 target.
- **The causal demo number on this data** is about 0.72 accuracy on auto-decided passes at 21–22% realized escalation (E3/E4). The v2 figure of 0.798 accuracy at 17.3% escalation is optimistic for the same TE reason.

```python
import joblib
from ml.conformal_ensemble import build_features, load_station_meta
model = joblib.load("ml/models/model_v2.0.0-conformal.joblib")
out = model.predict(build_features(passes_df, load_station_meta()), policy="demo")
# out: failure_probability, decision (FAIL / OK / ABSTAIN), fail_in_set, ok_in_set, alpha
```

## Mock Data Note

All financial data is simulated from the seed inputs described in [Seeded volume](#seeded-volume). In production, the passes, contracts and ledger would come from real scheduling and billing systems.

## License

MIT
