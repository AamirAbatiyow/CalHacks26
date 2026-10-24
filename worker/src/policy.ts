/**
 * Learned-rule conditions and the automated routing they feed. Mirrors the Cedar
 * the module generates in `decision_logic.rs::cedar_for_rule` and the routing in
 * `decision.rs::submit_system1`, so rules can be replayed on history in the worker.
 */

import { featurize, ruleContext, type RuleContext, type Snapshot } from './features.ts';
import { predict, AUTO_DECIDE_P } from './system1.ts';

export interface Condition {
  feature: keyof RuleContext;
  op: 'eq' | 'gte' | 'lt';
  value: string | number | boolean;
}

export interface Rule {
  id: number;
  approve: boolean;
  conditions: Condition[];
}

export function matches(conditions: Condition[], ctx: RuleContext): boolean {
  return conditions.every(c => {
    const v = ctx[c.feature];
    if (c.op === 'eq') return v === c.value;
    if (c.op === 'gte') return typeof v === 'number' && v >= (c.value as number);
    return typeof v === 'number' && v < (c.value as number);
  });
}

export function describe(conditions: Condition[], approve: boolean): string {
  const parts: string[] = [];
  const byFeature = new Map<string, Condition[]>();
  for (const c of conditions) byFeature.set(c.feature, [...(byFeature.get(c.feature) ?? []), c]);
  for (const [feature, cs] of byFeature) {
    if (feature === 'claim_type') {
      parts.unshift(String(cs[0].value).replace('_', ' '));
      continue;
    }
    if (typeof cs[0].value === 'boolean') {
      parts.push(`${cs[0].value ? '' : 'no '}${feature.replace(/_/g, ' ')}`);
      continue;
    }
    const lo = cs.find(c => c.op === 'gte')?.value;
    const hi = cs.find(c => c.op === 'lt')?.value;
    const name = feature.replace(/_pct$/, '').replace(/_/g, ' ');
    parts.push(lo != null && hi != null ? `${name} ${lo}-${hi}%` : lo != null ? `${name} >= ${lo}%` : `${name} < ${hi}%`);
  }
  return `${approve ? 'Approve' : 'Deny'}: ${parts.join(', ')}`;
}

export type Route =
  | { kind: 'system1'; approve: boolean; confidence: number }
  | { kind: 'rule'; approve: boolean; ruleId: number; confidence: number }
  | { kind: 'system2'; approve: boolean; confidence: number };

/** Automated routing for a case with no customer text needed. */
export function route(weights: number[], snapshot: Snapshot, rules: Rule[], textNeeded = false): Route {
  const p = predict(weights, featurize(snapshot));
  const approve = p >= 0.5;
  const confidence = approve ? p : 1 - p;
  if (!textNeeded && confidence >= AUTO_DECIDE_P) return { kind: 'system1', approve, confidence };
  if (!textNeeded) {
    const ctx = ruleContext(snapshot);
    for (const r of rules) if (r.approve === approve && matches(r.conditions, ctx)) return { kind: 'rule', approve, ruleId: r.id, confidence };
  }
  return { kind: 'system2', approve, confidence };
}

export interface ReplayResult {
  precisionPct: number;
  coveragePct: number;
  autoDecided: number;
}

/**
 * Replays System 1 plus `rules` on labeled history and scores every automated
 * decision against the human verdict. Only approvals are automated under the base
 * Cedar policy, so precision is over automated approvals and rule decisions.
 */
export function replayAutomation(weights: number[], rules: Rule[], history: { snapshot: Snapshot; approve: boolean }[]): ReplayResult {
  let auto = 0;
  let correct = 0;
  for (const h of history) {
    const r = route(weights, h.snapshot, rules);
    const automated = (r.kind === 'system1' && r.approve) || r.kind === 'rule';
    if (!automated) continue;
    auto++;
    if (r.approve === h.approve) correct++;
  }
  const n = Math.max(history.length, 1);
  return {
    precisionPct: Math.round((auto ? (100 * correct) / auto : 100) * 100) / 100,
    coveragePct: Math.round(((100 * auto) / n) * 100) / 100,
    autoDecided: auto,
  };
}
