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

#### Republishing and reseeding the production database (`ground-truth-aamir`)

Schema changes (new tables such as `attack_eval` and `attack_clearance`) need a clear-and-reseed. Run these from the repo root:

```bash
# 1. Start the worker first so it trains System 1 on the seeded history; the seed waits up to 60s
#    for that model before running Break It. The worker reconnects on its own when the database
#    is republished, so leave it running.
(cd worker && npm install && npm run generate && STDB_HOST=wss://maincloud.spacetimedb.com STDB_MODULE=ground-truth-aamir npm start)

# 2. In another terminal, republish with a clear (-c deletes all data) and reseed.
spacetime publish ground-truth-aamir --server maincloud -p server/spacetimedb -c -y
SPACETIMEDB_SERVER=maincloud SPACETIMEDB_MODULE=ground-truth-aamir bash server/seed.sh

# 3. Rebuild the web client against the new schema.
(cd web && npm run generate && npm run build)
```

The seed ends by running every Break It attack, so the page opens with the before and after comparison and the held storm-overclaim cluster ready for the live decision. To reset the live moment without a full reseed, run `spacetime call ground-truth-aamir --server maincloud seed_attack_fixtures` and then `run_all_attacks`; a promoted v7 stays promoted, so after a promotion only a clear-and-reseed brings the cluster back to held.

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
- Data: every decision reducer in `server/spacetimedb/src/decision.rs` appends a `pipeline_step` row (`server/spacetimedb/src/pipeline.rs`) for the stage it ran: intake, System 1, Cedar or the learned rule that matched, the injection screen, System 2, re-verify with its checks, the human (updated in place from "awaiting review" to the reviewer's decision), and the label, retrain, new model and policy proposal that human decision caused. Rows are keyed `case:<claim_ref>` and shaped like `PipelineStepRow` in `web/src/replay/types.ts`. `usePipelineSteps()` in `web/src/replay/useDecisionTrace.ts` reads the table, and Audit rows written by the pipeline (`[System] CLM-…:`) open their case's path. Historical decisions with no recorded steps show a deterministic example path built by `web/src/replay/adapter.ts`, marked "seeded path" in the header; recorded ones are marked "recorded path".
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

## Decision architecture

Reducers cannot call external services, so every model runs in `worker/`, a Node process that subscribes to the decision tables and writes results back through reducers. The module (`server/spacetimedb/src/decision.rs`) owns the evidence, the routing, Cedar and every final decision; the worker only proposes.

```
claim -> file_case (module builds the feature snapshot from pass, telemetry, space weather,
         station history and maintenance, SLA terms and the ML failure probability)
      -> System 1 (worker): logistic regression on structured features, never customer text
           >= 95% and Cedar permits             -> auto-decided by System 1
           a promoted learned rule matches       -> auto-decided by the rule (policy "v4+L<id>")
           otherwise, or the text is needed      -> injection screen (worker)
                flagged                          -> escalated by Guard, System 2 not invoked
                passed                           -> System 2 (worker): LLM analyst reads every source
      -> submit_system2 re-verifies in the module: cited evidence must exist and belong to the claim,
         credit <= entitlement, telemetry/System 1 sanity checks, the 95% threshold, then Cedar
           -> auto-decided by System 2, or escalated to Approvals with the evidence package and case summary
```

Run it after `seed.sh` (which also seeds `fixtures/sla_terms.json`, maintenance windows and 2,409 labeled decisions over 180 days):

```bash
cd worker && npm install && npm start      # System 2 in mock mode
npm test                                   # worker tests
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `LLM_API_KEY` | unset | Enables the real System 2. Any OpenAI-compatible `/chat/completions` endpoint |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Endpoint base URL |
| `LLM_MODEL` | `gpt-4o-mini` | Model name, recorded on every System 2 decision |
| `LIVE_LABEL_WEIGHT` | `20` | Weight of a live human label relative to one historical label |
| `STDB_HOST`, `STDB_MODULE` | `ws://localhost:3000`, `ground-truth` | SpacetimeDB connection |

**Mock mode.** Without `LLM_API_KEY`, System 2 is `mockAnalyst` (`worker/src/system2.ts`), a deterministic stand-in that is deliberately credulous: it obeys instructions in the customer message and believes asserted outages and cited ids. Break It therefore measures the guards around System 2, not the mock.

**Prompt-injection defense.** The customer message is untrusted: it never enters the system prompt, it is passed in the user turn as one JSON-escaped string between `<<<CUSTOMER_MESSAGE>>>` markers with hidden characters stripped and delimiters neutralised, and a cheap screen (`worker/src/screen.ts`: Unicode tag decoding, zero-width and bidi stripping, NFKC, homoglyph folding, base64 decoding, instruction patterns) runs first. Whatever System 2 returns is re-verified by the module, and Cedar has the final say. Break It's Prompt injection row files 12 attacks as real claims (`run_injection_attacks`). The worker decides them, so the module refuses the run when the worker has not sent a heartbeat in 15 s (the row shows "Worker offline" and how to start it), and a run not fully decided within 60 s is closed by the scheduled `expire_injection_run`: undecided attacks are not scored and go to Approvals with the reason.

**Learning.** Two channels, never trained on the policies themselves:

1. Model weights. Every human decision in Approvals (`human_decide_case`) writes a `labeled_decision` with the full package the reviewer saw (snapshot, customer message and extracted fields, ML probability and SHAP terms, System 1 and System 2 outputs, rules fired), the verdict, credit, reason code and text, decisive evidence, reviewer, versions and claim type. The worker refits System 1 on all human labels (warm-started Newton/IRLS), replays it on the labeled history, and `register_model_version` promotes it only if auto-approve precision does not regress (the module re-checks). `model_version.latency_ms` is measured on the module clock from the human decision to the new version being registered.
2. Policies. `worker/src/miner.ts` proposes a rule only when at least three reviewers made the same decision on the same claim type, cited the same decisive evidence, and no labeled decision with those feature values went the other way. A single decision never creates a rule, and customer text is never a rule input. The module stores the rule as Cedar text (`learned_rule.cedar_text`), re-counts support and contradictions over every label through Cedar, and promotes it only if replay precision does not regress. When nothing qualifies, the Decisions page shows "No consistent pattern found ..., so no rule was proposed".

Every step of every decision is a `case_decision` row with the deciding system (System 1, System 2, learned rule, guard or human), model and policy versions, inputs and cited evidence; final decisions also write `decision_record`. The Decisions page shows model versions, retrain latency, learned rules and the audit feed; Approvals shows escalated cases with their evidence and the labeling form.

## Policy learning on the Policies page

A second, module-only implementation of the policy channel: versioned Cedar policies (`policy_version`, `cedar_rule`) learned from human audit decisions, replayed over six months and promoted by a human. It runs entirely inside the reducers (no worker needed) and its tables are namespaced so they do not collide with the decision pipeline above.

### Third source: SLA contracts and customer messages

Telemetry and space weather say what happened to a pass. They cannot say what it is worth or whether it is excused: that is in the customer's contract. And the claim itself arrives as a message that asserts its own version of events. So the evidence has three sources:

| Source | Where | What it decides |
|--------|-------|-----------------|
| Telemetry, pass and timeline | `pass`, modeled elevation curve | How much of the contact was lost, at what elevation, and whether data integrity passed |
| Space weather and station history | `space_weather`, `maintenance_log` | Whether a storm or notified maintenance could explain the loss |
| Contract, SLA terms and message | `server/fixtures/sla_contracts.json` (`customer_contract`), `claim_message` | Credit formula, Kp exclusion, maintenance notice period, minimum elevation, filing window, and what the customer claims |

The incoming claims (`server/fixtures/incoming_claims.json`) are written so the sources disagree in realistic ways:

| Claim | Disagreement |
|-------|--------------|
| CLM-20002, CLM-20003 | The message blames a geomagnetic storm, but Kp stayed below the Gold contract's exclusion, so the storm does not excuse the provider |
| CLM-20004 | Maintenance was announced, but less than the contract's notice period ahead |
| CLM-20005 | The customer claims total corruption, telemetry shows 18% lost, and the integrity check is still pending |
| CLM-20006 | A new account, no history to compare against |
| CLM-20007 | Kp was above the exclusion: the contract excuses the loss even though the message asks for credit |
| CLM-20008 | 30% of the contact was lost, but the customer asks for 100% of the fee |

Each conflict lowers confidence by a stated penalty (`case_conflict`), which is how Approvals explains why a claim is below 95%.

### Six months of human audit decisions

`seed_learning_history` (`history.rs`) writes about 10,000 `audit_decision` rows over 182 days. Volume per station and month is the station's pass count times `claim_rate()`, the pass generator's drop rate plus its dispute rate from `contracts.json`, so the history is sized from pass revenue. Five reviewers follow consistent practices in some situations (minable patterns), disagree in others (contradiction zones), and decide against practice 1% of the time (noise). Every row stores the full evidence snapshot (`decision_snapshot`), outcome, credit, reason code and text, decisive evidence, reviewer, model and policy versions, and claim type. The Policies page's History entry shows it by month, by reason and by most recent decision.

### The loop

1. **Escalation.** A claim below 95% opens on Approvals with the evidence handoff: telemetry and modeled elevation timeline, the Kp curve against the contract exclusion, station history and maintenance, the contract clause and formula credit, the customer message and their history, the failure model's probability with exact SHAP terms, every Cedar rule that matched or did not and why, why confidence is below 95%, similar past decisions, and the options with their dollar impact.
2. **Decision.** `decide_case` stores the decision with its snapshot and the evidence the reviewer marked decisive.
3. **Mining.** `learn_from_decision` takes the claim type plus the decisive features as a pattern and counts labeled decisions with the same values. It proposes a rule only with at least 3 consistent decisions and none contradicting. Otherwise it records why (`below_support`, `contradicted`, `no_decisive_evidence`), and Approvals and History show "no rule proposed" with the count. A single decision never creates a rule.
4. **Rule text.** `TemplateRuleWriter` ("template-v1") writes the Cedar `permit` on action `apply_precedent` with `@id`, `@outcome`, `@confidence` and `@support` annotations. Generation is deterministic; `RuleWriter` is the seam for an LLM writer, whose output would still be parsed by Cedar and replayed before anyone can promote it.
5. **Replay and version.** The proposal is a new `policy_version` with a `policy_proposal` linking it to the human decision that caused it. Every labeled decision is replayed through the current and the proposed Cedar policy sets. Promotion is disabled if precision regresses or if the version would auto-decide below 95%.
6. **Promotion.** `promote_policy_version` makes the version current. New claims matching the rule auto-decide at the rule's confidence, citing the rule id and policy version.

The four governing rules (auto-decide at 95%, escalate below 95%, AI cannot edit policies, human approver authority) are fixed: `toggle_rule` refuses them.

### Measured on a fresh seed

| Version | Escalations | Precision | Regressions | Settled automatically | Drift from human credits | Result |
|---------|-------------|-----------|-------------|-----------------------|--------------------------|--------|
| v5 (threshold 90%) | 2,772 → 2,278 | 98.89% → 98.91% | 4 | $54,700 | +$736 | Blocked by the 95% floor |
| v6 (7 rules mined from history) | 2,772 → 1,362 | 98.89% → 99.07% | 0 | $129,519 | $0 | Promoted |
| v7 (learned from CLM-20003) | 1,364 → 1,361 | 99.07% → 99.07% | 0 | $673 | $0 | Promoted |

Live: one decision on CLM-20002 (approve $300: storm below the exclusion, total loss, integrity passed) produced no rule: 2 of 3 consistent decisions. The same decision on CLM-20003 made 3 with none contradicting, so v7 was proposed. After promotion, a similar new claim (CLM-20009, TrollSat, Kp 5.0, 95% lost) auto-approved at 99% for $325, citing `v7-learned-1` under policy v7. Exact figures move slightly with the seed time.

### Relation to the decision pipeline

Both stacks mine human decisions into Cedar rules. This one owns `audit_decision`, `mined_rule`, `policy_proposal`, `mining_result`, `claim_case` and `maintenance_log`/`claim_message`; the pipeline owns `labeled_decision`, `learned_rule` and `decision_case`. Labels from `decide_case` do not yet feed the worker's System 1 retraining, and the pipeline's labels do not feed this miner. They should be consolidated into one label table and one miner.

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
