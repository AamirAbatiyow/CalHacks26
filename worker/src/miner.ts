/**
 * Pattern miner for policy proposals. A proposal is made only when at least three
 * reviewers made the same decision on the same kind of claim, cited the same
 * decisive evidence, and no labeled decision with those feature values went the
 * other way. A single decision never creates a rule.
 */

import { ruleContext, type RuleContext } from './features.ts';
import type { Label } from './retrain.ts';
import { describe, matches, type Condition } from './policy.ts';

export const MIN_SUPPORT = 3;
export const MIN_REVIEWERS = 3;

/** Which rule features each kind of decisive evidence speaks to. Text is never a rule input. */
export const DECISIVE_FEATURES: Record<string, (keyof RuleContext)[]> = {
  telemetry: ['telemetry_loss_pct', 'pass_completed'],
  space_weather: ['storm'],
  contract_clause: ['weather_exclusion', 'within_window'],
  station_history: ['maintenance_overlap', 'station_drop_rate_pct'],
  amount: ['amount_ratio_pct'],
};

const BUCKETS: Partial<Record<keyof RuleContext, number[]>> = {
  telemetry_loss_pct: [0, 5, 25, 40, 60, 101],
  amount_ratio_pct: [0, 101, 200, 1001],
  station_drop_rate_pct: [0, 10, 25, 101],
};

function conditionsFor(ctx: RuleContext, decisive: string[]): Condition[] | null {
  const features = [...new Set(decisive.flatMap(d => DECISIVE_FEATURES[d] ?? []))].sort();
  if (features.length === 0) return null;
  const conditions: Condition[] = [{ feature: 'claim_type', op: 'eq', value: ctx.claim_type }];
  for (const f of features) {
    const v = ctx[f];
    const edges = BUCKETS[f];
    if (typeof v === 'boolean') {
      conditions.push({ feature: f, op: 'eq', value: v });
    } else if (edges && typeof v === 'number') {
      const i = edges.findIndex((e, k) => k < edges.length - 1 && v >= e && v < edges[k + 1]);
      if (i < 0) return null;
      conditions.push({ feature: f, op: 'gte', value: edges[i] }, { feature: f, op: 'lt', value: edges[i + 1] });
    }
  }
  return conditions;
}

export interface Proposal {
  signature: string;
  approve: boolean;
  conditions: Condition[];
  description: string;
  sourceLabelIds: number[];
  support: number;
  distinctReviewers: number;
  contradictions: number;
}

export interface Candidate extends Proposal {
  blockedBy: string | null;
}

export interface MineResult {
  proposals: Proposal[];
  /** Closest patterns that did not qualify, for the UI. */
  nearMisses: Candidate[];
  note: string;
}

export function mine(labels: Label[], knownSignatures: Set<string> = new Set()): MineResult {
  const contexts = labels.map(l => ({ label: l, ctx: ruleContext(l.snapshot) }));
  const groups = new Map<string, { conditions: Condition[]; approve: boolean; decisive: string; members: Label[] }>();
  for (const { label, ctx } of contexts) {
    const decisive = [...new Set(label.decisiveEvidence)].sort();
    const conditions = conditionsFor(ctx, decisive);
    if (!conditions) continue;
    const key = JSON.stringify({ approve: label.approve, conditions });
    const g = groups.get(key) ?? { conditions, approve: label.approve, decisive: decisive.join('+'), members: [] };
    g.members.push(label);
    groups.set(key, g);
  }

  const candidates: Candidate[] = [];
  for (const [signature, g] of groups) {
    const contradictions = contexts.filter(c => c.label.approve !== g.approve && matches(g.conditions, c.ctx)).length;
    const distinctReviewers = new Set(g.members.map(m => m.reviewer)).size;
    const blockedBy = contradictions > 0
      ? `contradicted by ${contradictions} decision${contradictions === 1 ? '' : 's'}`
      : g.members.length < MIN_SUPPORT
        ? `${g.members.length} of ${MIN_SUPPORT} consistent decisions`
        : distinctReviewers < MIN_REVIEWERS
          ? `${distinctReviewers} of ${MIN_REVIEWERS} distinct reviewers`
          : null;
    candidates.push({
      signature,
      approve: g.approve,
      conditions: g.conditions,
      description: describe(g.conditions, g.approve),
      sourceLabelIds: g.members.map(m => m.id),
      support: g.members.length,
      distinctReviewers,
      contradictions,
      blockedBy,
    });
  }

  const proposals = candidates.filter(c => c.blockedBy === null && !knownSignatures.has(c.signature));
  const nearMisses = candidates
    .filter(c => c.blockedBy !== null && c.support >= 2)
    .sort((a, b) => a.contradictions - b.contradictions || b.support - a.support)
    .slice(0, 5);
  const qualified = candidates.filter(c => c.blockedBy === null).length;
  const note = proposals.length > 0
    ? `${proposals.length} new consistent pattern${proposals.length === 1 ? '' : 's'} found`
    : qualified > 0
      ? `No new pattern: all ${qualified} consistent patterns already proposed`
      : `No consistent pattern found in ${labels.length} labeled decisions, so no rule was proposed`;
  return { proposals, nearMisses, note };
}
