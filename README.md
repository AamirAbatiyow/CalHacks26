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
| `kpi` | Financial KPIs (mock data) |
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
├── __init__.py          # Module initialization
├── data_loader.py       # SatNOGS data loading + synthetic augmentation
├── features.py          # Feature engineering
├── train.py             # Training pipeline
├── score.py             # Scoring with SHAP explanations
├── models/              # Saved model artifacts
│   ├── model_v1.0.0.lgb
│   ├── config_v1.0.0.json
│   └── metrics_v1.0.0.json
├── tests/
│   └── test_model.py    # Unit tests
└── requirements.txt     # Python dependencies
```

### Features

The model uses the following features:
- **Pass geometry**: max elevation, duration, satellite inclination/period/apogee
- **Space weather**: Kp index, solar flare class (None/C/M/X)
- **Local weather**: cloud cover, precipitation, temperature, humidity, wind speed
- **Station**: latitude, longitude (high-latitude aurora risk)
- **Derived**: elevation bins, short pass flag, Kp-latitude interaction

### Model Metrics (v1.1.0)

| Metric | Value |
|--------|-------|
| AUC-ROC | **0.89** |
| AUC-PR | 0.87 |
| Brier Score | 0.13 |
| ECE (Calibration) | 0.04 |
| Accuracy | 0.82 |

**Training Data**: 3,500 real labeled SatNOGS observations
- Good passes: 2,000
- Bad/Failed passes: 1,500

### Running the ML Pipeline

**Install dependencies:**
```bash
pip install -r ml/requirements.txt
```

**Train a model:**
```bash
python -m ml.train --samples 3000 --version "v1.0.0"
```

**Score passes:**
```bash
python -m ml.score --demo  # Demo with synthetic data
python -m ml.score --input passes.json --output predictions.json
```

**Run tests:**
```bash
pytest ml/tests/ -v
```

### Output Format

Each prediction includes:
- `failure_probability`: Float [0.0, 1.0]
- `estimated_loss_cents`: failure_probability × pass_value_cents
- `shap_contributions`: Per-factor explanations (e.g., {"Kp Index": +0.15, "Max Elevation": -0.08})
- `model_version`: Version string for audit trail

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

To train on more real data:
1. Run the data pipeline: `python -m pipeline.run --obs-limit 10000`
2. Retrain: `python -m ml.train --samples 10000 --version "v2.0.0"`

The model will use real data when available and fall back to synthetic augmentation.

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

```python
import joblib
from ml.conformal_ensemble import build_features, load_station_meta
model = joblib.load("ml/models/model_v2.0.0-conformal.joblib")
out = model.predict(build_features(passes_df, load_station_meta()), policy="demo")
# out: failure_probability, decision (FAIL / OK / ABSTAIN), fail_in_set, ok_in_set, alpha
```

## Mock Data Note

All financial data (KPIs, revenue figures) is mock data for demonstration purposes. In production, these would connect to actual billing systems.

## License

MIT
