import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateHistory, type HistoryRow } from '../src/history.ts';
import { entitledCreditCents, type Snapshot } from '../src/features.ts';
import type { Label } from '../src/retrain.ts';

export function toLabel(row: HistoryRow, id: number, source: 'history' | 'live' = 'history'): Label {
  return {
    id,
    snapshot: row.snapshot,
    approve: row.verdict === 'Approve',
    source,
    reviewer: row.reviewer,
    decisiveEvidence: row.decisive_evidence,
    claimType: row.claim_type,
  };
}

export function historyLabels(): { rows: HistoryRow[]; labels: Label[] } {
  const rows = generateHistory();
  return { rows, labels: rows.map((r, i) => toLabel(r, i + 1)) };
}

/** A new storm-degradation claim like a seeded one, with a different loss, customer and amount. */
export function similarSnapshot(base: Snapshot, lossPct: number, customer = base.contract.customer): Snapshot {
  const s: Snapshot = structuredClone(base);
  s.claim.claim_ref = 'HELD-OUT-1';
  s.claim.customer = customer;
  s.contract.customer = customer;
  s.telemetry.loss_pct = lossPct;
  s.telemetry.received_mb = Math.round(s.telemetry.expected_mb * (100 - lossPct)) / 100;
  s.contract.entitled_credit_cents = entitledCreditCents(s.pass.revenue_cents, s.contract.credit_pct, 'degraded_link', lossPct, s.contract.max_credit_cents);
  s.claim.amount_claimed_cents = s.contract.entitled_credit_cents;
  return s;
}

function unescapeRust(s: string): string {
  return s
    .replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** The Break It prompt-injection attacks, read from the module so the tests cannot drift from it. */
export function injectionAttacks(): { name: string; message: string }[] {
  const src = readFileSync(fileURLToPath(new URL('../../server/spacetimedb/src/decision.rs', import.meta.url)), 'utf8');
  const out: { name: string; message: string }[] = [];
  for (const m of src.matchAll(/InjectionAttack \{ name: "([^"]+)"[\s\S]*?message: "((?:[^"\\]|\\.)*)" \}/g)) {
    out.push({ name: m[1], message: unescapeRust(m[2]) });
  }
  return out;
}
