import { useMemo, useState } from 'react';
import {
  Bot, CheckCircle2, CloudLightning, Cpu, FileText, Inbox, ListChecks, Play, ScrollText, ShieldCheck, ShieldX, UserCheck, Wifi, WifiOff, Zap,
  type LucideIcon,
} from 'lucide-react';
import { reducers, tag } from '../../hooks/useTable';
import { CLAIM_TYPE_LABELS, SYSTEM_LABELS, parseJson, type CaseDecisionRow, type DecisionCaseRow } from '../../hooks/useDecisions';
import { openReplay } from '../../replay/useDecisionTrace';
import { Drawer } from '../../ui/Drawer';
import { Chip, type Tone } from '../../ui/Chip';
import { Meter } from '../../ui/charts';
import { CountUp, compactUsd, usd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { escalationChip } from '../Claims/CaseReview';
import { useTechMode } from '../../hooks/useTechMode';
import { plainEscalation, plainReason } from '../../utils/plainReason';
import { DataTable, type Column } from '../../ui/DataTable';
import { PipelineMap, type StageCard } from './PipelineMap';
import { STAGE_ORDER, type StageId } from './stages';
import { StageDetail } from './StageDetail';
import { usePipeline } from './usePipeline';
import { AUTO_DECIDE_PCT } from './system1';
import './Decisions.css';

const SCENARIOS: readonly (readonly [string, string, LucideIcon])[] = [
  ['storm_degraded', 'Storm link, 32% loss', CloudLightning],
  ['storm_degraded_heavy', 'Storm link, 47% loss', CloudLightning],
  ['calm_drop', 'Dropped pass, calm', WifiOff],
  ['completed_pass', 'Completed pass', CheckCircle2],
];

const SYSTEM_ICONS: Record<string, LucideIcon> = {
  System1: Cpu,
  System2: Bot,
  LearnedRule: ScrollText,
  Guard: ShieldX,
  Human: UserCheck,
};

const SYSTEM_TONES: Record<string, Tone> = {
  System1: 'pass',
  System2: 'neutral',
  LearnedRule: 'accent',
  Guard: 'block',
  Human: 'neutral',
};

function SystemChip({ system }: { system: string }) {
  return <Chip tone={SYSTEM_TONES[system] ?? 'neutral'} icon={SYSTEM_ICONS[system]}>{SYSTEM_LABELS[system] ?? system}</Chip>;
}

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="dz-stat">
      <span className="dz-stat-label">{label}</span>
      <span className="dz-stat-value">{children}{sub && <span className="dz-stat-sub"> {sub}</span>}</span>
    </div>
  );
}

function verdictChip(c: DecisionCaseRow, tech: boolean) {
  const status = tag(c.status);
  const verdict = tag(c.finalVerdict);
  if (status === 'Escalated') {
    return <Chip tone="warn" icon={Inbox} title={tech ? c.escalationReason : undefined}>{tech ? escalationChip(c.escalationReason) : plainEscalation(c.escalationReason)}</Chip>;
  }
  if (verdict === 'Approve') return <Chip tone="pass">{usd(c.finalCreditCents)}</Chip>;
  if (verdict) return <Chip>{verdict}</Chip>;
  return <Chip tone="accent">Deciding</Chip>;
}

function caseColumns(tech: boolean): Column<DecisionCaseRow>[] {
  return [
    { key: 'ref', label: 'Claim', width: '96px', sort: c => c.claimRef, render: c => <span className="dz-mono">{c.claimRef}</span> },
    { key: 'customer', label: 'Customer', width: 'minmax(0, 1fr)', sort: c => c.customer, render: c => c.customer },
    { key: 'type', label: 'Type', width: '110px', sort: c => tag(c.claimType), render: c => <span className="ui-table-muted">{CLAIM_TYPE_LABELS[tag(c.claimType)] ?? ''}</span> },
    { key: 'amount', label: 'Claimed', width: '84px', align: 'right', sort: c => Number(c.amountClaimedCents), render: c => usd(c.amountClaimedCents) },
    {
      key: 'by', label: 'Decided by', width: '110px', sort: c => tag(c.decidedBy) ?? '',
      render: c => {
        const by = tag(c.decidedBy);
        if (!by) return <span className="dz-muted">{tech ? (tag(c.status) === 'Queued' ? 'System 1…' : 'System 2…') : 'Deciding…'}</span>;
        if (tech) return <SystemChip system={by} />;
        if (tag(c.status) === 'Escalated') return <span className="dz-muted">Awaiting review</span>;
        return <span className="dz-muted">{by === 'Human' ? 'Reviewer' : 'Automatic'}</span>;
      },
    },
    { key: 'result', label: 'Result', width: '130px', sort: c => Number(c.finalCreditCents), render: c => verdictChip(c, tech) },
  ];
}

function StepCard({ d }: { d: CaseDecisionRow }) {
  const checks = parseJson<Record<string, unknown>>(d.checksJson) ?? {};
  const scalarChecks = Object.entries(checks).filter(([, v]) => typeof v !== 'object' || v === null);
  const verdict = tag(d.verdict);
  return (
    <div className="dz-step">
      <div className="dz-step-head">
        <SystemChip system={tag(d.system)} />
        <span className="dz-step-verdict">{verdict}</span>
        <span className="dz-mono dz-muted">{d.modelVersion} · {d.policyVersion}</span>
      </div>
      <Meter value={d.confidencePct} max={100} threshold={95} label={`Confidence ${d.confidencePct.toFixed(1)}%; tick marks 95%`} />
      <span className="dz-muted">{d.confidencePct.toFixed(1)}% confidence</span>
      {d.rationale && <p className="ui-quote">{d.rationale}</p>}
      {(d.citedEvidence.length > 0 || scalarChecks.length > 0) && (
        <div className="ui-chips">
          {d.citedEvidence.map(e => <Chip key={e} icon={FileText}>{e.split(':')[0]}</Chip>)}
          {scalarChecks.map(([k, v]) => (
            <Chip key={k}>{k.replace(/_/g, ' ')}: {typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v)}</Chip>
          ))}
        </div>
      )}
      <details className="dz-inputs">
        <summary>Inputs</summary>
        <pre>{d.inputsJson}</pre>
      </details>
    </div>
  );
}

const STAGE_IDS = new Set<string>(STAGE_ORDER);

function initialStage(): StageId {
  const param = window.location.hash.replace(/^#\/?/, '').split(/[?]/)[0].split('/')[1];
  return param && STAGE_IDS.has(param) ? (param as StageId) : 's1';
}

export default function DecisionsPage() {
  const d = usePipeline();
  const [error, setError] = useState<string | null>(null);
  const [openCase, setOpenCase] = useState<DecisionCaseRow | null>(null);
  const [stageId, setStageId] = useState<StageId>(initialStage);
  const tech = useTechMode();
  const columns = useMemo(() => caseColumns(tech), [tech]);
  const active = d.active;
  const lastLive = d.models.find(m => m.triggeredByLabel !== undefined) ?? null;
  const promoted = d.rules.filter(r => tag(r.status) === 'Promoted');
  const split = d.history?.split ?? null;

  const select = (id: StageId) => {
    setStageId(id);
    window.history.replaceState(null, '', `#/decisions/${id}`);
  };

  const file = async (scenario: string) => {
    setError(null);
    try {
      await reducers()?.fileDemoCase({ scenarioName: scenario });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stages = useMemo<StageCard[]>(() => {
    const l = d.live;
    const offline = d.workerOnline ? undefined : 'worker offline';
    const policyVersion = d.policy.active?.version;
    return [
      { id: 'claims', kicker: 'Claims intake', name: 'Evidence assembled', tech: 'SpacetimeDB reducer', metric: `${compactUsd(l.claimed)} claimed`, icon: FileText, lane: 'intake', count: String(d.cases.length), countTitle: 'Claims filed' },
      { id: 's1', kicker: 'System 1', name: 'Numbers-only model', tech: `Logistic model · ${active ? `s1-v${active.version}` : 'none yet'}`, metric: `≥ ${AUTO_DECIDE_PCT}% sure: decides alone`, icon: Cpu, lane: 'fast', count: String(l.s1Ran), countTitle: 'Live claims scored', warn: offline },
      { id: 'rules', kicker: 'Learned rules', name: 'Rules from rulings', tech: 'Cedar rules, mined', metric: `${promoted.length} live rule${promoted.length === 1 ? '' : 's'}`, icon: ScrollText, lane: 'deep', count: String(l.rule), countTitle: 'Live claims decided by a rule' },
      { id: 'screen', kicker: 'Injection screen', name: 'Message check', tech: 'Worker text screen', metric: l.flagged ? `${l.flagged} flagged` : 'hidden instructions?', icon: ShieldX, lane: 'deep', count: String(l.screenedCases), countTitle: 'Messages screened' },
      { id: 's2', kicker: 'System 2', name: 'LLM analyst', tech: `${d.worker?.llmModel ?? 'LLM'} · strict JSON`, metric: 'reads every source', icon: Bot, lane: 'deep', count: String(l.s2Ran), countTitle: 'Live claims reviewed', warn: offline },
      { id: 'reverify', kicker: 'Re-verify', name: 'Checks the AI', tech: 'Rust reducer in the DB', metric: 'evidence · amount · S1', icon: ListChecks, lane: 'deep', count: String(l.reverifyPassed + l.reverifyFailed), countTitle: 'Proposals re-verified' },
      { id: 'cedar', kicker: 'Cedar', name: 'Final say', tech: `AWS Cedar${policyVersion ? ` · policy ${policyVersion}` : ''}`, metric: 'AI acts only if permitted', icon: ShieldCheck, lane: 'fast', count: String(l.cedarAllow + l.cedarDeny), countTitle: 'Permission checks on live claims' },
      { id: 'auto', kicker: 'Decided', name: 'Paid or denied', tech: 'One DB transaction', metric: `${compactUsd(l.autoCents)} credited`, icon: Zap, lane: 'outcome', count: String(l.auto), countTitle: 'Auto-decided claims' },
      { id: 'human', kicker: 'Human review', name: 'Ops reviewer', tech: 'Claims queue', metric: l.waiting ? `${l.waiting} waiting` : 'decides what AI cannot', icon: UserCheck, lane: 'human', count: String(l.waiting + l.humanDecided), countTitle: 'Claims sent to a person' },
    ];
  }, [d.live, d.cases.length, d.workerOnline, d.worker, d.policy.active, active, promoted.length]);

  const stage = stages.find(s => s.id === stageId) ?? stages[1];
  const fastStat = split && split.total
    ? `${split.fastPct.toFixed(0)}% of ${split.total.toLocaleString()} past claims · ${split.fastAgreePct.toFixed(1)}% match the human`
    : undefined;
  const deepStat = split && split.total ? `${(100 - split.fastPct).toFixed(0)}% of past claims` : undefined;

  return (
    <div className="dz-page">
      {tech && <div className="dz-strip">
        <div className="dz-title">Decisions</div>
        <Stat label="System 1" sub={active ? `${active.liveLabels} live labels` : 'no model'}>{active ? `s1-v${active.version}` : '—'}</Stat>
        <Stat label="Auto-approve precision" sub={active ? `coverage ${active.coveragePct.toFixed(1)}%` : ''}>
          {active ? <CountUp value={active.precisionPct} format={v => `${v.toFixed(2)}%`} /> : '—'}
        </Stat>
        <Stat label="Calibration" sub={active ? `Brier ${active.brier.toFixed(3)}` : ''}>{active ? `ECE ${active.ece.toFixed(3)}` : '—'}</Stat>
        <Stat label="Decision to live model" sub={lastLive ? `s1-v${lastLive.version}` : 'no live label yet'}>{lastLive ? `${lastLive.latencyMs.toFixed(0)} ms` : '—'}</Stat>
        <Stat label="Learned rules" sub={`of ${d.rules.length}`}>{promoted.length}</Stat>
        <Stat label="Auto-decided" sub={`of ${d.cases.length}`}>{d.live.auto}</Stat>
        <span className="dz-worker" title={d.worker ? `System 2 ${d.worker.mode} (${d.worker.llmModel})` : undefined}>
          <Chip tone={d.workerOnline ? 'pass' : 'block'} icon={d.workerOnline ? Wifi : WifiOff}>
            Worker {d.workerOnline ? 'online' : 'offline'}
          </Chip>
        </span>
      </div>}

      <div className="dz-scroll">
        <section className="dz-hero">
          <div className="dz-hero-head">
            <div className="dz-hero-text">
              <span className="ui-eyebrow">Decision pipeline</span>
              <h1 className="dz-hero-title">How a claim gets decided</h1>
              <p className="dz-hero-lede">
                Every claim meets <b>System 1</b>, a fast numbers-only model, first. When it is at least {AUTO_DECIDE_PCT}% sure, the claim takes
                the <b className="dz-fast">fast lane</b>: no LLM call, straight to Cedar for permission. Otherwise it takes <b className="dz-deep">deep review</b>,
                where an LLM reads everything and the database checks its work. Select any stage to see its technology, accuracy and real data.
              </p>
            </div>
            <div className="dz-legend" aria-label="Legend">
              <span className="dz-legend-item fast"><i /> Fast lane</span>
              <span className="dz-legend-item deep"><i /> Deep review</span>
              <span className="dz-legend-item human"><i /> To a person</span>
              <span className="dz-legend-item loop"><i /> Learning loop</span>
            </div>
          </div>
          <PipelineMap stages={stages} selected={stage.id} onSelect={select} fastStat={fastStat} deepStat={deepStat} />
          <div className="dz-try">
            <span className="ui-muted">Try it: file a test claim and watch the counts move</span>
            <div className="dz-actions">
              {SCENARIOS.map(([k, v, Icon]) => (
                <button key={k} className="dz-btn" onClick={() => file(k)}><Icon size={12} /> {v}</button>
              ))}
            </div>
            {error && <div className="dz-error">{error}</div>}
          </div>
        </section>

        <StageDetail d={d} stage={stage} tech={tech} onSelect={select} />

        <section className="dz-section dz-feed">
          <span className="ui-section-title">Decisions</span>
          {d.cases.length === 0 ? <EmptyState art="inbox" compact title="No claims filed yet" hint="File one above." /> : (
            <DataTable
              rows={d.cases}
              columns={columns}
              rowKey={c => String(c.id)}
              defaultSort={{ key: 'ref', dir: 'desc' }}
              onRowClick={c => setOpenCase(c)}
              rowTitle={c => (tech ? [c.modelVersion, c.policyVersion].filter(Boolean).join(' · ') : undefined)}
              limit={60}
              label="Decided claims"
            />
          )}
        </section>
      </div>

      <Drawer
        open={openCase !== null}
        onClose={() => setOpenCase(null)}
        eyebrow={openCase ? `${openCase.claimRef} · ${CLAIM_TYPE_LABELS[tag(openCase.claimType)]}` : ''}
        title={openCase ? openCase.customer : ''}
      >
        {openCase && (
          <>
            <div className="ui-chips">
              {verdictChip(openCase, tech)}
              <Chip>{usd(openCase.amountClaimedCents)} claimed</Chip>
              {openCase.attackName && <Chip tone="block">Attack: {openCase.attackName}</Chip>}
              {openCase.similarTo !== undefined && <Chip>Similar claim</Chip>}
            </div>
            <button className="dz-btn dz-replay" onClick={() => openReplay(`case:${openCase.claimRef}`)}><Play size={12} /> Replay path</button>
            {openCase.escalationReason && <p className="ui-quote">{tech ? openCase.escalationReason : plainReason(openCase.escalationReason)}</p>}
            {tech && (d.stepsByCase.get(openCase.id) ?? []).map(s => <StepCard key={String(s.id)} d={s} />)}
          </>
        )}
      </Drawer>
    </div>
  );
}
