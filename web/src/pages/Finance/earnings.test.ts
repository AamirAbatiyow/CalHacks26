import { test } from 'node:test';
import assert from 'node:assert/strict';
import { change, combine, periodLabel, periodStart, periodWindow, toCsv, totals, type Flow } from './earnings.ts';

const at = (iso: string) => Date.parse(iso);

test('periods are UTC calendar periods with Monday weeks', () => {
  const now = at('2026-10-26T06:07:00Z');
  assert.equal(periodStart(now, 'day'), at('2026-10-26T00:00:00Z'));
  assert.equal(periodStart(now, 'week'), at('2026-10-26T00:00:00Z'));
  assert.equal(periodStart(at('2026-10-25T23:59:00Z'), 'week'), at('2026-10-19T00:00:00Z'));
  assert.equal(periodStart(now, 'month'), at('2026-10-01T00:00:00Z'));
  assert.equal(periodStart(now, 'year'), at('2026-01-01T00:00:00Z'));
  assert.equal(periodLabel(periodStart(now, 'week'), 'week'), 'Week of Oct 26, 2026');
});

test('the previous period is cut at the same elapsed time', () => {
  const w = periodWindow(at('2026-10-26T06:00:00Z'), 'day', 3);
  assert.equal(w.previousStart, at('2026-10-25T00:00:00Z'));
  assert.equal(w.previousEnd, at('2026-10-25T06:00:00Z'));
  assert.deepEqual(w.trendStarts, [at('2026-10-24T00:00:00Z'), at('2026-10-25T00:00:00Z'), at('2026-10-26T00:00:00Z')]);

  // March 31 has no February counterpart: the comparison stops at the end of February.
  const m = periodWindow(at('2026-03-31T12:00:00Z'), 'month', 2);
  assert.equal(m.previousEnd, at('2026-03-01T00:00:00Z'));
});

test('totals split flows into current, like-for-like previous and trend', () => {
  const now = at('2026-10-26T06:00:00Z');
  const w = periodWindow(now, 'day', 3);
  const flows: Flow[] = [
    { at: at('2026-10-26T01:00:00Z'), value: 100 },
    { at: at('2026-10-26T07:00:00Z'), value: 999 }, // after the sim clock: not yet happened
    { at: at('2026-10-25T05:00:00Z'), value: 40 },
    { at: at('2026-10-25T20:00:00Z'), value: 60 }, // later in the day than now: trend only
    { at: at('2026-10-24T12:00:00Z'), value: 7 },
    { at: at('2026-10-01T12:00:00Z'), value: 5 }, // outside the trend
  ];
  const t = totals(flows, w, 'day');
  assert.equal(t.current, 100);
  assert.equal(t.previous, 40);
  assert.deepEqual(t.trend, [7, 100, 100]);

  const months = totals(flows, periodWindow(now, 'month', 2), 'month');
  assert.equal(months.current, 212);
  assert.deepEqual(months.trend, [0, 212]);
});

test('net and change', () => {
  const gross = { current: 1000, previous: 800, trend: [800, 1000] };
  const credits = { current: 100, previous: 0, trend: [0, 100] };
  const net = combine(gross, credits, (a, b) => a - b);
  assert.deepEqual(net, { current: 900, previous: 800, trend: [800, 900] });
  assert.deepEqual(change(net), { abs: 100, pct: 12.5 });
  assert.deepEqual(change(credits), { abs: 100, pct: null });
});

test('csv quotes cells that need it', () => {
  assert.equal(toCsv([['Line', 'Week of Oct 26, 2026'], ['Gross billed', 12.5]]), 'Line,"Week of Oct 26, 2026"\nGross billed,12.5\n');
});
