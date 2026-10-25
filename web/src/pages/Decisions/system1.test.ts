import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidencePct, drivers, featurize, laneOf, laneSplit, predict, scoreLabel, type S1Snapshot } from './system1.ts';

const NAMES = [
  'bias', 'ml_failure_prob', 'telemetry_loss', 'pass_completed', 'kp_norm', 'storm', 'weather_exclusion', 'storm_x_exclusion',
  'within_window', 'amount_ratio', 'inflated_amount', 'station_drop_rate', 'maintenance_overlap', 'type_dropped', 'type_degraded',
  'type_late', 'degraded_x_loss', 'degraded_x_storm', 'late_x_maintenance',
];

/** s1-v1 as registered on the seeded database. */
const WEIGHTS = [
  -4.433902, -0.18272, 3.300229, -2.57845, 0.718023, -0.677982, -0.157185, -3.151852, 4.804867, -1.117491, -2.879391, -0.0577,
  0.812674, 0.550511, -1.061197, 0.510686, 4.803815, 1.288988, 5.455574,
];

/** Labeled history row HIST-00020: degraded link, 26% lost, Kp 3.7, approved by the reviewer. */
const HIST_00020: S1Snapshot = {
  claim: { claim_type: 'degraded_link', amount_claimed_cents: 2946 },
  pass: { status: 'Ok' },
  telemetry: { loss_pct: 26 },
  weather: { kp_index: 3.7, storm: false },
  station_history: { drop_rate_pct: 11, maintenance_overlap: false },
  contract: { weather_exclusion: false, within_window: true, entitled_credit_cents: 2808 },
  ml: { failure_probability: 0.0872 },
};

test('features follow the worker port, in model order', () => {
  const x = featurize(HIST_00020, NAMES);
  assert.equal(x.length, NAMES.length);
  const f = Object.fromEntries(NAMES.map((n, i) => [n, x[i]]));
  assert.equal(f.bias, 1);
  assert.equal(f.telemetry_loss, 0.26);
  assert.equal(f.pass_completed, 0);
  assert.equal(f.amount_ratio, 1.04);
  assert.equal(f.type_degraded, 1);
  assert.equal(f.degraded_x_loss, 0.26);
  assert.equal(f.within_window, 1);
  assert.equal(featurize(HIST_00020, ['unknown'])[0], 0);
});

test('s1-v1 is unsure about HIST-00020, so it goes to deep review', () => {
  const p = predict(WEIGHTS, featurize(HIST_00020, NAMES));
  assert.ok(Math.abs(p - 0.6289) < 1e-3, `p = ${p}`);
  assert.equal(laneOf(p), 'deep');
  const scored = scoreLabel(20, true, HIST_00020, WEIGHTS, NAMES);
  assert.equal(scored.agrees, true);
  assert.equal(scored.lane, 'deep');
});

test('confidence is symmetric and 95% is the fast-lane gate', () => {
  assert.equal(confidencePct(0.97), 97);
  assert.ok(Math.abs(confidencePct(0.03) - 97) < 1e-9);
  assert.equal(laneOf(0.95), 'fast-approve');
  assert.equal(laneOf(0.05), 'fast-deny');
  assert.equal(laneOf(0.9499), 'deep');
  assert.equal(laneOf(0.5), 'deep');
});

test('lane split counts agreement only inside the fast lane', () => {
  const split = laneSplit([
    { id: 1, humanApproved: true, pApprove: 0.99, lane: 'fast-approve', agrees: true },
    { id: 2, humanApproved: false, pApprove: 0.97, lane: 'fast-approve', agrees: false },
    { id: 3, humanApproved: false, pApprove: 0.01, lane: 'fast-deny', agrees: true },
    { id: 4, humanApproved: true, pApprove: 0.6, lane: 'deep', agrees: true },
  ]);
  assert.equal(split.total, 4);
  assert.equal(split.fastApprove, 2);
  assert.equal(split.fastApproveAgree, 1);
  assert.equal(split.fastDeny, 1);
  assert.equal(split.deep, 1);
  assert.equal(split.fastPct, 75);
  assert.ok(Math.abs(split.fastAgreePct - 200 / 3) < 1e-9);
  assert.equal(laneSplit([]).fastAgreePct, 0);
});

test('drivers rank by contribution and skip the baseline', () => {
  const x = featurize(HIST_00020, NAMES);
  const top = drivers(WEIGHTS, x, NAMES, 3);
  assert.equal(top.length, 3);
  assert.ok(top.every(d => d.name !== 'bias'));
  assert.equal(top[0].name, 'within_window');
  assert.ok(Math.abs(top[0].contribution) >= Math.abs(top[1].contribution));
});
