import { useEffect, useMemo, useState } from 'react';
import { useTable, micros, tag, type RowOf } from './useTable';

export type DecisionCaseRow = RowOf<'decisionCase'>;
export type CaseDecisionRow = RowOf<'caseDecision'>;
export type ModelVersionRow = RowOf<'modelVersion'>;
export type LearnedRuleRow = RowOf<'learnedRule'>;
export type LabeledDecisionRow = RowOf<'labeledDecision'>;

/** The feature snapshot the module builds for every case (`decision.rs::build_snapshot`). */
export interface CaseSnapshot {
  claim: { claim_ref: string; customer: string; claim_type: string; amount_claimed_cents: number };
  pass: { id: number; station_id: string; satellite_id: number; status: string; start_micros: number; duration_min: number; max_elevation_deg: number; revenue_cents: number };
  telemetry: { expected_mb: number; received_mb: number; loss_pct: number; snr_db: number; signal_lost_offset_s: number | null };
  weather: { timestamp_micros: number | null; kp_index: number; flare_class: string; dst_index: number; storm: boolean };
  station_history: { passes_30d: number; drops_30d: number; drop_rate_pct: number; maintenance_overlap: boolean; maintenance_note: string | null };
  contract: {
    contract_id: string; tier: string; sla_clause: string; credit_pct: number; max_credit_cents: number; weather_exclusion: boolean;
    claim_window_days: number; days_since_pass: number; within_window: boolean; entitled_credit_cents: number;
  };
  ml: { failure_probability: number; model_version: string; source: string; shap: { feature: string; value: number }[] };
}

export function parseJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function dollars(cents: bigint | number): string {
  const v = Number(cents) / 100;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const SYSTEM_LABELS: Record<string, string> = {
  System1: 'System 1',
  System2: 'System 2',
  LearnedRule: 'Learned rule',
  Guard: 'Guard',
  Human: 'Human',
};

export const CLAIM_TYPE_LABELS: Record<string, string> = {
  DroppedPass: 'Dropped pass',
  DegradedLink: 'Degraded link',
  LateDelivery: 'Late delivery',
};

/** Mirrors `WORKER_STALE_SECS` in `decision.rs`; the worker heartbeats every 5 s. */
export const WORKER_STALE_S = 15;
/** Mirrors `INJECTION_RUN_TIMEOUT_SECS` in `decision.rs`. */
export const INJECTION_RUN_TIMEOUT_S = 60;

/** The decision worker's heartbeat, re-evaluated every second so it goes offline when heartbeats stop. */
export function useWorkerStatus() {
  const workers = useTable('workerStatus');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const worker = workers[0] ?? null;
  const silenceS = worker ? Math.max(0, Math.round((now * 1000 - Number(micros(worker.lastSeen))) / 1e6)) : null;
  return { worker, silenceS, online: silenceS !== null && silenceS <= WORKER_STALE_S, now };
}

export function useDecisionData() {
  const cases = useTable('decisionCase');
  const steps = useTable('caseDecision');
  const models = useTable('modelVersion');
  const rules = useTable('learnedRule');
  const labels = useTable('labeledDecision');
  const { worker, online: workerOnline } = useWorkerStatus();
  const messages = useTable('disputeMessage');

  return useMemo(() => {
    const sortedCases = [...cases].sort((a, b) => Number(b.id - a.id));
    const stepsByCase = new Map<bigint, CaseDecisionRow[]>();
    for (const s of [...steps].sort((a, b) => Number(a.id - b.id))) {
      const list = stepsByCase.get(s.caseId) ?? [];
      list.push(s);
      stepsByCase.set(s.caseId, list);
    }
    const sortedModels = [...models].sort((a, b) => b.version - a.version);
    const active = sortedModels.find(m => tag(m.status) === 'Active') ?? null;
    const labelByCase = new Map<bigint, LabeledDecisionRow>();
    let historyLabels = 0;
    for (const l of labels) {
      if (l.caseId !== undefined) labelByCase.set(l.caseId, l);
      if (l.source === 'history') historyLabels++;
    }
    const modelByLabel = new Map<bigint, ModelVersionRow>();
    for (const m of models) if (m.triggeredByLabel !== undefined) modelByLabel.set(m.triggeredByLabel, m);
    const messageById = new Map(messages.map(m => [m.id, m]));
    return {
      cases: sortedCases,
      escalated: sortedCases.filter(c => tag(c.status) === 'Escalated'),
      stepsByCase,
      models: sortedModels,
      active,
      rules: [...rules].sort((a, b) => Number(b.id - a.id)),
      labels,
      labelByCase,
      modelByLabel,
      messageById,
      labelCount: labels.length,
      historyLabels,
      worker,
      workerOnline,
    };
  }, [cases, steps, models, rules, labels, worker, workerOnline, messages]);
}

export type DecisionData = ReturnType<typeof useDecisionData>;
