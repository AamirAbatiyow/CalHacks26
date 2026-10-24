/**
 * Case snapshot shape (built by the module in `decision.rs::build_snapshot`) and the
 * structured features System 1 reads. System 1 never sees the customer's text.
 */

export type ClaimType = 'dropped_pass' | 'degraded_link' | 'late_delivery';

export interface Snapshot {
  schema: number;
  claim: { claim_ref: string; customer: string; claim_type: ClaimType; amount_claimed_cents: number; filed_at_micros: number };
  pass: {
    id: number; station_id: string; satellite_id: number; status: string; start_micros: number; end_micros: number;
    duration_min: number; max_elevation_deg: number; revenue_cents: number;
  };
  telemetry: { pass_id: number; expected_mb: number; received_mb: number; loss_pct: number; snr_db: number; signal_lost_offset_s: number | null };
  weather: { timestamp_micros: number | null; kp_index: number; flare_class: string; dst_index: number; storm: boolean };
  station_history: {
    station_id: string; passes_30d: number; drops_30d: number; drop_rate_pct: number;
    maintenance_overlap: boolean; maintenance_id: number | null; maintenance_note: string | null;
  };
  contract: {
    customer: string; contract_id: string; tier: string; sla_clause: string; credit_pct: number; max_credit_cents: number;
    weather_exclusion: boolean; claim_window_days: number; days_since_pass: number; within_window: boolean; entitled_credit_cents: number;
  };
  ml: { failure_probability: number; model_version: string; source: string; shap: { feature: string; value: number }[] };
  [extra: string]: unknown;
}

export const COMPLETED_LOSS_PCT = 5;

/** Cedar context for learned rules. Mirrors `decision_logic.rs::rule_context`. */
export interface RuleContext {
  claim_type: ClaimType;
  telemetry_loss_pct: number;
  pass_completed: boolean;
  storm: boolean;
  kp_x10: number;
  weather_exclusion: boolean;
  within_window: boolean;
  maintenance_overlap: boolean;
  amount_ratio_pct: number;
  station_drop_rate_pct: number;
}

export function ruleContext(s: Snapshot): RuleContext {
  const loss = Math.trunc(s.telemetry.loss_pct);
  const entitled = s.contract.entitled_credit_cents;
  const claimed = s.claim.amount_claimed_cents;
  return {
    claim_type: s.claim.claim_type,
    telemetry_loss_pct: loss,
    pass_completed: s.pass.status === 'Ok' && loss < COMPLETED_LOSS_PCT,
    storm: s.weather.storm,
    kp_x10: Math.round(s.weather.kp_index * 10),
    weather_exclusion: s.contract.weather_exclusion,
    within_window: s.contract.within_window,
    maintenance_overlap: s.station_history.maintenance_overlap,
    amount_ratio_pct: entitled <= 0 ? 1000 : Math.min(1000, Math.trunc((claimed * 100) / entitled)),
    station_drop_rate_pct: s.station_history.drop_rate_pct,
  };
}

export const FEATURE_NAMES = [
  'bias',
  'ml_failure_prob',
  'telemetry_loss',
  'pass_completed',
  'kp_norm',
  'storm',
  'weather_exclusion',
  'storm_x_exclusion',
  'within_window',
  'amount_ratio',
  'inflated_amount',
  'station_drop_rate',
  'maintenance_overlap',
  'type_dropped',
  'type_degraded',
  'type_late',
  'degraded_x_loss',
  'degraded_x_storm',
  'late_x_maintenance',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export function featurize(s: Snapshot): number[] {
  const c = ruleContext(s);
  const loss = c.telemetry_loss_pct / 100;
  const ratio = Math.min(c.amount_ratio_pct, 400) / 100;
  const t = c.claim_type;
  const b = (v: boolean) => (v ? 1 : 0);
  const named: Record<FeatureName, number> = {
    bias: 1,
    ml_failure_prob: s.ml.failure_probability,
    telemetry_loss: loss,
    pass_completed: b(c.pass_completed),
    kp_norm: s.weather.kp_index / 9,
    storm: b(c.storm),
    weather_exclusion: b(c.weather_exclusion),
    storm_x_exclusion: b(c.storm && c.weather_exclusion),
    within_window: b(c.within_window),
    amount_ratio: ratio,
    inflated_amount: b(c.amount_ratio_pct > 200),
    station_drop_rate: c.station_drop_rate_pct / 100,
    maintenance_overlap: b(c.maintenance_overlap),
    type_dropped: b(t === 'dropped_pass'),
    type_degraded: b(t === 'degraded_link'),
    type_late: b(t === 'late_delivery'),
    degraded_x_loss: t === 'degraded_link' ? loss : 0,
    degraded_x_storm: b(t === 'degraded_link' && c.storm),
    late_x_maintenance: b(t === 'late_delivery' && c.maintenance_overlap),
  };
  return FEATURE_NAMES.map(n => named[n]);
}

export function namedFeatures(x: number[]): Record<string, number> {
  return Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, Math.round(x[i] * 1000) / 1000]));
}

/** Evidence rows a System 2 answer may cite for this claim. */
export function evidenceRefs(s: Snapshot, messageId: number | null): string[] {
  const refs = [
    `pass:${s.pass.id}`,
    `pass_telemetry:${s.telemetry.pass_id}`,
    `station:${s.pass.station_id}`,
    `contract_term:${s.contract.customer}`,
  ];
  if (s.weather.timestamp_micros != null) refs.push(`space_weather:${s.weather.timestamp_micros}`);
  if (s.station_history.maintenance_id != null) refs.push(`station_maintenance:${s.station_history.maintenance_id}`);
  if (messageId != null) refs.push(`dispute_message:${messageId}`);
  return refs;
}

/** Port of `decision_logic.rs::ml_failure_proxy`, used for synthetic history. */
export function mlFailureProxy(kp: number, elev: number, dropRate: number, maintenance: boolean, strongFlare: boolean) {
  const terms: [string, number][] = [
    ['Kp index', 0.55 * (Math.max(kp - 3, 0) - 0.3)],
    ['Max elevation', 0.03 * (Math.max(40 - elev, 0) - 5)],
    ['Station drop rate (30d)', 4 * (dropRate - 0.06)],
    ['Maintenance overlap', maintenance ? 1.2 : 0],
    ['M/X flare', strongFlare ? 0.8 : 0],
  ];
  const logit = -2.6 + terms.reduce((a, [, v]) => a + v, 0);
  const p = 1 / (1 + Math.exp(-logit));
  return {
    probability: Math.round(p * 10000) / 10000,
    shap: terms.map(([feature, v]) => ({ feature, value: Math.round(v * 1000) / 1000 })),
  };
}

export function entitledCreditCents(revenue: number, creditPct: number, claimType: ClaimType, lossPct: number, maxCredit: number): number {
  const base = (revenue * creditPct) / 100;
  const share = claimType === 'dropped_pass' ? 1 : claimType === 'degraded_link' ? lossPct / 100 : 0.25;
  return Math.min(Math.max(Math.round(base * share), 0), Math.max(maxCredit, 0));
}
