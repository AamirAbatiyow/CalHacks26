import { useMemo } from 'react';
import { Bot, Check, Clock, Hourglass, Play, User, X, type LucideIcon } from 'lucide-react';
import type { DecisionRecord } from '../../types';
import { openReplay } from '../../replay/useDecisionTrace';
import { formatDollars } from '../../utils/money';
import { C, SplitBar } from '../../ui/charts';
import { CountUp, compactUsd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { DataTable, type Column } from '../../ui/DataTable';
import { useTechMode } from '../../hooks/useTechMode';
import { plainReason } from '../../utils/plainReason';
import type { Tone } from '../../ui/Chip';

interface AuditTabProps {
  decisions: DecisionRecord[];
}

function formatTimestamp(micros: bigint): string {
  const date = new Date(Number(micros / BigInt(1000)));
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const DECISION_LABELS: Record<string, string> = {
  DisputeCreated: 'Dispute created',
  DisputeResolved: 'Dispute resolved',
  CreditIssued: 'Credit issued',
  PassDropped: 'Pass dropped',
  PassRecovered: 'Pass recovered',
};

const CEDAR_RULES: Record<string, string> = {
  DisputeCreated: 'dispute::create',
  DisputeResolved: 'dispute::resolve',
  CreditIssued: 'credit::issue',
  PassDropped: 'pass::drop',
  PassRecovered: 'pass::recover',
};

const OUTCOMES = ['AutoApproved', 'Approved', 'Denied', 'Escalated', 'Pending'] as const;
type OutcomeKey = (typeof OUTCOMES)[number];

const OUTCOME_META: Record<OutcomeKey, { label: string; color: string; tone: Tone; icon: LucideIcon }> = {
  AutoApproved: { label: 'Auto', color: C.accent, tone: 'accent', icon: Bot },
  Approved: { label: 'Approved', color: C.green, tone: 'pass', icon: Check },
  Denied: { label: 'Denied', color: C.red, tone: 'block', icon: X },
  Escalated: { label: 'Escalated', color: C.amber, tone: 'warn', icon: Hourglass },
  Pending: { label: 'Pending', color: C.muted, tone: 'neutral', icon: Clock },
};

function isHuman(outcome: string): boolean {
  return outcome === 'Escalated' || outcome === 'Approved' || outcome === 'Denied';
}

function makeColumns(tech: boolean): Column<DecisionRecord>[] {
  return [
  { key: 'time', label: 'Time', width: '150px', sort: d => Number(d.createdAt), render: d => <span className="ui-table-muted">{formatTimestamp(d.createdAt)}</span> },
  { key: 'claim', label: 'Claim', width: '120px', sort: d => Number(d.passId ?? 0), render: d => (d.passId ? `Pass #${d.passId}` : d.stationId || '—') },
  { key: 'decision', label: 'Decision', width: '140px', sort: d => d.decisionType, render: d => DECISION_LABELS[d.decisionType] ?? d.decisionType },
  { key: 'reason', label: 'Reason', width: 'minmax(0, 1fr)', render: d => <span className="ui-table-muted">{tech ? d.reason : plainReason(d.reason)}</span> },
  { key: 'amount', label: 'Amount', width: '90px', align: 'right', sort: d => Number(d.amountCents), render: d => <b className="audit-amount">{formatDollars(d.amountCents)}</b> },
  {
    key: 'outcome', label: 'Outcome', width: '110px', sort: d => d.outcome,
    render: d => {
      const meta = OUTCOME_META[d.outcome as OutcomeKey] ?? OUTCOME_META.Pending;
      const Icon = meta.icon;
      return <span className={`ui-chip tone-${meta.tone}`}><Icon size={11} aria-hidden />{meta.label}</span>;
    },
  },
  {
    key: 'by', label: 'By', width: '64px', sort: d => (isHuman(d.outcome) ? 1 : 0),
    render: d => (isHuman(d.outcome)
      ? <span className="audit-by"><User size={12} aria-hidden />Human</span>
      : <span className="audit-by"><Bot size={12} aria-hidden />AI</span>),
  },
  { key: 'replay', label: '', width: '64px', render: () => <span className="replay-trigger audit-replay"><Play size={11} aria-hidden />Replay</span> },
  ];
}

export function AuditTab({ decisions }: AuditTabProps) {

  const tech = useTechMode();
  const columns = useMemo(() => makeColumns(tech), [tech]);
  const { counts, autoShare, dollars } = useMemo(() => {
    const counts: Record<OutcomeKey, number> = { AutoApproved: 0, Approved: 0, Denied: 0, Escalated: 0, Pending: 0 };
    let dollars = 0;
    for (const d of decisions) {
      if ((OUTCOMES as readonly string[]).includes(d.outcome)) counts[d.outcome as OutcomeKey]++;
      dollars += Math.abs(Number(d.amountCents));
    }
    const decided = counts.AutoApproved + counts.Approved + counts.Denied;
    return { counts, dollars, autoShare: decided > 0 ? (counts.AutoApproved / decided) * 100 : 0 };
  }, [decisions]);

  if (decisions.length === 0) {
    return <EmptyState art="graph" title="No decisions recorded yet" hint="Every AI and human decision lands here as it happens." />;
  }

  return (
    <div className="fin-tab">
      <div className="fin-tiles">
        <div className="fin-tile">
          <span className="ui-stat-label">Decisions · 30 days</span>
          <span className="ui-stat-value"><CountUp value={decisions.length} format={n => Math.round(n).toLocaleString('en-US')} /></span>
          <span className="ui-stat-sub">{compactUsd(dollars)} decided</span>
        </div>
        <div className="fin-tile">
          <span className="ui-stat-label">Auto-decided</span>
          <span className="ui-stat-value"><CountUp value={autoShare} format={n => `${n.toFixed(0)}%`} /></span>
          <span className="ui-stat-sub">of {(counts.AutoApproved + counts.Approved + counts.Denied).toLocaleString('en-US')} final decisions</span>
        </div>
        <div className="fin-tile fin-tile-wide">
          <span className="ui-stat-label">Outcome mix</span>
          <SplitBar
            label={OUTCOMES.map(o => `${OUTCOME_META[o].label} ${counts[o]}`).join(', ')}
            parts={OUTCOMES.map(o => ({ label: `${OUTCOME_META[o].label} ${counts[o].toLocaleString('en-US')}`, value: counts[o], color: OUTCOME_META[o].color }))}
          />
          <div className="ui-legend">
            {OUTCOMES.map(o => (
              <span key={o} className="ui-legend-item">
                <span className="ui-legend-swatch" style={{ background: OUTCOME_META[o].color }} />
                {OUTCOME_META[o].label} <b>{counts[o].toLocaleString('en-US')}</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      <DataTable
        rows={decisions}
        columns={columns}
        rowKey={d => d.id.toString()}
        defaultSort={{ key: 'time', dir: 'desc' }}
        onRowClick={d => openReplay(`audit:${d.id}`)}
        rowTitle={d => tech
          ? `${CEDAR_RULES[d.decisionType] ?? 'policy::default'} · policy ${d.policyVersion} · model ${d.modelVersion}\n${d.reason}`
          : plainReason(d.reason)}
        label="Decision audit"
        className="fin-table-v2 audit-table-v2"
      />
    </div>
  );
}
