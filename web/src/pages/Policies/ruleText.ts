/**
 * Plain-English reading of a learned rule. Clauses are read from the rule's own Cedar
 * (`context.<key> == "<value>"` in its `when` block, `@outcome` annotation), so the sentence
 * restates exactly what Cedar enforces. Wording follows the band definitions in
 * server/spacetimedb/src/evidence.rs (`weather_band`, `lost_band`, `claim_vs_contract`, ...).
 * Pure, so it runs under `node --test`.
 */

export type Outcome = 'approve' | 'partial' | 'deny';

export interface Clause {
  key: string;
  value: string;
  /** Short form for a chip, e.g. "Lost: under 25%". */
  short: string;
  /** Clause for the sentence, e.g. "under 25% of the contact was lost". */
  phrase: string;
}

const humanize = (s: string) => s.replace(/_/g, ' ');

export const CLAIM_TYPES: Record<string, { name: string; noun: string; hint: string }> = {
  dropped_pass: { name: 'Dropped pass', noun: 'dropped pass', hint: '90% or more of the contact lost' },
  partial_downlink: { name: 'Partial downlink', noun: 'partial downlink', hint: 'part of the contact lost' },
  data_integrity: { name: 'Data integrity', noun: 'data integrity claim', hint: 'integrity check not passed, under 25% lost' },
};

const CLAUSES: Record<string, Record<string, [short: string, phrase: string]>> = {
  weather_band: {
    clear: ['Space weather: clear', "space weather was more than 1 Kp below the contract's storm exclusion"],
    near_threshold: ['Space weather: near exclusion', "space weather was within 1 Kp of the contract's storm exclusion"],
    excluded: ['Space weather: excluded', "space weather reached the contract's storm exclusion"],
  },
  maintenance: {
    none: ['Maintenance: none', 'no maintenance overlapped the pass'],
    notified: ['Maintenance: full notice', 'maintenance was announced with the notice the contract requires'],
    short_notice: ['Maintenance: short notice', 'maintenance was announced with less notice than the contract requires'],
    unplanned: ['Maintenance: unplanned outage', 'the station had an unplanned outage'],
  },
  integrity: {
    pass: ['Integrity check: passed', 'the data integrity check passed'],
    fail: ['Integrity check: failed', 'the data integrity check failed'],
    pending: ['Integrity check: pending', 'the data integrity check was still pending'],
  },
  lost_band: {
    under_25: ['Lost: under 25%', 'under 25% of the contact was lost'],
    '25_to_59': ['Lost: 25–59%', '25–59% of the contact was lost'],
    '60_plus': ['Lost: 60% or more', '60% or more of the contact was lost'],
  },
  claim_vs_contract: {
    over: ['Claim: over contract credit', 'the claim asks more than 110% of the contract credit'],
    within: ['Claim: within contract credit', 'the claim is within the contract credit'],
  },
  msg_cites_weather: {
    yes: ['Message blames weather', "the customer's message blames space weather"],
    no: ['Message does not blame weather', "the customer's message does not blame space weather"],
  },
  elevation_band: {
    below_contract_min: ['Elevation: below contract minimum', "the pass stayed below the contract's minimum elevation"],
    ok: ['Elevation: meets contract minimum', "the pass met the contract's minimum elevation"],
  },
  account: {
    new: ['Account: new', 'the account is new'],
    established: ['Account: established', 'the account is established'],
  },
};

export function clause(key: string, value: string): Clause {
  if (key === 'claim_type') {
    const t = CLAIM_TYPES[value];
    return { key, value, short: t?.name ?? humanize(value), phrase: `the claim is a ${t?.noun ?? humanize(value)}` };
  }
  if (key === 'tier') return { key, value, short: `Tier: ${value}`, phrase: `the contract is ${value} tier` };
  const known = CLAUSES[key]?.[value];
  if (known) return { key, value, short: known[0], phrase: known[1] };
  return { key, value, short: `${humanize(key)}: ${humanize(value)}`, phrase: `${humanize(key)} is ${humanize(value)}` };
}

/** `key=value` strings as stored on `mined_rule.conditions`. */
export function parseConditions(conditions: string[]): Array<{ key: string; value: string }> {
  return conditions.flatMap(c => {
    const i = c.indexOf('=');
    return i > 0 ? [{ key: c.slice(0, i), value: c.slice(i + 1) }] : [];
  });
}

/** Equality clauses of the Cedar `when` block, in order; null if there is none to read. */
export function cedarConditions(cedar: string): Array<{ key: string; value: string }> | null {
  const when = cedar.match(/\bwhen\s*\{([\s\S]*)\}/);
  if (!when) return null;
  const out = [...when[1].matchAll(/context\.(\w+)\s*==\s*"([^"]*)"/g)].map(m => ({ key: m[1], value: m[2] }));
  return out.length > 0 ? out : null;
}

export function cedarOutcome(cedar: string): string | null {
  return cedar.match(/@outcome\("([^"]*)"\)/)?.[1] ?? null;
}

export const OUTCOME: Record<Outcome, { label: string; verb: string; pays: string }> = {
  approve: { label: 'Approve', verb: 'is approved', pays: 'pays the claim, up to the contract credit' },
  partial: { label: 'Partial', verb: 'gets partial credit', pays: 'pays the contract formula, not the amount claimed' },
  deny: { label: 'Deny', verb: 'is denied', pays: 'pays $0' },
};

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface ReadableRule {
  claimType: string;
  outcome: string;
  clauses: Clause[];
  sentence: string;
  /** True when the clauses come from the Cedar text rather than the stored conditions. */
  fromCedar: boolean;
}

/** Reads a learned rule; Cedar wins over the stored conditions because Cedar is what runs. */
export function readRule(rule: { cedarText: string; conditions: string[]; outcome: string }): ReadableRule {
  const fromCedar = cedarConditions(rule.cedarText);
  const conds = fromCedar ?? parseConditions(rule.conditions);
  const outcome = cedarOutcome(rule.cedarText) ?? rule.outcome;
  const claimType = conds.find(c => c.key === 'claim_type')?.value ?? '';
  const clauses = conds.map(c => clause(c.key, c.value));
  const rest = clauses.filter(c => c.key !== 'claim_type').map(c => c.phrase);
  const subject = claimType ? `A ${CLAIM_TYPES[claimType]?.noun ?? humanize(claimType)}` : 'A claim';
  const o = OUTCOME[outcome as Outcome];
  const verb = o?.verb ?? `is decided ${humanize(outcome)}`;
  const sentence = rest.length > 0 ? `${subject} where ${joinAnd(rest)} ${verb}.` : `${subject} ${verb}.`;
  return { claimType, outcome, clauses, sentence, fromCedar: fromCedar !== null };
}

/** Most common non-empty text and how many times it appears. */
export function mostCommon(texts: string[]): { text: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const t of texts) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: { text: string; count: number } | null = null;
  for (const [text, count] of counts) if (!best || count > best.count) best = { text, count };
  return best;
}

/** Numeric suffix of a rule id such as "v6-learned-12", for ordering. */
export function ruleNumber(ruleId: string): number {
  return Number(ruleId.match(/(\d+)$/)?.[1] ?? 0);
}
