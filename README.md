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
| `kpi` | Financial KPIs; credits paid and recovered are kept equal to the ledger totals |
| `escalated_claim` | Approvals queue: claims the confidence gate escalated for human review |
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
| `seed_space_weather` | Add space weather data |
| `set_playback_speed` | Set simulation speed (1x/4x/16x) |
| `set_playback_playing` | Play/pause simulation |
| `seek_to_time` | Jump to specific time |
| `go_live` | Return to live time |
| `record_decision` | Log an AI decision with policy/model versions |
| `update_kpi` | Update financial KPIs |
| `seed_finance_history` | Seed audit decisions and ledger entries against already-seeded passes |
| `seed_escalated_claim` | Add a claim to the Approvals queue (only if the confidence gate escalates it) |
| `approve_escalated_claim` / `deny_escalated_claim` / `edit_escalated_claim` | Human decisions on escalated claims |
| `seek_replay` | Jump a policy replay to a given claim |

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
`confidence_gate::process_claim_decision`. A "pass failed" call is sent as confidence ≥ 95 (auto)
only when its calibrated score clears the lowest threshold whose *measured* held-out-station
precision is ≥ 0.95. In v1.2.0 that threshold is 0.923, at 0.953 measured precision and 0.35
recall. Scores that clear only the 0.90 operating point get the measured precision capped at 94,
which routes to human approval. Everything else, including every "pass was fine" call, gets a
confidence below 80 and is escalated. The gate's $300 amount cap still applies.

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

All financial data (KPIs, revenue figures) is mock data for demonstration purposes. In production, these would connect to actual billing systems.

## License

MIT
