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

### Decision Replay
Click any decision (an Audit row, the Claim page decision card, or **Replay path** in Approvals) to replay that one decision's path through the pipeline. Only the stages it actually took are drawn, one at a time, with each node's output (confidence, Cedar verdict, injection screen, System 2 rationale, re-verify checks, the human's credit, the retrained model version, and any policy proposal). Branches not taken show as faint stubs.

- Controls: play/pause (space), step back/forward (← / →), 0.5x–4x speed, Replay (R), close (Esc).
- Deep link: `#/<page>?replay=<key>`, where key is `audit:<decision_record id>`, `claim:<claim id>` or `approval:<escalated_claim id>`.
- Data: `web/src/replay/adapter.ts` normalizes `decision_record`, `claim_decision` and `escalated_claim` rows into a typed `DecisionTrace`. When the decision pipeline's per-step audit path is available, `usePipelineSteps()` in `web/src/replay/useDecisionTrace.ts` returns it and `buildTrace` uses it. Otherwise the replay shows a deterministic seeded example path, marked "seeded path" in its header.
- Built with React Flow (`@xyflow/react`), Motion and dagre (left-to-right layout). A single motion value drives the whole timeline, so playback does not re-render React per frame.

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

## Mock Data Note

All financial data is simulated from the seed inputs described in [Seeded volume](#seeded-volume). In production, the passes, contracts and ledger would come from real scheduling and billing systems.

## License

MIT
