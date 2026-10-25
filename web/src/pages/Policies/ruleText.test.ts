import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cedarConditions, cedarOutcome, mostCommon, readRule, ruleNumber } from './ruleText.ts';

// Same shape TemplateRuleWriter writes in server/spacetimedb/src/learning.rs.
const cedar = (id: string, outcome: string, when: string[]) =>
  `@id("${id}")\n@outcome("${outcome}")\n@confidence("99")\n@support("248")\npermit (\n  principal == GroundTruth::Actor::"ai_analyst",\n  action == GroundTruth::Action::"apply_precedent",\n  resource\n) when {\n${when.map(w => `  ${w}`).join(' &&\n')}\n};\n`;

test('reads clauses and outcome from the Cedar a template rule runs', () => {
  const text = cedar('v6-learned-1', 'deny', [
    'context.claim_type == "data_integrity"',
    'context.integrity == "fail"',
    'context.lost_band == "under_25"',
  ]);
  assert.deepEqual(cedarConditions(text), [
    { key: 'claim_type', value: 'data_integrity' },
    { key: 'integrity', value: 'fail' },
    { key: 'lost_band', value: 'under_25' },
  ]);
  assert.equal(cedarOutcome(text), 'deny');
  const r = readRule({ cedarText: text, conditions: [], outcome: 'approve' });
  assert.equal(r.fromCedar, true);
  assert.equal(r.outcome, 'deny', 'the @outcome annotation wins over the stored outcome');
  assert.equal(r.claimType, 'data_integrity');
  assert.deepEqual(r.clauses.map(c => c.short), ['Data integrity', 'Integrity check: failed', 'Lost: under 25%']);
  assert.equal(r.sentence, 'A data integrity claim where the data integrity check failed and under 25% of the contact was lost is denied.');
});

test('a partial rule names every condition in order', () => {
  const r = readRule({
    cedarText: cedar('v6-learned-6', 'partial', [
      'context.claim_type == "partial_downlink"',
      'context.weather_band == "clear"',
      'context.maintenance == "none"',
      'context.integrity == "pass"',
      'context.claim_vs_contract == "over"',
    ]),
    conditions: [],
    outcome: 'partial',
  });
  assert.equal(
    r.sentence,
    "A partial downlink where space weather was more than 1 Kp below the contract's storm exclusion, no maintenance overlapped the pass, "
      + 'the data integrity check passed and the claim asks more than 110% of the contract credit gets partial credit.',
  );
});

test('falls back to stored conditions when the Cedar has no equality clauses', () => {
  const r = readRule({ cedarText: 'permit(principal, action, resource);', conditions: ['claim_type=dropped_pass', 'maintenance=notified'], outcome: 'deny' });
  assert.equal(r.fromCedar, false);
  assert.equal(r.sentence, 'A dropped pass where maintenance was announced with the notice the contract requires is denied.');
});

test('unknown keys still read, and helpers order and count', () => {
  const r = readRule({ cedarText: '', conditions: ['claim_type=dropped_pass', 'station_id=svalsat'], outcome: 'approve' });
  assert.equal(r.clauses[1].short, 'station id: svalsat');
  assert.deepEqual(mostCommon(['a', 'b', 'a', '']), { text: 'a', count: 2 });
  assert.equal(mostCommon([]), null);
  assert.deepEqual(['v6-learned-10', 'v6-learned-2'].sort((a, b) => ruleNumber(a) - ruleNumber(b)), ['v6-learned-2', 'v6-learned-10']);
});
