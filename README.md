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

## Mock Data Note

All financial data (KPIs, revenue figures) is mock data for demonstration purposes. In production, these would connect to actual billing systems.

## License

MIT
