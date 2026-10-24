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

### v3.2.0: policy layer on top of v3.1.0

`ml/policies.py` wraps the unchanged v3.1.0 model in an ordered, first-match list of auto-decide policies, each a
conjunction of thresholds with an effect (`failed` or `ok`). Passes no policy matches go to a human. Policies are
decided at pass end + label lag (1h), so besides the v3.1.0 features they can use:
- the pass's own uploads (audio, waterfall, decoded frames);
- station / satellite / transmitter outcome history as of end + lag (`dt_*`);
- co-observation (`co_*`: overlapping passes of the same satellite at other stations, and of the same station).

Another pass counts only if its outcome was known by then, under the same label-latency model as v3.

Every threshold and mined rule is fit inside the training fold. Each stage is tuned on the training passes no
earlier stage decided. Candidates, in order:

| Group | Policy | Effect | In-fold tuning |
|---|---|---|---|
| ops evidence (own pass) | no audio and no waterfall uploaded | failed | none |
| ops evidence (own pass) | ≥ k decoded frames uploaded | ok | k ∈ {1, 2, 5} |
| physics | max elevation ≤ X° while Kp ≥ Y | failed | X ∈ {10..30}, Y ∈ {3, 4, 5} |
| ops history | station outage streak ≥ N at end + lag | failed | N ∈ {1..6} |
| ops history | ≥ N overlapping passes on the same station with no artifacts | failed | N ∈ {1, 2, 3} |
| physics | TLE age ≥ D days | failed | D ∈ {7, 14, 30, 60} |
| model | v3.1.0 raw score ≥ t | failed | t: Wilson80 rule on passes reaching the gate |
| learned | 1–2 condition rules mined by sequential covering | either | must clear Wilson80 ≥ 0.95 on both halves of a station split |
| learned | stage-2 gated LightGBM on all decision-time features | either | Wilson80 rule on passes reaching it |

A hand rule is enabled in a fold only if its best setting has ≥ 20 training passes and a Wilson 80% lower bound
≥ 0.95. Each policy's test decisions are then scored. A policy is kept only if:
- it is ≥ 0.95 precise in every test split where it fires;
- its precision pooled over both tests has a Wilson 80% lower bound ≥ 0.95;
- the final list still meets the target on each auto-decided side in both tests (otherwise the weakest kept
  policy is dropped).

That last selection step looks at the test folds, so the kept-policy numbers are slightly optimistic.

**Tier A vs tier B.** SatNOGS marks a pass `failed` when no audio or waterfall arrives, and auto-vets passes with
decoded frames as `good`. The two own-pass evidence rules therefore largely restate how the label is produced.
- Tier A excludes them and every `own_*` feature.
- Tier B includes them.

For Ground Truth claims they are legitimate checks: did the station upload anything, did it decode the
satellite. But tier B is not a prediction, and is reported separately.

**Results (lag 1h, 3,604 passes, 350 stations, `ml/reports/policies_v3_2.md`).** The v3.1.0 row is failed-side only,
as deployed (v3.1.0 has no OK threshold), so its escalation is 89.5% on held-out stations rather than the 87.4% in
the v3.1.0 table, which counted an in-fold OK side.

| Configuration | Split | Auto "failed": n / precision / 95% CI / LB80 | Auto "ok": n / precision / 95% CI / LB80 | Coverage | Escalated | Accuracy on auto-decided (95% CI) | Target met |
|---|---|---|---|---|---|---|---|
| v3.1.0 only | held-out stations | 380 / 0.979 / 0.959–0.989 / 0.967 | 0 | 10.5% | 89.5% | 0.979 (0.959–0.989) | yes |
| v3.1.0 only | future time | 157 / 0.981 / 0.945–0.993 / 0.961 | 0 | 14.5% | 85.5% | 0.981 (0.945–0.993) | yes |
| tier A, all candidates | held-out stations | 448 / 0.931 / 0.903–0.951 / 0.914 | 45 / 0.978 / 0.884–0.996 / 0.929 | 13.7% | 86.3% | 0.935 | **no** |
| tier A, all candidates | future time | 159 / 0.975 / 0.937–0.990 / 0.953 | 0 | 14.7% | 85.3% | 0.975 | yes |
| tier A, kept (= v3.1.0 gate only) | both | same as v3.1.0 only | | | | | yes |
| tier B, all candidates | held-out stations | 523 / 0.998 / 0.989–1.000 / 0.994 | 1144 / 0.993 / 0.986–0.996 / 0.989 | 46.3% | 53.7% | 0.995 | yes |
| tier B, all candidates | future time | 217 / 1.000 / 0.983–1.000 / 0.992 | 347 / 0.997 / 0.984–0.999 / 0.990 | 52.2% | 47.8% | 0.998 | yes |
| **tier B, kept (v3.2.0)** | **held-out stations** | **510 / 0.998 / 0.989–1.000 / 0.993** | **1144 / 0.993 / 0.986–0.996 / 0.989** | **45.9%** | **54.1%** | **0.995 (0.990–0.997)** | yes |
| **tier B, kept (v3.2.0)** | **future time** | **217 / 1.000 / 0.983–1.000 / 0.992** | **347 / 0.997 / 0.984–0.999 / 0.990** | **52.2%** | **47.8%** | **0.998 (0.990–1.000)** | yes |

For v3.2.0 on held-out stations:
- Recall on `failed` passes 79.9%, on `bad` passes 2.1%.
- 57.6% of OK passes auto-cleared.
- Future-time test passes from stations never seen in training (33): 9 failed calls and 11 OK calls, all
  correct, 39.4% escalated.

Per-policy contribution (lag 1h, all candidates, first match wins). "Lost if removed" re-runs the list without
that policy, and "folds" counts the folds (of 5 station folds / 1 time split) where in-fold tuning enabled it:

| Tier | Policy | Effect | Held-out stations: decided / precision (95% CI) / coverage added / lost if removed / folds | Future time: same | Kept |
|---|---|---|---|---|---|
| B | no artifacts uploaded | failed | 477 / 1.000 (0.992–1.000) / 13.2% / 11.1% / 5 | 167 / 1.000 (0.978–1.000) / 15.4% / 7.8% / 1 | yes |
| B | decoded frames uploaded (k = 1) | ok | 1144 / 0.993 (0.986–0.996) / 31.7% / 31.7% / 5 | 347 / 0.997 (0.984–0.999) / 32.1% / 32.1% / 1 | yes |
| B | v3.1.0 gate, re-tuned on passes reaching it | failed | 33 / 0.970 (0.847–0.995) / 0.9% / 0.9% / 2 | 50 / 1.000 (0.929–1.000) / 4.6% / 4.6% / 1 | yes (pooled 82/83) |
| B | stage-2 model | failed | 13 / 1.000 (0.772–1.000) / 0.4% / 0.4% / 3 | – / 0 | no (pooled LB80 0.89) |
| A | v3.1.0 gate | failed | 253 / 0.988 (0.966–0.996) / 7.0% / 7.0% / 5 | 118 / 0.983 (0.940–0.995) / 10.9% / 10.9% / 1 | yes |
| A | station outage streak (decision time) | failed | 195 / 0.856 (0.800–0.899) / 5.4% / 3.9% / 2 | 41 / 0.951 (0.839–0.987) / 3.8% / 1.1% / 1 | no |
| A | stage-2 model | ok | 45 / 0.978 (0.884–0.996) / 1.2% / 1.2% / 2 | – / 0 | no |
| A, B | low elevation in storm, stale TLE | failed | never enabled (no setting cleared the in-fold bound; Kp never exceeded 4 in this window) | | no |
| A, B | simultaneous drop on station | failed | never applies: SatNOGS stations never run overlapping observations | | no |
| A, B | mined 1–2 condition rules | either | none passed the two-half station validation (one fold, 5 calls) | | no |

**Why not 17% escalation.** After the two evidence rules, the remaining 1,983 passes (55%) all uploaded a
waterfall but no decoded frames: 1,012 `bad`, 837 `good` and 134 `failed`. Whether such a waterfall shows signal
is exactly what the SatNOGS vetter decides. Nothing we store separates `bad` from `good` there at 0.95:
- pre-pass physics;
- station, satellite and transmitter history up to end + lag;
- co-observation by other stations.

The model gate and stage-2 model add only 1–5 points. Reaching ~17% would mean auto-deciding about 70% of that
group, which needs the waterfall image itself (signal detection on the waterfall PNG), not more rules. With 3h
label latency, tier B keeps only the two evidence rules (54.7% / 53.1% escalated, same precision). Tier A keeps
nothing: the v3.1.0 gate is 0.904 precise at 3h.

**Records and serving.** `python -m ml.policies train` fits the kept policies on all 3,604 passes around the
v3.1.0 booster (identical weights; only the gate threshold is re-picked on passes the evidence rules leave: 0.946
vs 0.951). It writes `ml/models/final/policies_v3.2.0.json`. Each record has the app's `CedarRule` fields (`id`,
`policy_version_id`, `name`, `description`, `cedar_code`, `enabled`, `order_index`) plus conditions, training
support/precision and held-out precision, e.g.

```
permit(
  principal == GroundTruth::Actor::"ai_analyst",
  action == GroundTruth::Action::"auto_decide_failed",
  resource
) when {
  context.own_artifacts == 0
};
```

```python
from ml.policies import decide_observations
decide_observations(new_passes_df, recent_passes_df)
# -> pass_id, policy_version, model_version, route, decision ("failed"/"fine"/"uncertain"), rule_id, confidence_percent
```

The model registry still points at v3.1.0; v3.2.0 is a policy file on top of it.

```bash
python -m ml.policies evaluate   # ml/reports/policies_v3_2.{md,json}
python -m ml.policies train      # ml/models/final/policies_v3.2.0.json
```

### v3.1.0: final high-precision gate (current)

`ml/final_model.py` + `ml/causal_features.py` + `ml/hitl.py` + `ml/satnogs_fetcher.py` combine the three earlier ML
branches (PR #12 outage streaks, PR #17 past-only station health / co-observation, PR #18 physics features and
random-window sampling) into one strictly causal model whose only job is to auto-decide "this pass failed" when it
is very sure and escalate everything else to a human.

**Data.** One continuously running collector (`python -m ml.satnogs_fetcher daemon`, see below) stores whole UTC
hours of SatNOGS observations, so class mix is natural and every station's pass history is complete. Hours are
fetched 72h+ after the passes so `failed`/`good` have settled. Snapshot used for v3.1.0 (collector stopped at
18:00 UTC on 2026-10-24): 35 contiguous hours (2026-10-20 06:00 to 2026-10-21 17:00 UTC), 5,365 observations,
4,583 labeled, 356 stations. After dropping passes whose 1h+6h history window is not fully inside the store,
**3,604 labeled passes, 350 stations** (1,973 good, 1,020 bad, 611 failed; failure = bad or failed, base rate 0.45).
A commit-sized copy is in `data/processed/satnogs_store_snapshot.parquet`.

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

**Model and gate.** LightGBM (`full_causal`: physics + causal history), isotonic calibration. The
auto-"failed" threshold is picked *inside each training fold* on station-grouped out-of-fold scores: the lowest
threshold whose Wilson lower bound (z = 1.28) of inner precision is ≥ 0.95. Everything below it escalates. The
shipped v3.1.0 fit on all 3,604 passes uses raw score ≥ 0.951 (calibrated probability ≥ 0.904); no OK-side threshold
met the rule, so v3.1.0 only auto-decides failures and escalation rate = 1 − coverage.

**Held-out results (lag 1h, `ml/reports/final_v3.md`).**

| Split | Auto "failed" calls | Precision | 95% CI (Wilson) | 95% CI (station bootstrap) | Recall (all failures) | Recall `failed` / `bad` | Coverage | Escalated | AUC |
|---|---|---|---|---|---|---|---|---|---|
| Held-out stations (5 folds, 3,604 passes) | 380 | **0.979** | 0.959–0.989 | 0.960–0.997 | 22.8% | 39.0% / 13.1% | 10.5% | 87.4% | 0.873 |
| Future time (last 30%, 3h embargo; train 2,145, test 1,081) | 157 | **0.981** | 0.945–0.993 | 0.950–1.000 | 32.4% | 46.3% / 20.5% | 14.5% | 85.5% | 0.902 |
| Future time, stations unseen in training (33 passes) | 2 | 1.000 | 0.342–1.000 | – | 12.5% | – | – | – | – |

Per-fold precision on held-out stations: 0.979 (n=96), 1.000 (n=54), 0.985 (n=67), 1.000 (n=28), 0.963 (n=135);
in-fold thresholds 0.926–0.969. In the held-out-station evaluation the OK side also auto-cleared 74 passes at
0.959, so two-sided coverage is 12.6% and auto-decided accuracy 0.976 (87.4% escalated).

Comparison (same folds and rule; full table incl. other threshold rules in the report):

| Variant | Held-out stations: calls / precision / recall | Future time: calls / precision / recall |
|---|---|---|
| physics only | 15 / 1.000 / 0.9% | 81 / 0.926 / 15.8% |
| PR #12 station state + physics | 213 / 0.972 / 12.7% | 194 / 0.923 / 37.6% |
| **full causal (v3.1.0)** | **380 / 0.979 / 22.8%** | **157 / 0.981 / 32.4%** |
| full causal + monotone (v3.0.0 recipe) | 336 / 0.976 / 20.1% | 203 / 0.951 / 40.5% |
| full causal + monotone, outage-evidence only | 336 / 0.938 / 19.3% | 148 / 0.986 / 30.7% |
| transparent streak rule | 171 / 0.965 / 10.1% | 47 / 1.000 / 9.9% |

With 3h label latency history is thinner: v3.1.0's recipe makes 94 calls at 0.904 (0.828–0.949) on held-out stations
and none in the time split, while the monotone recipe holds up better (121 at 0.967 / 144 at 0.910). v3.1.0 is fit
for the 1h latency the System 1 worker sees; if outcomes arrive later, retrain with `--lag 3 --variant full_causal_mono`.

**v3.0.0 vs v3.1.0.** v3.0.0 (first push, 18 hours, 1,467 passes) used the monotone variant: 70 calls at 1.000
(0.948–1.000) on held-out stations, 52 at 0.962 (0.870–0.989) in the time split, 4.8% / 11.8% coverage. With 2.5x
the data the plain variant has the highest precision in both splits and twice the recall, so v3.1.0 switched.
v3.0.0 reports are kept as `ml/reports/final_v3_0_0.*` and `hitl_v3_0_0.*`, and its artifact stays in the registry.

Honest caveats: 35 hours over two days is still a small, single-season sample; the rule (`wilson80`) and variant
were chosen by comparing variants on these same folds, so the chosen model's numbers are slightly optimistic;
unseen-station precision in the time split rests on 2 calls. PR curves (the outage-evidence curve coincides with
the monotone one because it shares its calibrated score): `ml/reports/final_v3_pr_station.png`,
`ml/reports/final_v3_pr_time.png`.

**Human-in-the-loop (`ml/hitl.py`, `ml/reports/hitl_v3.md`).** Each human ruling on an escalated pass becomes a
labeled example *and* makes that pass's outcome known immediately to later passes' history features. The System 1
worker calls `ml.hitl.ingest_labeled_decision(features, label, pass_id=..., reviewer=...)`; it appends the ruling to
`ml/models/final/human_labels.jsonl`, refits, bumps the version (v3.1.0 -> v3.1.1 ...) and registers it in
`ml/models/final/registry.json`. Refits are warm (continued boosting on the new rulings plus a replay sample,
0.19s) with a full nested refit (inner OOF -> isotonic + threshold, 1.3s) every 25 rulings. Replay of the last 60%
of the snapshot in time order (1,442 initial passes, 2,162 replayed, rulings arrive 1h after pass end, refit every 2h):

| Mode | Auto "failed" calls | Precision (Wilson CI) | Failures auto-decided, bucket 1 -> 4 | Overall | Escalated |
|---|---|---|---|---|---|
| frozen | 215 | 0.981 (0.953–0.993) | 16.8% -> 20.2% -> 26.7% -> 24.0% | 22.0% | 90.1% |
| rulings feed history only | 210 | 0.976 (0.945–0.990) | 16.0% -> 21.5% -> 25.5% -> 22.3% | 21.3% | 90.3% |
| **warm refit** | 220 | **0.995 (0.975–0.999)** | 17.2% -> 22.3% -> 21.8% -> **30.0%** | 22.8% | 89.8% |
| full refit every 2h | 222 | 0.968 (0.936–0.985) | 13.0% -> 22.7% -> 22.2% -> 31.8% | 22.4% | 88.6% |

On the larger snapshot, warm refits keep precision above 0.95 in every bucket (0.98–1.00) and end 6 points above the
frozen model in the last bucket; full refits on rulings reach similar final coverage at lower precision. On the
first 18-hour snapshot (v3.0.0) the replay was below target (warm 0.932) and full refits collapsed coverage
because escalations are the hard cases, which is why production uses warm steps plus scheduled full refits on the
whole store rather than full refits on rulings alone.

**Serving.**

```python
from ml import final_model as fm
out = fm.score_observations(new_passes_df, recent_passes_df)   # SatNOGS-shaped rows
# -> pass_id, model_version, failure_probability, route ("auto"/"human"), decision, confidence_percent, features
from ml.hitl import ingest_labeled_decision
ingest_labeled_decision(out[0]["features"], "failed", pass_id=out[0]["pass_id"], reviewer="ops")
```

`confidence_percent` feeds `confidence_gate::process_claim_decision`: auto calls carry the measured held-out
precision (97 for v3.1.0), escalations are capped at 94 (clears the 0.90 operating point) or 79.

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
