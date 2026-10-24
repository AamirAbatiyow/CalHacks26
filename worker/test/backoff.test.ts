import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconnectDelayMs, RECONNECT_MAX_MS } from '../src/backoff.ts';

test('reconnect delay doubles from one second and caps at thirty', () => {
  const noJitter = () => 0;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(a => reconnectDelayMs(a, noJitter)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('jitter adds at most 20%', () => {
  assert.equal(reconnectDelayMs(0, () => 1), 1200);
  assert.ok(reconnectDelayMs(20, () => 1) <= RECONNECT_MAX_MS * 1.2);
});
