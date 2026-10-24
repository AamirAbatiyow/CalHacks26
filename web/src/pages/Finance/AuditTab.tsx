import type { DecisionRecord } from '../../types';
import { formatDollars } from '../../utils/money';

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
    second: '2-digit',
  });
}

function getDecisionLabel(type: string): string {
  switch (type) {
    case 'DisputeCreated':
      return 'Dispute Created';
    case 'DisputeResolved':
      return 'Dispute Resolved';
    case 'CreditIssued':
      return 'Credit Issued';
    case 'PassDropped':
      return 'Pass Dropped';
    case 'PassRecovered':
      return 'Pass Recovered';
    default:
      return type;
  }
}

function getOutcomeClass(outcome: string): string {
  switch (outcome) {
    case 'Approved':
    case 'AutoApproved':
      return 'approved';
    case 'Denied':
      return 'denied';
    case 'Pending':
      return 'pending';
    case 'Escalated':
      return 'escalated';
    default:
      return '';
  }
}

function getActor(outcome: string): { label: string; icon: string } {
  if (outcome === 'AutoApproved') {
    return { label: 'AI', icon: '⚡' };
  }
  if (outcome === 'Escalated' || outcome === 'Approved' || outcome === 'Denied') {
    return { label: 'Human', icon: '👤' };
  }
  return { label: 'AI', icon: '⚡' };
}

function getCedarRule(decisionType: string): string {
  switch (decisionType) {
    case 'DisputeCreated':
      return 'dispute::create';
    case 'DisputeResolved':
      return 'dispute::resolve';
    case 'CreditIssued':
      return 'credit::issue';
    case 'PassDropped':
      return 'pass::drop';
    case 'PassRecovered':
      return 'pass::recover';
    default:
      return 'policy::default';
  }
}

export function AuditTab({ decisions }: AuditTabProps) {
  const sortedDecisions = [...decisions].sort((a, b) => 
    Number(b.createdAt - a.createdAt)
  );

  if (sortedDecisions.length === 0) {
    return (
      <div className="audit-empty">
        No decisions recorded yet. AI decisions will appear here in real-time.
      </div>
    );
  }

  return (
    <table className="audit-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Claim</th>
          <th>Decision</th>
          <th style={{ textAlign: 'right' }}>Amount</th>
          <th>Outcome</th>
          <th>Actor</th>
          <th>Cedar Rule</th>
          <th>Policy</th>
          <th>Model</th>
        </tr>
      </thead>
      <tbody>
        {sortedDecisions.map((decision) => {
          const actor = getActor(decision.outcome);
          return (
            <tr key={decision.id.toString()}>
              <td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(decision.createdAt)}</td>
              <td>
                {decision.passId ? `Pass #${decision.passId}` : decision.stationId || '—'}
              </td>
              <td>{getDecisionLabel(decision.decisionType)}</td>
              <td style={{ textAlign: 'right', fontWeight: 500 }}>
                {formatDollars(decision.amountCents)}
              </td>
              <td>
                <span className={`audit-outcome ${getOutcomeClass(decision.outcome)}`}>
                  {decision.outcome === 'AutoApproved' ? 'Auto' : decision.outcome}
                </span>
              </td>
              <td>
                <span className="audit-actor">
                  <span className="audit-actor-icon">{actor.icon}</span>
                  {actor.label}
                </span>
              </td>
              <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                {getCedarRule(decision.decisionType)}
              </td>
              <td>
                <a href="#/policies" className="audit-policy-link">
                  {decision.policyVersion}
                </a>
              </td>
              <td style={{ color: 'var(--color-secondary)' }}>
                {decision.modelVersion}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
