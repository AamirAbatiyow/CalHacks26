import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erpPayload, postedRefs, precheck, summarize, type ErpEntry, type ErpPostingView } from './erp.ts';

const entry = (over: Partial<ErpEntry>): ErpEntry => ({
  id: 7n,
  createdAt: BigInt(Date.parse('2026-10-24T12:28:00Z')) * 1000n,
  entryType: 'Credit',
  description: 'Credit issued for CLM-20001 (Northpoint Orbital)',
  referenceId: 'CR-CLM-20001',
  amountCents: -230_000n,
  passId: 11n,
  stationId: 'svalsat',
  ...over,
});

const posting = (over: Partial<ErpPostingView>): ErpPostingView => ({
  ledgerEntryId: 5n,
  idempotencyKey: 'gt-ledger-5',
  status: 'Submitted',
  batchId: 1n,
  externalId: 'CR-CLM-20001',
  erpDocumentId: 'CM-000005',
  attempts: 1,
  error: null,
  updatedAt: 0n,
  ...over,
});

test('precheck mirrors the module', () => {
  const none = new Map<string, bigint>();
  assert.equal(precheck(entry({}), none), null);
  assert.match(precheck(entry({ amountCents: 0n }), none)!, /^Zero amount/);
  assert.match(precheck(entry({ amountCents: 5n }), none)!, /^Sign does not match/);
  assert.match(precheck(entry({ referenceId: '  ' }), none)!, /^No document number/);
  assert.match(precheck(entry({ stationId: null }), none)!, /^No station/);
  const refs = postedRefs([posting({}), posting({ ledgerEntryId: 6n, externalId: 'X', status: 'Failed' })]);
  assert.equal(refs.size, 1);
  assert.equal(precheck(entry({}), refs), 'Document number CR-CLM-20001 already posted from ledger entry #5');
  assert.equal(precheck(entry({ id: 5n }), refs), null);
});

test('summary counts dollars handed off in absolute terms', () => {
  const entries = [entry({ id: 1n }), entry({ id: 2n, entryType: 'Invoice', amountCents: 1_000_000n }), entry({ id: 3n })];
  const s = summarize(entries, new Map([['2', posting({ ledgerEntryId: 2n })], ['3', posting({ ledgerEntryId: 3n, status: 'Failed' })]]));
  assert.deepEqual(s, {
    Pending: { count: 1, cents: 230_000 },
    Submitted: { count: 1, cents: 1_000_000 },
    Failed: { count: 1, cents: 230_000 },
  });
});

test('a credit becomes a balanced credit memo keyed by its ledger entry', () => {
  const p = erpPayload(entry({}), undefined, null);
  assert.equal(p.idempotencyKey, 'gt-ledger-7');
  assert.equal(p.recordType, 'Credit memo');
  assert.equal(p.status, 'Pending');
  assert.equal(p.tranDate, '2026-10-24');
  assert.equal(p.amount, 2300);
  assert.deepEqual(p.lines, [
    { account: '4100 SLA credits (contra-revenue)', debit: 2300 },
    { account: '1200 Accounts receivable', credit: 2300 },
  ]);
  assert.equal(p.source.ledgerAmountCents, -230_000);
});
