/**
 * Deterministic six months of human-labeled decisions, in the same snapshot shape
 * the module builds for live claims. Used by `seed-history` and by the tests.
 *
 * Reviewers follow the operator's credit practice with 4% disagreement noise. Storm
 * degradation is rare: it only appears in a few hand-placed decisions so that one
 * consistent pattern exists, one is a decision short, and one is contradicted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entitledCreditCents, mlFailureProxy, ruleContext, type ClaimType, type Snapshot } from './features.ts';

export interface Contract {
  customer: string;
  contract_id: string;
  tier: string;
  sla_clause: string;
  credit_pct: number;
  max_credit_cents: number;
  weather_exclusion: boolean;
  claim_window_days: number;
}

export const CONTRACTS: Contract[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../server/fixtures/sla_terms.json', import.meta.url)), 'utf8'),
);

export interface HistoryRow {
  claim_ref: string;
  claim_type: ClaimType;
  customer: string;
  snapshot: Snapshot;
  verdict: 'Approve' | 'Deny';
  credit_cents: number;
  reason_code: string;
  reason_text: string;
  decisive_evidence: string[];
  reviewer: string;
  decided_at_micros: number;
  policy_version: string;
  model_version: string;
}

export const REVIEWERS = ['a.okafor', 'm.lindqvist', 'r.sato', 'j.alvarez', 'p.nair', 'k.brandt', 'e.moreau', 's.haddad'];
const DAY = 86_400_000_000;
/** Contacts are billed per minute at the AWS Ground Station narrowband or wideband rate (fixtures/contracts.json). */
const PASS_MINUTES = 12;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  claimType: ClaimType;
  contract: Contract;
  storm: boolean;
  lossPct: number;
  passOk: boolean;
  maintenance: boolean;
  withinWindow: boolean;
  amountFactor: number;
  dropRate: number;
  elevation: number;
  revenue: number;
  at: number;
}

let passSeq = 900_000;

function snapshotFor(s: Spec, ref: string): Snapshot {
  const kp = s.storm ? 5.2 + ((s.lossPct * 7) % 25) / 10 : 1.5 + ((s.lossPct * 3) % 28) / 10;
  const ml = mlFailureProxy(kp, s.elevation, s.dropRate, s.maintenance, s.storm && kp > 6.5);
  const entitled = entitledCreditCents(s.revenue, s.contract.credit_pct, s.claimType, s.lossPct, s.contract.max_credit_cents);
  const amount = Math.max(100, Math.round((entitled || s.revenue * 0.2) * s.amountFactor));
  const passId = passSeq++;
  const duration = PASS_MINUTES;
  const start = s.at - 3 * DAY;
  const days = s.withinWindow ? 2 : s.contract.claim_window_days + 9;
  return {
    schema: 1,
    claim: { claim_ref: ref, customer: s.contract.customer, claim_type: s.claimType, amount_claimed_cents: amount, filed_at_micros: start + days * DAY },
    pass: {
      id: passId, station_id: 'historical', satellite_id: 0, status: s.passOk ? 'Ok' : 'Dropped',
      start_micros: start, end_micros: start + duration * 60_000_000, duration_min: duration,
      max_elevation_deg: s.elevation, revenue_cents: s.revenue,
    },
    telemetry: {
      pass_id: passId, expected_mb: duration * 90, received_mb: Math.round(duration * 90 * (100 - s.lossPct)) / 100,
      loss_pct: s.lossPct, snr_db: Math.round((14 - s.lossPct * 0.11) * 10) / 10, signal_lost_offset_s: s.lossPct >= 10 ? 600 : null,
    },
    weather: { timestamp_micros: null, kp_index: Math.round(kp * 10) / 10, flare_class: kp > 6.5 ? 'M' : 'None', dst_index: s.storm ? -110 : -10, storm: s.storm },
    station_history: {
      station_id: 'historical', passes_30d: 60, drops_30d: Math.round(60 * s.dropRate), drop_rate_pct: Math.round(s.dropRate * 100),
      maintenance_overlap: s.maintenance, maintenance_id: null, maintenance_note: s.maintenance ? 'Scheduled maintenance' : null,
    },
    contract: {
      customer: s.contract.customer, contract_id: s.contract.contract_id, tier: s.contract.tier, sla_clause: s.contract.sla_clause,
      credit_pct: s.contract.credit_pct, max_credit_cents: s.contract.max_credit_cents, weather_exclusion: s.contract.weather_exclusion,
      claim_window_days: s.contract.claim_window_days, days_since_pass: days, within_window: s.withinWindow, entitled_credit_cents: entitled,
    },
    ml: { failure_probability: ml.probability, model_version: 'ml-proxy-0', source: 'historical replay', shap: ml.shap },
  };
}

/** The credit practice reviewers follow; returns verdict, reason code and decisive evidence. */
export function reviewerPractice(s: Snapshot): { approve: boolean; reason: string; decisive: string[] } {
  const c = ruleContext(s);
  if (!c.within_window) return { approve: false, reason: 'outside_claim_window', decisive: ['contract_clause'] };
  if (c.claim_type !== 'late_delivery' && c.pass_completed) return { approve: false, reason: 'telemetry_shows_completed', decisive: ['telemetry'] };
  if (c.amount_ratio_pct > 200) return { approve: false, reason: 'inflated_amount', decisive: ['amount'] };
  if (c.claim_type === 'dropped_pass') {
    if (c.storm && c.weather_exclusion) return { approve: false, reason: 'weather_exclusion', decisive: ['space_weather', 'contract_clause'] };
    return { approve: true, reason: 'sla_breach', decisive: ['telemetry', 'contract_clause'] };
  }
  if (c.claim_type === 'late_delivery') {
    return c.maintenance_overlap
      ? { approve: true, reason: 'operator_maintenance', decisive: ['station_history'] }
      : { approve: false, reason: 'no_operator_fault', decisive: ['station_history', 'customer_message'] };
  }
  if (c.storm && c.weather_exclusion) return { approve: false, reason: 'weather_exclusion', decisive: ['space_weather', 'contract_clause'] };
  return c.telemetry_loss_pct >= 25
    ? { approve: true, reason: 'degraded_over_threshold', decisive: ['telemetry'] }
    : { approve: false, reason: 'degradation_below_threshold', decisive: ['telemetry'] };
}

const REASON_TEXT: Record<string, string> = {
  outside_claim_window: 'Filed after the contract claim window.',
  telemetry_shows_completed: 'Downlink log shows the full pass was received.',
  inflated_amount: 'Claimed amount far exceeds the contract entitlement.',
  weather_exclusion: 'Storm-caused loss; contract excludes space weather.',
  sla_breach: 'Pass dropped; SLA credit per contract.',
  operator_maintenance: 'Station maintenance caused the delay.',
  no_operator_fault: 'No operator-side cause for the delay.',
  degraded_over_threshold: 'Degradation above the 25% credit threshold.',
  degradation_below_threshold: 'Degradation below the 25% credit threshold.',
  storm_degradation_credited: 'Storm degradation; contract does not exclude space weather.',
  storm_degradation_excluded: 'Storm degradation under a weather-exclusion contract.',
};

function row(s: Spec, i: number, approve: boolean, reason: string, decisive: string[], reviewer: string): HistoryRow {
  const ref = `HIST-${String(i).padStart(5, '0')}`;
  const snapshot = snapshotFor(s, ref);
  return {
    claim_ref: ref,
    claim_type: s.claimType,
    customer: s.contract.customer,
    snapshot,
    verdict: approve ? 'Approve' : 'Deny',
    credit_cents: approve ? Math.min(snapshot.contract.entitled_credit_cents, snapshot.claim.amount_claimed_cents) : 0,
    reason_code: reason,
    reason_text: REASON_TEXT[reason] ?? reason,
    decisive_evidence: decisive,
    reviewer,
    decided_at_micros: s.at,
    policy_version: 'v4',
    model_version: 'human',
  };
}

export interface HistoryOptions {
  count?: number;
  seed?: number;
  nowMicros?: number;
}

export function generateHistory(opts: HistoryOptions = {}): HistoryRow[] {
  const rand = rng(opts.seed ?? 20261024);
  const now = opts.nowMicros ?? Date.UTC(2026, 9, 24) * 1000;
  const count = opts.count ?? 2400;
  passSeq = 900_000;
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const rows: HistoryRow[] = [];

  for (let i = 0; i < count; i++) {
    const r = rand();
    const claimType: ClaimType = r < 0.55 ? 'dropped_pass' : r < 0.87 ? 'late_delivery' : 'degraded_link';
    const contract = pick(CONTRACTS);
    const storm = claimType !== 'degraded_link' && rand() < (claimType === 'dropped_pass' ? 0.25 : 0.2);
    const completedDrop = claimType === 'dropped_pass' && rand() < 0.12;
    const lossPct = claimType === 'dropped_pass'
      ? (completedDrop ? Math.floor(rand() * 4) : 60 + Math.floor(rand() * 41))
      : claimType === 'late_delivery' ? Math.floor(rand() * 4) : 8 + Math.floor(rand() * 48);
    const spec: Spec = {
      claimType, contract, storm, lossPct,
      passOk: claimType !== 'dropped_pass' || completedDrop,
      maintenance: rand() < (claimType === 'late_delivery' ? 0.3 : 0.05),
      withinWindow: rand() < 0.92,
      amountFactor: rand() < 0.06 ? 2.5 + rand() * 1.5 : 0.8 + rand() * 0.5,
      dropRate: rand() * 0.3,
      elevation: 15 + rand() * 70,
      revenue: PASS_MINUTES * (rand() < 0.5 ? 1500 : 2500),
      at: now - Math.floor((180 * (count - i)) / count * DAY) - Math.floor(rand() * DAY),
    };
    const draft = snapshotFor(spec, 'probe');
    passSeq--;
    let { approve, reason, decisive } = reviewerPractice(draft);
    if (rand() < 0.04) approve = !approve;
    rows.push(row(spec, i, approve, reason, decisive, pick(REVIEWERS)));
  }

  const niche = (contract: string, lossPct: number, approve: boolean, reason: string, decisive: string[], reviewer: string, daysAgo: number) => {
    const spec: Spec = {
      claimType: 'degraded_link', contract: CONTRACTS.find(c => c.customer === contract)!, storm: true, lossPct, passOk: true,
      maintenance: false, withinWindow: true, amountFactor: 1, dropRate: 0.08, elevation: 38, revenue: PASS_MINUTES * 2500, at: now - daysAgo * DAY,
    };
    rows.push(row(spec, rows.length, approve, reason, decisive, reviewer));
  };
  const credited = ['telemetry', 'space_weather', 'contract_clause'];
  // A consistent pattern: four reviewers credited heavy storm degradation without a weather exclusion.
  niche('SkyNet Communications', 46, true, 'storm_degradation_credited', credited, 'a.okafor', 150);
  niche('Nexus Corp', 52, true, 'storm_degradation_credited', credited, 'm.lindqvist', 112);
  niche('Aether Dynamics', 43, true, 'storm_degradation_credited', credited, 'r.sato', 77);
  niche('Orbital Sciences Inc', 57, true, 'storm_degradation_credited', credited, 'j.alvarez', 41);
  // One decision short of a pattern: moderate storm degradation, two reviewers.
  niche('SkyNet Communications', 31, true, 'storm_degradation_credited', credited, 'p.nair', 96);
  niche('Aether Dynamics', 36, true, 'storm_degradation_credited', credited, 'k.brandt', 29);
  // Contradicted: storm degradation under weather-exclusion contracts went both ways.
  niche('Polar Data Systems', 44, true, 'storm_degradation_credited', ['space_weather', 'contract_clause'], 'e.moreau', 133);
  niche('Helix Orbital', 41, true, 'storm_degradation_credited', ['space_weather', 'contract_clause'], 's.haddad', 88);
  niche('Polar Data Systems', 47, false, 'storm_degradation_excluded', ['space_weather', 'contract_clause'], 'm.lindqvist', 20);

  return rows;
}
