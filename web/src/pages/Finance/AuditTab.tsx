import { useMemo } from 'react';
import { Bot, Check, Clock, Hourglass, Play, User, X, type LucideIcon } from 'lucide-react';
import type { DecisionRecord } from '../../types';
import { openReplay } from '../../replay/useDecisionTrace';
import { formatDollars } from '../../utils/money';
import { C, SplitBar, StackedBars } from '../../ui/charts';
import { CountUp, compactUsd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { dailyBuckets } from '../../ui/series';
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

export function AuditTab({ decisions }: AuditTabProps) {
  const sortedDecisions = useMemo(() => [...decisions].sort((a, b) => Number(b.createdAt - a.createdAt)), [decisions]);

  const { counts, daily, autoShare, dollars } = useMemo(() => {
    const counts: Record<OutcomeKey, number> = { AutoApproved: 0, Approved: 0, Denied: 0, Escalated: 0, Pending: 0 };
    let dollars = 0;
    for (const d of decisions) {
      if ((OUTCOMES as readonly string[]).includes(d.outcome)) counts[d.outcome as OutcomeKey]++;
      dollars += Math.abs(Number(d.amountCents));
    }
    const decided = counts.AutoApproved + counts.Approved + counts.Denied;
    const daily = dailyBuckets(decisions, d => d.createdAt, OUTCOMES, d =>
      (OUTCOMES as readonly string[]).includes(d.outcome) ? { key: d.outcome as OutcomeKey, amount: 1 } : null);
    return { counts, daily, dollars, autoShare: decided > 0 ? (counts.AutoApproved / decided) * 100 : 0 };
  }, [decisions]);

  if (sortedDecisions.length === 0) {
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

      <div className="fin-chart">
        <div className="ui-section-title">Decisions per day by outcome</div>
        <StackedBars
          data={daily}
          series={OUTCOMES.map(o => ({ key: o, label: OUTCOME_META[o].label, color: OUTCOME_META[o].color }))}
          height={110}
          format={v => `${v} decisions`}
          label="Decisions per day over the last 30 days, stacked by outcome"
        />
      </div>

      <table className="audit-table fin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Claim</th>
            <th>Decision</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
            <th>Outcome</th>
            <th aria-label="Actor" />
            <th aria-label="Replay" />
          </tr>
        </thead>
        <tbody>
          {sortedDecisions.map((decision) => {
            const meta = OUTCOME_META[decision.outcome as OutcomeKey] ?? OUTCOME_META.Pending;
            const OutcomeIcon = meta.icon;
            const human = isHuman(decision.outcome);
            return (
              <tr
                key={decision.id.toString()}
                className="audit-row"
                tabIndex={0}
                onClick={() => openReplay(`audit:${decision.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') openReplay(`audit:${decision.id}`); }}
                title={`${CEDAR_RULES[decision.decisionType] ?? 'policy::default'} · policy ${decision.policyVersion} · model ${decision.modelVersion}\n${decision.reason}`}
              >
                <td className="fin-muted" style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(decision.createdAt)}</td>
                <td>{decision.passId ? `Pass #${decision.passId}` : decision.stationId || '—'}</td>
                <td>{DECISION_LABELS[decision.decisionType] ?? decision.decisionType}</td>
                <td style={{ textAlign: 'right', fontWeight: 500 }}>{formatDollars(decision.amountCents)}</td>
                <td>
                  <span className={`ui-chip tone-${meta.tone}`}><OutcomeIcon size={11} aria-hidden />{meta.label}</span>
                </td>
                <td className="fin-muted" title={human ? 'Human' : 'AI'}>
                  {human ? <User size={13} aria-label="Human" /> : <Bot size={13} aria-label="AI" />}
                </td>
                <td className="audit-replay-cell">
                  <span className="replay-trigger"><Play size={11} aria-hidden />Replay</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
