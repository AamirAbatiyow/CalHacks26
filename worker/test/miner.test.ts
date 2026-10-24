import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mine } from '../src/miner.ts';
import { replayAutomation, route, type Rule } from '../src/policy.ts';
import { retrain } from '../src/retrain.ts';
import { mockAnalyst } from '../src/system2.ts';
import { AUTO_DECIDE_P } from '../src/system1.ts';
import { evidenceRefs } from '../src/features.ts';
import { historyLabels, similarSnapshot, toLabel } from './helpers.ts';

const STORM_HEAVY = 'Approve: degraded link, no pass completed, storm, telemetry loss 40-60%, no weather exclusion, within window';
const STORM_MODERATE = 'Approve: degraded link, no pass completed, storm, telemetry loss 25-40%, no weather exclusion, within window';

test('the miner derives the storm-degradation rule from the seeded labeled decisions', () => {
  const { labels } = historyLabels();
  const { proposals, nearMisses } = mine(labels);
  const rule = proposals.find(p => p.description === STORM_HEAVY);
  assert.ok(rule, `proposals: ${proposals.map(p => p.description).join(' | ')}`);
  assert.equal(rule.support, 4);
  assert.equal(rule.distinctReviewers, 4);
  assert.equal(rule.contradictions, 0);
  assert.ok(!proposals.some(p => p.description === STORM_MODERATE), 'two decisions are not a pattern');
  assert.equal(nearMisses.find(n => n.description === STORM_MODERATE)?.blockedBy, '2 of 3 consistent decisions');
  assert.ok(!proposals.some(p => p.description.includes('degraded link') && p.description.includes(', weather exclusion')), 'contradicted pattern proposed');
});

test('the derived rule turns a held-out similar claim from escalated into auto-decided', () => {
  const { rows, labels } = historyLabels();
  const { weights } = retrain(labels, null);
  const seeded = rows.find(r => r.reviewer === 'r.sato' && r.claim_type === 'degraded_link' && r.snapshot.weather.storm)!;
  const heldOut = similarSnapshot(seeded.snapshot, 42, 'Northpoint Orbital');

  const without = route(weights, heldOut, []);
  assert.equal(without.kind, 'system2', 'System 1 alone should not be confident enough');
  assert.ok(without.confidence < AUTO_DECIDE_P);
  const s2 = mockAnalyst({
    snapshot: heldOut, evidenceIds: evidenceRefs(heldOut, null), messageId: null, message: null, extracted: null,
    system1: { p_approve: without.confidence, model_version: 's1-v1' },
  });
  assert.ok(s2.confidence < AUTO_DECIDE_P, 'System 2 is also below the threshold, so the claim escalates');

  const proposal = mine(labels).proposals.find(p => p.description === STORM_HEAVY)!;
  const rule: Rule = { id: 1, approve: proposal.approve, conditions: proposal.conditions };
  const history = labels.map(l => ({ snapshot: l.snapshot, approve: l.approve }));
  const before = replayAutomation(weights, [], history);
  const after = replayAutomation(weights, [rule], history);
  assert.ok(after.precisionPct >= before.precisionPct, `precision ${before.precisionPct} -> ${after.precisionPct}`);

  const withRule = route(weights, heldOut, [rule]);
  assert.equal(withRule.kind, 'rule');
  assert.equal(withRule.approve, true);
});

test('a single human decision updates the model but never creates a rule', () => {
  const { rows, labels } = historyLabels();
  const nicheB = rows.find(r => r.reviewer === 'p.nair' && r.claim_type === 'degraded_link' && r.snapshot.weather.storm)!;
  const known = new Set(mine(labels).proposals.map(p => p.signature));
  const sameReviewer = toLabel({ ...nicheB, reviewer: 'p.nair' }, labels.length + 1, 'live');
  assert.equal(mine([...labels, sameReviewer], known).proposals.length, 0, 'same reviewer twice is not three reviewers');

  const third = toLabel({ ...nicheB, reviewer: 's.haddad' }, labels.length + 1, 'live');
  const next = mine([...labels, third], known);
  assert.deepEqual(next.proposals.map(p => p.description), [STORM_MODERATE]);
});

test('with no consistent pattern, no rule is proposed and the note says so', () => {
  const { labels } = historyLabels();
  const mixed = labels.slice(0, 40).map((l, i) => ({ ...l, reviewer: `r${i}`, approve: i % 2 === 0 }));
  const r = mine(mixed);
  assert.equal(r.proposals.length, 0);
  assert.match(r.note, /^No consistent pattern found in 40 labeled decisions, so no rule was proposed$/);
  assert.equal(mine([]).proposals.length, 0);
});

test('customer text is never a rule input', () => {
  const { labels } = historyLabels();
  const textOnly = labels.slice(0, 5).map((l, i) => ({ ...l, reviewer: `r${i}`, approve: true, decisiveEvidence: ['customer_message'] }));
  assert.equal(mine(textOnly).proposals.length, 0);
});
