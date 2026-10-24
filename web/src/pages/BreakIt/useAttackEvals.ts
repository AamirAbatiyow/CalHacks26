import { useMemo } from 'react';
import { tag, useTable, type RowOf } from '../../hooks/useTable';
import { ATTACK_TYPE_LABELS, type AttackType } from './types';

export type AttackEvalRow = RowOf<'attackEval'>;
export type AttackClearance = RowOf<'attackClearance'>;
export type Outcome = 'caught' | 'escalated' | 'missed';

export interface Totals {
  total: number;
  caught: number;
  escalated: number;
  missed: number;
  protectedCents: number;
  badCents: number;
  policyVersion: string;
  modelVersion: string;
}

export const attackTypeOf = (row: AttackEvalRow) => tag(row.attackType) as AttackType;
export const CLUSTER_PARAM = 'cluster=storm-overclaim';

export function totals(rows: AttackEvalRow[]): Totals {
  const t: Totals = { total: 0, caught: 0, escalated: 0, missed: 0, protectedCents: 0, badCents: 0, policyVersion: '', modelVersion: '' };
  const policies = new Set<string>();
  const models = new Set<string>();
  for (const r of rows) {
    t.total++;
    if (r.outcome === 'caught') t.caught++;
    else if (r.outcome === 'escalated') t.escalated++;
    else t.missed++;
    t.protectedCents += Number(r.protectedCents);
    t.badCents += Number(r.badCents);
    if (r.decidedBy === 'policy') {
      policies.add(r.policyVersion);
      models.add(r.modelVersion);
    }
  }
  const first = rows[0];
  t.policyVersion = [...policies].sort().join(', ') || first?.policyVersion || '';
  t.modelVersion = [...models].sort().join(', ') || first?.modelVersion || '';
  return t;
}

/** Both decisions of every attack in a run: the earlier policy and model ("before") and the active ones ("after"). */
export function useAttackEvals(sessionId: bigint | null) {
  const rows = useTable('attackEval');
  const clearances = useTable('attackClearance');
  return useMemo(() => {
    const own = sessionId === null ? [] : rows.filter(r => r.sessionId === sessionId).sort((a, b) => Number(a.id - b.id));
    const after = own.filter(r => r.label === 'after');
    const before = own.filter(r => r.label === 'before');
    const beforeByFixture = new Map(before.map(r => [r.fixtureId, r]));
    const sessionClearances = clearances.filter(c => c.sessionId === sessionId).sort((a, b) => Number(a.id - b.id));
    return { after, before, beforeByFixture, clearances: sessionClearances };
  }, [rows, clearances, sessionId]);
}

export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function usd(cents: bigint | number): string {
  const c = Number(cents);
  const d = Math.abs(c) / 100;
  const s = d < 100 && c % 100 !== 0 ? d.toFixed(2) : Math.round(d).toLocaleString('en-US');
  return `${c < 0 ? '-' : ''}$${s}`;
}

export function outcomeTone(outcome: string) {
  return outcome === 'caught' ? 'pass' : outcome === 'escalated' ? 'warn' : 'block';
}

export function attackTitle(row: AttackEvalRow) {
  return `${ATTACK_TYPE_LABELS[attackTypeOf(row)]} · ${usd(row.claimedCents)}`;
}
