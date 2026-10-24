import { useMemo, useState } from 'react';
import {
  Bot, CheckCircle2, CloudLightning, Cpu, FileText, Inbox, Info, Play, ScrollText, ShieldCheck, ShieldX, UserCheck, Wifi, WifiOff, Zap,
  type LucideIcon,
} from 'lucide-react';
import { micros, reducers, tag } from '../../hooks/useTable';
import {
  CLAIM_TYPE_LABELS, SYSTEM_LABELS, parseJson, useDecisionData, type CaseDecisionRow, type DecisionCaseRow, type LearnedRuleRow,
} from '../../hooks/useDecisions';
import { openReplay } from '../../replay/useDecisionTrace';
import { FlowGraph, COMPACT_NODE_W, type GraphEdge, type GraphNode } from '../../ui/FlowGraph';
import { Drawer, Fact } from '../../ui/Drawer';
import { Chip, type Tone } from '../../ui/Chip';
import { Meter, TrendLine } from '../../ui/charts';
import { CountUp, compactUsd, usd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { escalationChip } from '../Approvals/CaseReview';
import { useTechMode } from '../../hooks/useTechMode';
import { plainEscalation, plainReason } from '../../utils/plainReason';
import { DataTable, type Column } from '../../ui/DataTable';
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

function ago(ts: unknown): string {
  const s = Math.max(0, Math.round((Date.now() * 1000 - Number(micros(ts))) / 1e6));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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

type Open = { kind: 'case'; c: DecisionCaseRow } | { kind: 'rule'; r: LearnedRuleRow };

export default function DecisionsPage() {
  const d = useDecisionData();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const tech = useTechMode();
  const columns = useMemo(() => caseColumns(tech), [tech]);
  const active = d.active;
  const lastLive = d.models.find(m => m.triggeredByLabel !== undefined) ?? null;
  const promoted = d.rules.filter(r => tag(r.status) === 'Promoted');
  const auto = d.cases.filter(c => tag(c.status) === 'AutoDecided').length;

  const file = async (scenario: string) => {
    setError(null);
    try {
      await reducers()?.fileDemoCase({ scenarioName: scenario });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const flow = useMemo(() => {
    let s1 = 0, rule = 0, s2Ran = 0, guard = 0, escalated = 0, autoCents = 0, claimedCents = 0;
    for (const c of d.cases) {
      const by = tag(c.decidedBy);
      const status = tag(c.status);
      claimedCents += Number(c.amountClaimedCents);
      if (by === 'System1') s1++;
      if (by === 'LearnedRule') rule++;
      if (by === 'Guard') guard++;
      if (status === 'Escalated' || by === 'Human') escalated++;
      if (status === 'AutoDecided') autoCents += Number(c.finalCreditCents);
      if ((d.stepsByCase.get(c.id) ?? []).some(s => tag(s.system) === 'System2')) s2Ran++;
    }
    const nodes: GraphNode[] = [
      { id: 'claims', title: 'Claims', icon: FileText, value: String(d.cases.length), sub: compactUsd(claimedCents) },
      { id: 's1', title: 'System 1', icon: Cpu, value: String(s1 + rule), sub: '≥ 95% auto', hint: 'Model decides alone at 95% confidence or higher' },
      { id: 's2', title: 'System 2', icon: Bot, value: String(s2Ran), sub: 'reads all sources', hint: 'Below 95%, System 2 reads every source, including the customer message' },
      { id: 'cedar', title: 'Cedar', icon: ShieldCheck, value: String(auto), sub: guard > 0 ? `${guard} guarded` : 'final say', hint: 'Cedar policy has the final say on every automatic decision' },
      { id: 'auto', title: 'Auto', icon: Zap, value: compactUsd(autoCents), sub: `${auto} claims`, tone: 'pass', emphasis: true },
      { id: 'human', title: 'Approvals', icon: Inbox, value: String(escalated), sub: '< 95% · evidence', tone: escalated > 0 ? 'warn' : 'neutral', emphasis: escalated > 0 },
    ];
    const edges: GraphEdge[] = [
      { from: 'claims', to: 's1' },
      { from: 's1', to: 'cedar', tone: 'pass' },
      { from: 's1', to: 's2', dashed: true },
      { from: 's2', to: 'cedar', tone: 'pass' },
      { from: 's2', to: 'human', tone: 'warn', dashed: true },
      { from: 'cedar', to: 'auto', tone: 'pass' },
    ];
    return { nodes, edges };
  }, [d.cases, d.stepsByCase, auto]);

  const trend = useMemo(() => [...d.models].reverse().map(m => ({ x: `v${m.version}`, y: m.precisionPct })), [d.models]);

  const openCase = open?.kind === 'case' ? open.c : null;
  const openRule = open?.kind === 'rule' ? open.r : null;

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
        <Stat label="Auto-decided" sub={`of ${d.cases.length}`}>{auto}</Stat>
        <span className="dz-worker" title={d.worker ? `System 2 ${d.worker.mode} (${d.worker.llmModel})` : undefined}>
          <Chip tone={d.workerOnline ? 'pass' : 'block'} icon={d.workerOnline ? Wifi : WifiOff}>
            Worker {d.workerOnline ? 'online' : 'offline'}
          </Chip>
        </span>
      </div>}

      <div className={`dz-body ${tech ? '' : 'dz-body-simple'}`}>
        <div className="dz-col">
          {!tech && (
            <section className="dz-section">
              <span className="ui-section-title">File a claim</span>
              <div className="dz-actions">
                {SCENARIOS.map(([k, v, Icon]) => (
                  <button key={k} className="dz-btn" onClick={() => file(k)}><Icon size={12} /> {v}</button>
                ))}
              </div>
              {error && <div className="dz-error">{error}</div>}
            </section>
          )}
          {tech && (<>
          <section className="dz-section">
            <div className="dz-section-head">
              <span className="ui-section-title">Pipeline</span>
              <span className="dz-info" title="System 1 auto-decides at 95% confidence or higher (Cedar has the final say); otherwise System 2 reads every source, including the customer message, and below 95% the claim goes to Approvals with the full evidence package.">
                <Info size={12} />
              </span>
            </div>
            <FlowGraph nodes={flow.nodes} edges={flow.edges} height={220} rankSep={24} nodeWidth={COMPACT_NODE_W} label="Decision pipeline with live claim counts" />
            <div className="dz-actions">
              {SCENARIOS.map(([k, v, Icon]) => (
                <button key={k} className="dz-btn" onClick={() => file(k)}><Icon size={12} /> {v}</button>
              ))}
            </div>
            {error && <div className="dz-error">{error}</div>}
          </section>

          <section className="dz-section">
            <span className="ui-section-title">System 1 precision by version</span>
            {d.models.length === 0 ? (
              <EmptyState art="graph" compact title="No model yet" hint="Start the worker: cd worker && npm start" />
            ) : (
              <>
                {trend.length > 1 && <TrendLine data={trend} threshold={95} format={v => `${v.toFixed(1)}%`} label="Auto-approve precision per System 1 version; dashed line is 95%" />}
                <div className="dz-table">
                  <div className="dz-tr dz-th">
                    <span>Version</span><span>Status</span><span>Precision</span><span>Coverage</span><span>Labels</span>
                  </div>
                  {d.models.slice(0, 8).map(m => (
                    <div
                      key={m.version}
                      className={`dz-tr ${tag(m.status) === 'Active' ? 'active' : ''}`}
                      title={`ECE ${m.ece.toFixed(3)} · ${m.triggeredByLabel !== undefined ? `live in ${m.latencyMs.toFixed(0)} ms after label #${m.triggeredByLabel}` : `bootstrap fit ${m.fitMs.toFixed(0)} ms`} · ${m.note}`}
                    >
                      <span className="dz-mono">s1-v{m.version}</span>
                      <span><Chip tone={tag(m.status) === 'Active' ? 'pass' : 'neutral'}>{tag(m.status)}</Chip></span>
                      <span className="dz-num">{m.precisionPct.toFixed(2)}%</span>
                      <span className="dz-num">{m.coveragePct.toFixed(1)}%</span>
                      <span className="dz-num">{m.trainedRows.toLocaleString()}{m.liveLabels > 0 && <span className="dz-muted"> +{m.liveLabels}</span>}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="dz-section">
            <div className="dz-section-head">
              <span className="ui-section-title">Learned rules</span>
              <span
                className="dz-info"
                title={`A rule is proposed only when three or more reviewers made the same decision on the same kind of claim, citing the same deciding evidence, and no labeled decision contradicts it. It is stored as Cedar, replayed on ${d.labelCount.toLocaleString()} labeled decisions, and promoted only if precision does not regress. Customer text is never a rule input.`}
              >
                <Info size={12} />
              </span>
            </div>
            {d.worker?.note && <p className="dz-note" title={d.worker.note}>{d.worker.note}</p>}
            {d.rules.length === 0 ? (
              <EmptyState art="graph" compact title="No rule proposed" hint="No consistent pattern in the labeled decisions yet." />
            ) : (
              <div className="dz-rules">
                {d.rules.map(r => {
                  const ok = tag(r.status) === 'Promoted';
                  return (
                    <button key={String(r.id)} className="dz-rule ui-row-hover" onClick={() => setOpen({ kind: 'rule', r })} title={r.description}>
                      <span className="dz-mono">L{String(r.id)}</span>
                      <Chip tone={ok ? 'pass' : 'block'}>{tag(r.status)}</Chip>
                      <span className="dz-ellipsis">{tag(r.verdict)} · {CLAIM_TYPE_LABELS[r.claimType.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('')] ?? r.claimType}</span>
                      <span className="dz-rule-support" aria-label={`${r.support} consistent decisions`}>
                        <Meter value={Math.min(r.support, 40)} max={40} label={`${r.support} consistent decisions`} />
                        <span className="dz-num">{r.support}</span>
                      </span>
                      <span className="dz-num dz-muted">{r.precisionAfter >= r.precisionBefore ? '+' : '−'}{Math.abs(r.precisionAfter - r.precisionBefore).toFixed(2)} pts</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          </>)}
        </div>

        <section className="dz-section dz-feed">
          <span className="ui-section-title">Decisions</span>
          {d.cases.length === 0 ? <EmptyState art="inbox" compact title="No claims filed yet" hint="File one above." /> : (
            <DataTable
              rows={d.cases}
              columns={columns}
              rowKey={c => String(c.id)}
              defaultSort={{ key: 'ref', dir: 'desc' }}
              onRowClick={c => setOpen({ kind: 'case', c })}
              rowTitle={c => (tech ? [c.modelVersion, c.policyVersion].filter(Boolean).join(' · ') : undefined)}
              limit={60}
              label="Decided claims"
            />
          )}
        </section>
      </div>

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        eyebrow={openCase ? `${openCase.claimRef} · ${CLAIM_TYPE_LABELS[tag(openCase.claimType)]}` : openRule ? `Learned rule L${openRule.id}` : ''}
        title={openCase ? openCase.customer : openRule ? openRule.description : ''}
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
        {openRule && (
          <>
            <div className="ui-chips">
              <Chip tone={tag(openRule.status) === 'Promoted' ? 'pass' : 'block'}>{tag(openRule.status)}</Chip>
              <Chip>{openRule.support} decisions</Chip>
              <Chip>{openRule.distinctReviewers} reviewers</Chip>
              <Chip tone={openRule.contradictions > 0 ? 'warn' : 'neutral'}>{openRule.contradictions} contradictions</Chip>
            </div>
            <Fact label="Precision" value={`${openRule.precisionBefore.toFixed(2)}% → ${openRule.precisionAfter.toFixed(2)}%`} />
            <pre className="dz-cedar">{openRule.cedarText}</pre>
            <p className="ui-quote">{openRule.reason} · {openRule.triggeredByLabel !== undefined ? `completed by label #${openRule.triggeredByLabel}` : 'mined from history'} · {ago(openRule.createdAt)}</p>
          </>
        )}
      </Drawer>
    </div>
  );
}
