/**
 * Ledger to ERP handoff, client side. The module (`server/spacetimedb/src/erp.rs`) is the
 * authority: it validates, maps and numbers each document when `submit_to_erp` runs.
 * The mapping and checks here mirror it so the page can preview a payload and warn
 * before submitting. Pure, so it runs under `node --test`.
 */

export type EntryKind = 'Invoice' | 'Credit' | 'Recovery';
export type ErpState = 'Pending' | 'Submitted' | 'Failed';

export interface ErpMapping {
  documentType: string;
  prefix: string;
  debitAccount: string;
  creditAccount: string;
}

export const ERP_MAPPING: Record<EntryKind, ErpMapping> = {
  Invoice: { documentType: 'Customer invoice', prefix: 'INV', debitAccount: '1200 Accounts receivable', creditAccount: '4000 Pass revenue' },
  Credit: { documentType: 'Credit memo', prefix: 'CM', debitAccount: '4100 SLA credits (contra-revenue)', creditAccount: '1200 Accounts receivable' },
  Recovery: { documentType: 'Statistical journal', prefix: 'SJ', debitAccount: '9100 Recovered pass revenue (stat)', creditAccount: '9199 Statistical offset' },
};

export interface ErpEntry {
  id: bigint;
  createdAt: bigint;
  entryType: string;
  description: string;
  referenceId: string | null;
  amountCents: bigint;
  passId: bigint | null;
  stationId: string | null;
  /** Identity (hex string) that approved the credit, for SoD. May be absent on old rows or non-credit entries. */
  approvedBy?: string | null;
}

/** Checks separation of duties: returns credits in entries that were approved by currentIdentity. */
export function sodViolations(entries: ErpEntry[], currentIdentity: string | null): ErpEntry[] {
  if (!currentIdentity) return [];
  return entries.filter(e => e.entryType === 'Credit' && e.approvedBy && e.approvedBy === currentIdentity);
}

export interface ErpPostingView {
  ledgerEntryId: bigint;
  idempotencyKey: string;
  status: Exclude<ErpState, 'Pending'>;
  batchId: bigint;
  externalId: string;
  erpDocumentId: string | null;
  attempts: number;
  error: string | null;
  updatedAt: bigint;
}

/** Local date and time to the second, for batch timestamps. */
export function erpTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const idempotencyKey = (id: bigint) => `gt-ledger-${id}`;

/** The checks `submit_to_erp` makes, in the same order. Null when the entry would post. */
export function precheck(e: ErpEntry, postedRefs: Map<string, bigint>): string | null {
  if (e.amountCents === 0n) return 'Zero amount: nothing to post';
  const signOk = e.entryType === 'Credit' ? e.amountCents < 0n : e.amountCents > 0n;
  if (!signOk) return `Sign does not match a ${e.entryType} entry`;
  const ref = e.referenceId?.trim();
  if (!ref) return 'No document number: the ERP needs an external ID to deduplicate';
  if (!e.stationId?.trim()) return 'No station: the ERP needs a location for the GL line';
  const other = postedRefs.get(ref);
  if (other !== undefined && other !== e.id) return `Document number ${ref} already posted from ledger entry #${other}`;
  return null;
}

/** External ids already in the ERP, mapped to the ledger entry that posted them. */
export function postedRefs(postings: Iterable<ErpPostingView>): Map<string, bigint> {
  const refs = new Map<string, bigint>();
  for (const p of postings) if (p.status === 'Submitted') refs.set(p.externalId, p.ledgerEntryId);
  return refs;
}

export function stateOf(posting: ErpPostingView | undefined): ErpState {
  return posting?.status ?? 'Pending';
}

export interface StateTotals {
  count: number;
  /** Sum of absolute amounts, so credits and invoices both count as dollars handed off. */
  cents: number;
}

export function summarize(entries: ErpEntry[], postings: Map<string, ErpPostingView>): Record<ErpState, StateTotals> {
  const out: Record<ErpState, StateTotals> = {
    Pending: { count: 0, cents: 0 },
    Submitted: { count: 0, cents: 0 },
    Failed: { count: 0, cents: 0 },
  };
  for (const e of entries) {
    const s = out[stateOf(postings.get(String(e.id)))];
    s.count += 1;
    s.cents += Math.abs(Number(e.amountCents));
  }
  return out;
}

const usd = (cents: bigint) => Number(cents < 0n ? -cents : cents) / 100;

/** The document the connector sends for one entry, as shown in the preview. */
export function erpPayload(e: ErpEntry, posting: ErpPostingView | undefined, batchRef: string | null) {
  const m = ERP_MAPPING[e.entryType as EntryKind];
  const amount = usd(e.amountCents);
  return {
    idempotencyKey: idempotencyKey(e.id),
    batch: batchRef ?? 'assigned on submit',
    status: stateOf(posting),
    ...(posting?.error ? { lastError: posting.error, attempts: posting.attempts } : {}),
    recordType: m?.documentType ?? e.entryType,
    externalId: e.referenceId?.trim() || null,
    erpDocumentId: posting?.erpDocumentId ?? null,
    tranDate: new Date(Number(e.createdAt / 1000n)).toISOString().slice(0, 10),
    currency: 'USD',
    amount,
    location: e.stationId,
    memo: e.description,
    lines: m
      ? [
          { account: m.debitAccount, debit: amount },
          { account: m.creditAccount, credit: amount },
        ]
      : [],
    source: {
      system: 'ground-truth',
      table: 'ledger_entry',
      ledgerEntryId: Number(e.id),
      passId: e.passId === null ? null : Number(e.passId),
      ledgerAmountCents: Number(e.amountCents),
    },
  };
}
