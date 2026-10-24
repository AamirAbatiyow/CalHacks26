import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fit, predict } from '../src/system1.ts';
import { featurize } from '../src/features.ts';
import { retrain } from '../src/retrain.ts';
import { historyLabels, toLabel } from './helpers.ts';

test('logistic regression recovers a separable signal', () => {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 400; i++) {
    const v = (i % 100) / 100;
    X.push([1, v]);
    y.push(v > 0.5 ? 1 : 0);
  }
  const { weights } = fit(X, y, X.map(() => 1), { l2: 0.01 });
  assert.ok(predict(weights, [1, 0.9]) > 0.95);
  assert.ok(predict(weights, [1, 0.1]) < 0.05);
});

test('bootstrap fit on six months of history is calibrated and precise', () => {
  const { labels } = historyLabels();
  const r = retrain(labels, null);
  assert.equal(r.promote, true);
  assert.ok(r.metrics.precisionPct >= 95, `precision ${r.metrics.precisionPct}`);
  assert.ok(r.metrics.ece < 0.06, `ECE ${r.metrics.ece}`);
  assert.ok(r.metrics.brier < 0.08, `Brier ${r.metrics.brier}`);
  assert.ok(r.fitMs < 2000, `fit took ${r.fitMs}ms`);
});

test('a live human decision moves the model and is promoted without regressing precision', () => {
  const { rows, labels } = historyLabels();
  const base = retrain(labels, null);
  const nicheB = rows.find(r => r.reviewer === 'p.nair' && r.snapshot.weather.storm && r.claim_type === 'degraded_link')!;
  const before = predict(base.weights, featurize(nicheB.snapshot));
  const live = toLabel({ ...nicheB, reviewer: 's.haddad' }, labels.length + 1, 'live');
  const next = retrain([...labels, live], base.weights);
  assert.equal(next.promote, true, next.reason);
  assert.ok(next.metrics.precisionPct >= base.metrics.precisionPct);
  assert.ok(predict(next.weights, featurize(nicheB.snapshot)) > before);
});

test('evaluate reports precision over auto-approvals only', () => {
  const m = evaluate([10, 0], [[1, 0], [1, 0]], [1, 0]);
  assert.equal(m.coveragePct, 100);
  assert.equal(m.precisionPct, 50);
});
