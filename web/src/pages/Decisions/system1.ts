/**
 * System 1 scoring in the browser, so the Decisions page can show what the live model does
 * with real labeled history. Port of `worker/src/features.ts::featurize` and
 * `decision_logic.rs::system1_features`; pure, so it runs under `node --test`.
 */

/** Mirrors `AUTO_DECIDE_CONFIDENCE_PCT` in `decision_logic.rs`. */
export const AUTO_DECIDE_PCT = 95;
/** Mirrors `COMPLETED_LOSS_PCT` in `decision_logic.rs`. */
const COMPLETED_LOSS_PCT = 5;

/** The parts of the module's case snapshot System 1 reads. Customer text is not among them. */
export interface S1Snapshot {
  claim: { claim_type: string; amount_claimed_cents: number };
  pass: { status: string };
  telemetry: { loss_pct: number };
  weather: { kp_index: number; storm: boolean };
  station_history: { drop_rate_pct: number; maintenance_overlap: boolean };
  contract: { weather_exclusion: boolean; within_window: boolean; entitled_credit_cents: number };
  ml: { failure_probability: number };
}

/** Plain-English name for each model input, in the worker's `FEATURE_NAMES` order. */
export const FEATURE_LABELS: Record<string, string> = {
  bias: 'Baseline',
  ml_failure_prob: 'Pass-failure score',
  telemetry_loss: 'Share of data lost',
  pass_completed: 'Pass completed cleanly',
  kp_norm: 'Geomagnetic activity (Kp)',
  storm: 'Storm at the time (Kp ≥ 5)',
  weather_exclusion: 'Contract excludes space weather',
  storm_x_exclusion: 'Storm and contract excludes it',
  within_window: 'Filed inside the claim window',
  amount_ratio: 'Amount claimed vs. entitled',
  inflated_amount: 'Claims over 2× the entitlement',
  station_drop_rate: 'Station drop rate, last 30 days',
  maintenance_overlap: 'Station maintenance overlapped',
  type_dropped: 'Claim type: dropped pass',
  type_degraded: 'Claim type: degraded link',
  type_late: 'Claim type: late delivery',
  degraded_x_loss: 'Degraded link × data lost',
  degraded_x_storm: 'Degraded link during a storm',
  late_x_maintenance: 'Late delivery during maintenance',
};

export function featurize(s: S1Snapshot, names: readonly string[]): number[] {
  const loss = Math.trunc(s.telemetry.loss_pct);
  const entitled = s.contract.entitled_credit_cents;
  const ratioPct = entitled <= 0 ? 1000 : Math.min(1000, Math.trunc((s.claim.amount_claimed_cents * 100) / entitled));
  const t = s.claim.claim_type;
  const storm = s.weather.storm;
  const exclusion = s.contract.weather_exclusion;
  const maintenance = s.station_history.maintenance_overlap;
  const b = (v: boolean) => (v ? 1 : 0);
  const named: Record<string, number> = {
    bias: 1,
    ml_failure_prob: s.ml.failure_probability,
    telemetry_loss: loss / 100,
    pass_completed: b(s.pass.status === 'Ok' && loss < COMPLETED_LOSS_PCT),
    kp_norm: s.weather.kp_index / 9,
    storm: b(storm),
    weather_exclusion: b(exclusion),
    storm_x_exclusion: b(storm && exclusion),
    within_window: b(s.contract.within_window),
    amount_ratio: Math.min(ratioPct, 400) / 100,
    inflated_amount: b(ratioPct > 200),
    station_drop_rate: s.station_history.drop_rate_pct / 100,
    maintenance_overlap: b(maintenance),
    type_dropped: b(t === 'dropped_pass'),
    type_degraded: b(t === 'degraded_link'),
    type_late: b(t === 'late_delivery'),
    degraded_x_loss: t === 'degraded_link' ? loss / 100 : 0,
    degraded_x_storm: b(t === 'degraded_link' && storm),
    late_x_maintenance: b(t === 'late_delivery' && maintenance),
  };
  return names.map(n => named[n] ?? 0);
}

/** Approve probability: the logistic of `weights · x`. */
export function predict(weights: readonly number[], x: readonly number[]): number {
  let z = 0;
  for (let i = 0; i < weights.length; i++) z += weights[i] * (x[i] ?? 0);
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Confidence in the leaning verdict, as `submit_system1` computes it. */
export function confidencePct(pApprove: number): number {
  return (pApprove >= 0.5 ? pApprove : 1 - pApprove) * 100;
}

export type Lane = 'fast-approve' | 'fast-deny' | 'deep';

export function laneOf(pApprove: number): Lane {
  if (confidencePct(pApprove) < AUTO_DECIDE_PCT) return 'deep';
  return pApprove >= 0.5 ? 'fast-approve' : 'fast-deny';
}

export interface ScoredLabel {
  id: number;
  humanApproved: boolean;
  pApprove: number;
  lane: Lane;
  /** System 1's leaning verdict matches the human's. */
  agrees: boolean;
}

export function scoreLabel(id: number, humanApproved: boolean, s: S1Snapshot, weights: readonly number[], names: readonly string[]): ScoredLabel {
  const p = predict(weights, featurize(s, names));
  return { id, humanApproved, pApprove: p, lane: laneOf(p), agrees: (p >= 0.5) === humanApproved };
}

export interface LaneSplit {
  total: number;
  fastApprove: number;
  fastApproveAgree: number;
  fastDeny: number;
  fastDenyAgree: number;
  deep: number;
  /** Share of all rows System 1 would decide alone. */
  fastPct: number;
  /** Share of fast-lane rows where System 1 matched the human. */
  fastAgreePct: number;
}

/** How the model splits past human rulings between the fast lane and deep review. */
export function laneSplit(rows: readonly ScoredLabel[]): LaneSplit {
  let fastApprove = 0, fastApproveAgree = 0, fastDeny = 0, fastDenyAgree = 0, deep = 0;
  for (const r of rows) {
    if (r.lane === 'fast-approve') {
      fastApprove++;
      if (r.agrees) fastApproveAgree++;
    } else if (r.lane === 'fast-deny') {
      fastDeny++;
      if (r.agrees) fastDenyAgree++;
    } else {
      deep++;
    }
  }
  const total = rows.length;
  const fast = fastApprove + fastDeny;
  return {
    total,
    fastApprove,
    fastApproveAgree,
    fastDeny,
    fastDenyAgree,
    deep,
    fastPct: total ? (100 * fast) / total : 0,
    fastAgreePct: fast ? (100 * (fastApproveAgree + fastDenyAgree)) / fast : 0,
  };
}

export interface Driver {
  name: string;
  label: string;
  /** Contribution to the log-odds of approval: weight × value. */
  contribution: number;
}

/** Inputs that moved this prediction most, strongest first. The baseline is left out. */
export function drivers(weights: readonly number[], x: readonly number[], names: readonly string[], limit = 4): Driver[] {
  return names
    .map((name, i) => ({ name, label: FEATURE_LABELS[name] ?? name, contribution: (weights[i] ?? 0) * (x[i] ?? 0) }))
    .filter(d => d.name !== 'bias' && Math.abs(d.contribution) > 1e-6)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, limit);
}
