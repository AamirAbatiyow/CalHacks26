import { useMemo } from 'react';
import { micros, tag, useTable, type RowOf } from '../../hooks/useTable';
import { parseJson, useDecisionData, type CaseSnapshot, type LabeledDecisionRow } from '../../hooks/useDecisions';
import { laneSplit, scoreLabel, type LaneSplit, type ScoredLabel } from './system1';

export type PipelineStepRow = RowOf<'pipelineStep'>;
export type PolicyRow = RowOf<'cedarPolicyStore'>;
export type AuthzRow = RowOf<'authorizationLog'>;

/** A labeled row's snapshot never changes, so each one is parsed once per page load. */
const snapshotCache = new Map<bigint, CaseSnapshot | null>();

function snapshotOf(l: LabeledDecisionRow): CaseSnapshot | null {
  let s = snapshotCache.get(l.id);
  if (s === undefined) {
    s = parseJson<CaseSnapshot>(l.snapshotJson);
    if (s && !(s.claim && s.telemetry && s.contract && s.ml && s.weather && s.station_history && s.pass)) s = null;
    snapshotCache.set(l.id, s);
  }
  return s;
}

export interface History {
  rows: ScoredLabel[];
  split: LaneSplit;
  byId: Map<number, ScoredLabel>;
}

/** Everything the Decisions page shows: the decision tables, plus per-stage live counts and a replay of System 1 over labeled history. */
export function usePipeline() {
  const d = useDecisionData();
  const steps = useTable('pipelineStep');
  const policies = useTable('cedarPolicyStore');
  const authz = useTable('authorizationLog');

  const model = useMemo(() => {
    if (!d.active) return null;
    const weights = parseJson<number[]>(d.active.weightsJson);
    const names = parseJson<string[]>(d.active.featureNamesJson);
    return weights && names && weights.length === names.length ? { weights, names } : null;
  }, [d.active]);

  const labels = useMemo(() => [...d.labels].sort((a, b) => Number(a.id - b.id)), [d.labels]);
  const labelById = useMemo(() => new Map(labels.map(l => [l.id, l])), [labels]);

  const history = useMemo<History | null>(() => {
    if (!model || labels.length === 0) return null;
    const rows: ScoredLabel[] = [];
    for (const l of labels) {
      const s = snapshotOf(l);
      if (s) rows.push(scoreLabel(Number(l.id), tag(l.verdict) === 'Approve', s, model.weights, model.names));
    }
    return { rows, split: laneSplit(rows), byId: new Map(rows.map(r => [r.id, r])) };
  }, [model, labels]);

  const live = useMemo(() => {
    const stage = new Map<string, PipelineStepRow[]>();
    for (const s of [...steps].sort((a, b) => Number(a.id - b.id))) {
      const list = stage.get(s.stage) ?? [];
      list.push(s);
      stage.set(s.stage, list);
    }
    const cases = (k: string) => new Set((stage.get(k) ?? []).map(s => s.caseId)).size;
    let claimed = 0, autoCents = 0, s1Ran = 0, fast = 0, rule = 0, s2Ran = 0, auto = 0, waiting = 0, humanDecided = 0;
    for (const c of d.cases) {
      const by = tag(c.decidedBy);
      const status = tag(c.status);
      const caseSteps = d.stepsByCase.get(c.id) ?? [];
      claimed += Number(c.amountClaimedCents);
      if (caseSteps.some(s => tag(s.system) === 'System1')) s1Ran++;
      if (caseSteps.some(s => tag(s.system) === 'System2')) s2Ran++;
      if (status === 'AutoDecided') {
        auto++;
        autoCents += Number(c.finalCreditCents);
        if (by === 'System1') fast++;
        if (by === 'LearnedRule') rule++;
      }
      if (status === 'Escalated') waiting++;
      if (status === 'HumanDecided') humanDecided++;
    }
    const screened = stage.get('injection') ?? [];
    const reverify = stage.get('reverify') ?? [];
    const cedar = stage.get('cedar') ?? [];
    const last = (k: string) => {
      const list = stage.get(k);
      return list && list.length ? list[list.length - 1] : null;
    };
    return {
      claimed,
      autoCents,
      s1Ran,
      fast,
      rule,
      s2Ran,
      auto,
      waiting,
      humanDecided,
      screenedCases: cases('injection'),
      flagged: new Set(screened.filter(s => s.verdict === 'Flagged').map(s => s.caseId)).size,
      reverifyPassed: reverify.filter(s => s.detail === '').length,
      reverifyFailed: reverify.filter(s => s.detail !== '').length,
      cedarAllow: cedar.filter(s => s.verdict === 'ALLOW').length,
      cedarDeny: cedar.filter(s => s.verdict !== 'ALLOW').length,
      lastScreen: last('injection'),
      lastReverify: last('reverify'),
      lastCedar: last('cedar'),
    };
  }, [steps, d.cases, d.stepsByCase]);

  const policy = useMemo(() => {
    const sorted = [...policies].sort((a, b) => Number(micros(b.createdAt) - micros(a.createdAt)));
    return { active: sorted.find(p => p.isActive) ?? null, versions: sorted };
  }, [policies]);

  const authzLog = useMemo(() => [...authz].sort((a, b) => Number(b.id - a.id)), [authz]);

  return { ...d, model, labelsSorted: labels, labelById, history, live, policy, authzLog };
}

export type PipelineData = ReturnType<typeof usePipeline>;
