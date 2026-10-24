/**
 * Decision worker. Subscribes to the decision tables, runs System 1, the injection
 * screen and System 2 on new claims, refits System 1 on every human decision, mines
 * policy proposals, and writes every result back through reducers.
 */

import { connect, tagOf } from './connect.ts';
import { tables, type DbConnection } from './module_bindings/index.ts';
import type { DecisionCase } from './module_bindings/types.ts';
import { evidenceRefs, FEATURE_NAMES, featurize, namedFeatures, type Snapshot } from './features.ts';
import { predict } from './system1.ts';
import { retrain, type Label } from './retrain.ts';
import { mine } from './miner.ts';
import { replayAutomation, type Condition, type Rule } from './policy.ts';
import { screenMessage } from './screen.ts';
import { extractFields } from './extract.ts';
import { callLlm, llmConfigFromEnv, mockAnalyst, type S2Input, type S2Output } from './system2.ts';

const llm = llmConfigFromEnv();
const mode = llm ? 'llm' : 'mock';
const llmModel = llm ? llm.model : 'mock-analyst-1';

const HEARTBEAT_MS = 5000;

let conn: DbConnection;
let ready = false;
let active: { version: number; weights: number[] } | null = null;
let lastNote = 'starting';
const parsed = new Map<bigint, Label>();
const handled = new Set<string>();
let chain: Promise<unknown> = Promise.resolve();
let beat: ReturnType<typeof setInterval> | null = null;
let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;

function enqueue(name: string, job: () => Promise<void>) {
  chain = chain.then(job).catch(err => console.error(`[worker] ${name} failed:`, err?.message ?? err));
}

/** History is seeded in batches; train once the batches stop arriving. */
function bootstrapSoon() {
  if (bootstrapTimer) clearTimeout(bootstrapTimer);
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null;
    if (ready && !active) enqueue('bootstrap System 1', () => learn(undefined));
  }, 3000);
}

function labels(): Label[] {
  const out: Label[] = [];
  for (const row of conn.db.labeledDecision.iter()) {
    let label = parsed.get(row.id);
    if (!label) {
      label = {
        id: Number(row.id),
        snapshot: JSON.parse(row.snapshotJson) as Snapshot,
        approve: tagOf(row.verdict) === 'Approve',
        source: row.source === 'live' ? 'live' : 'history',
        reviewer: row.reviewer,
        decisiveEvidence: row.decisiveEvidence,
        claimType: row.claimType,
      };
      parsed.set(row.id, label);
    }
    out.push(label);
  }
  return out.sort((a, b) => a.id - b.id);
}

function loadActiveModel() {
  for (const m of conn.db.modelVersion.iter()) {
    if (tagOf(m.status) === 'Active' && (!active || active.version !== m.version)) {
      active = { version: m.version, weights: JSON.parse(m.weightsJson) as number[] };
      console.log(`[worker] System 1 s1-v${m.version} active`);
    }
  }
}

function promotedRules(): Rule[] {
  return [...conn.db.learnedRule.iter()]
    .filter(r => tagOf(r.status) === 'Promoted')
    .map(r => ({ id: Number(r.id), approve: tagOf(r.verdict) === 'Approve', conditions: JSON.parse(r.conditionsJson) as Condition[] }));
}

async function heartbeat() {
  await conn.reducers.workerHeartbeat({ mode, llmModel, note: lastNote });
}

/** Runs outside the job queue so a long retrain or a call lost with a dropped socket never delays it. */
function beatNow() {
  if (!ready) return;
  heartbeat().catch(err => console.error('[worker] heartbeat failed:', err?.message ?? err));
}

/** Refit System 1 on all human labels, gate on replay precision, then mine for policy proposals. */
async function learn(triggeredBy: bigint | undefined) {
  const t0 = performance.now();
  const all = labels();
  if (all.length === 0) return;
  const result = retrain(all, active?.weights ?? null);
  await conn.reducers.registerModelVersion({
    promote: result.promote,
    weightsJson: JSON.stringify(result.weights),
    featureNamesJson: JSON.stringify(FEATURE_NAMES),
    trainedRows: result.trainedRows,
    liveLabels: result.liveLabels,
    precisionPct: result.metrics.precisionPct,
    prevPrecisionPct: result.previous?.precisionPct ?? 0,
    coveragePct: result.metrics.coveragePct,
    accuracyPct: result.metrics.accuracyPct,
    brier: result.metrics.brier,
    ece: result.metrics.ece,
    triggeredByLabel: triggeredBy,
    fitMs: result.fitMs,
    replayMs: result.replayMs,
    note: result.reason,
  });
  loadActiveModel();
  const tModel = performance.now();

  const weights = active?.weights ?? result.weights;
  const known = new Set([...conn.db.learnedRule.iter()].map(r => r.signature));
  const mined = mine(all, known);
  const history = all.map(l => ({ snapshot: l.snapshot, approve: l.approve }));
  for (const p of mined.proposals) {
    const rules = promotedRules();
    const before = replayAutomation(weights, rules, history);
    const after = replayAutomation(weights, [...rules, { id: -1, approve: p.approve, conditions: p.conditions }], history);
    await conn.reducers.proposeLearnedRule({
      signature: p.signature,
      approve: p.approve,
      conditionsJson: JSON.stringify(p.conditions),
      description: p.description,
      sourceLabelIds: p.sourceLabelIds.map(BigInt),
      distinctReviewers: p.distinctReviewers,
      precisionBefore: before.precisionPct,
      precisionAfter: after.precisionPct,
      coverageBefore: before.coveragePct,
      coverageAfter: after.coveragePct,
      triggeredByLabel: triggeredBy,
    });
  }
  const near = mined.nearMisses[0];
  lastNote = mined.proposals.length > 0
    ? mined.note
    : `${mined.note}${near ? `. Closest: "${near.description}" (${near.blockedBy})` : ''}`;
  await heartbeat();
  console.log(
    `[worker] retrain ${result.promote ? 'promoted' : 'rejected'} on ${all.length} labels: fit ${result.fitMs}ms, replay ${result.replayMs}ms, ` +
      `model live ${(tModel - t0).toFixed(0)}ms after start; ${mined.note}`,
  );
}

function latestSystem1(caseId: bigint) {
  let best: { id: bigint; pApprove: number; modelVersion: string } | null = null;
  for (const d of conn.db.caseDecision.iter()) {
    if (d.caseId === caseId && tagOf(d.system) === 'System1' && (!best || d.id > best.id)) best = d;
  }
  return best;
}

async function runSystem1(c: DecisionCase) {
  if (!active) return;
  const snapshot = JSON.parse(c.snapshotJson) as Snapshot;
  const x = featurize(snapshot);
  const p = predict(active.weights, x);
  await conn.reducers.submitSystem1({
    caseId: c.id,
    pApprove: Math.round(p * 1e6) / 1e6,
    modelVersion: `s1-v${active.version}`,
    inputsJson: JSON.stringify({ features: namedFeatures(x), ml_failure_probability: snapshot.ml.failure_probability }),
  });
}

async function runSystem2(c: DecisionCase) {
  const message = c.messageId !== undefined ? conn.db.disputeMessage.id.find(c.messageId)?.body ?? null : null;
  const screen = message ? screenMessage(message) : { flagged: false, score: 0, reasons: [] as string[], normalized: '' };
  const extracted = message ? extractFields(message) : null;
  await conn.reducers.submitScreen({
    caseId: c.id,
    flagged: screen.flagged,
    screenJson: JSON.stringify({ flagged: screen.flagged, score: screen.score, reasons: screen.reasons }),
    extractedJson: JSON.stringify(extracted),
  });
  if (screen.flagged) return;

  const snapshot = JSON.parse(c.snapshotJson) as Snapshot;
  const s1 = latestSystem1(c.id);
  const input: S2Input = {
    snapshot,
    evidenceIds: evidenceRefs(snapshot, c.messageId !== undefined ? Number(c.messageId) : null),
    messageId: c.messageId !== undefined ? Number(c.messageId) : null,
    message,
    extracted,
    system1: { p_approve: s1?.pApprove ?? 0.5, model_version: s1?.modelVersion ?? 'none' },
  };
  let out: S2Output;
  try {
    out = llm ? await callLlm(llm, input) : mockAnalyst(input);
  } catch (err) {
    out = {
      decision: 'escalate', confidence: 0, credit_cents: 0, cited_evidence: [], rationale: `System 2 unavailable: ${(err as Error).message}`,
      summary: 'System 2 could not analyse this claim; review the evidence directly.',
    };
  }
  await conn.reducers.submitSystem2({
    caseId: c.id,
    verdict: out.decision === 'approve' ? 0 : out.decision === 'deny' ? 1 : 2,
    confidencePct: Math.round(out.confidence * 1000) / 10,
    creditCents: BigInt(out.credit_cents),
    citedEvidence: out.cited_evidence,
    rationale: out.rationale,
    summary: out.summary,
    llmModel,
  });
}

function onCase(c: DecisionCase) {
  if (!ready) return;
  const status = tagOf(c.status);
  const key = `${c.id}:${status}`;
  if (handled.has(key)) return;
  if (status === 'Queued') {
    if (!active) return;
    handled.add(key);
    enqueue(`System 1 on ${c.claimRef}`, () => runSystem1(c));
  } else if (status === 'AwaitingSystem2') {
    handled.add(key);
    enqueue(`System 2 on ${c.claimRef}`, () => runSystem2(c));
  }
}

function start(c: DbConnection) {
  conn = c;
  ready = false;
  // A reconnect starts from a fresh subscription: jobs queued on the old socket may never settle,
  // and cases they were handling are picked up again (the module rejects anything already decided).
  // The database may also have been republished, so model and labels are reloaded from it.
  chain = Promise.resolve();
  handled.clear();
  parsed.clear();
  active = null;
  conn.db.decisionCase.onInsert((_ctx, row) => onCase(row));
  conn.db.decisionCase.onUpdate((_ctx, _old, row) => onCase(row));
  conn.db.modelVersion.onInsert(() => loadActiveModel());
  conn.db.modelVersion.onUpdate(() => loadActiveModel());
  conn.db.labeledDecision.onInsert((_ctx, row) => {
    if (ready && row.source === 'live') enqueue(`retrain on label ${row.id}`, () => learn(row.id));
    else if (ready && !active) bootstrapSoon();
  });
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      loadActiveModel();
      ready = true;
      console.log(`[worker] subscribed (System 2: ${mode} ${llmModel}); ${conn.db.labeledDecision.count()} labeled decisions`);
      if (!active) {
        lastNote = 'training System 1';
        enqueue('bootstrap System 1', () => learn(undefined));
      } else {
        lastNote = 'ready';
      }
      beatNow();
      enqueue('pending cases', async () => {
        for (const row of conn.db.decisionCase.iter()) onCase(row);
      });
    })
    .onError(ctx => console.error('[worker] subscription error', ctx.event))
    .subscribe([
      tables.decisionCase,
      tables.caseDecision,
      tables.disputeMessage,
      tables.labeledDecision,
      tables.modelVersion,
      tables.learnedRule,
    ]);
  if (!beat) beat = setInterval(beatNow, HEARTBEAT_MS);
}

connect(start);
