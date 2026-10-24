import { useMemo, useState } from 'react';
import { micros } from '../../hooks/useTable';
import {
  KEY_LABELS,
  dollars,
  humanize,
  promoteVersion,
  signedDollars,
  submitSimilarClaim,
  useClaimCases,
  useMinedRules,
  useMiningResults,
  type AuditDecision,
  type PolicyProposal,
} from '../../hooks/useCases';
import './Learning.css';

function fmtDate(us: bigint): string {
  return new Date(Number(us / 1000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function condition(c: string): string {
  const [k, v] = c.split('=');
  return `${KEY_LABELS[k] ?? humanize(k)}: ${humanize(v ?? '')}`;
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`lp-metric ${tone ?? ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

const ORIGIN_LABEL: Record<string, string> = {
  history_mining: 'Mined from 6 months of human decisions',
  human_decision: 'Learned from a human decision',
  threshold_change: 'Threshold change',
};

interface ProposalProps {
  proposal: PolicyProposal;
  decisions: AuditDecision[];
}

export function ProposalPanel({ proposal: p, decisions }: ProposalProps) {
  const rules = useMinedRules().filter(r => r.policyVersionId === p.versionId).sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const cases = useClaimCases();
  const byId = useMemo(() => new Map(decisions.map(d => [d.id, d])), [decisions]);
  const trigger = p.triggerDecisionId !== undefined ? byId.get(p.triggerDecisionId) : undefined;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const citing = cases
    .filter(c => c.citedRule.startsWith(`${p.versionId}-learned-`))
    .sort((a, b) => Number(micros(b.createdAt) - micros(a.createdAt)));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const liveCases = p.replayCases - p.historyCases;
  const precisionDelta = p.precisionAfter - p.precisionBefore;

  return (
    <div className="learning-panel">
      <div className="lp-head">
        <div>
          <h2>{p.versionId} · {ORIGIN_LABEL[p.origin] ?? p.origin}</h2>
          <span>Base {p.baseVersionId} · proposed {fmtDate(micros(p.createdAt))}{p.promotedAt && ` · promoted ${fmtDate(micros(p.promotedAt))}`}</span>
        </div>
        <span className={`lp-status ${p.status}`}>{p.status}</span>
      </div>

      {trigger && (
        <div className="lp-trigger">
          <span className="lp-label">Caused by</span>
          <a href={`#/claims/${trigger.caseId}`}>{trigger.caseId}</a>
          <span>decision #{String(trigger.id)} by {trigger.reviewer}, {fmtDate(micros(trigger.decidedAt))}:</span>
          <b>{trigger.outcome} {dollars(trigger.creditCents)}</b>
          <span>· {humanize(trigger.reasonCode)} · decisive: {trigger.decisive.map(k => KEY_LABELS[k] ?? k).join(', ')}</span>
          {trigger.reasonText && <q>{trigger.reasonText}</q>}
        </div>
      )}

      <div className="lp-metrics">
        <Metric label="Replayed" value={p.replayCases.toLocaleString()} sub={`${p.historyCases.toLocaleString()} history · ${liveCases} live`} />
        <Metric label="Escalations" value={`${p.escalationsBefore.toLocaleString()} → ${p.escalationsAfter.toLocaleString()}`} sub={`${p.resolved.toLocaleString()} would auto-decide`} />
        <Metric label="Precision" value={`${p.precisionBefore.toFixed(2)}% → ${p.precisionAfter.toFixed(2)}%`} sub={`${p.correctAfter.toLocaleString()} of ${p.autoAfter.toLocaleString()} auto decisions match the human`} tone={precisionDelta < 0 ? 'bad' : 'good'} />
        <Metric label="Regressions" value={String(p.regressions)} sub="auto decisions that now disagree with the human" tone={p.regressions > 0 ? 'bad' : 'good'} />
        <Metric label="Credits settled automatically" value={dollars(p.autoCreditCents)} sub="over the resolved escalations" />
        <Metric label="Difference from human credits" value={signedDollars(p.dollarImpactCents)} sub="rule credit minus what the reviewer paid" />
      </div>

      {p.blockReason && <div className="lp-blocked">Blocked: {p.blockReason}. Promotion is disabled.</div>}

      <div className="lp-actions">
        {p.status === 'proposed' && (
          <button className="lp-btn primary" disabled={busy} onClick={() => run(() => promoteVersion(p.versionId))}>
            Promote {p.versionId} to the active Cedar policy
          </button>
        )}
        {p.status === 'promoted' && p.origin === 'human_decision' && p.triggerCaseId && (
          <button className="lp-btn" disabled={busy} onClick={() => run(() => submitSimilarClaim(p.triggerCaseId))}>
            Submit a similar new claim
          </button>
        )}
        {error && <span className="lp-error">{error}</span>}
      </div>

      {citing.length > 0 && (
        <div className="lp-citing">
          <span className="lp-label">New claims decided by {p.versionId}</span>
          {citing.slice(0, 5).map(c => (
            <div key={c.caseId} className="lp-cite">
              <a href={`#/claims/${c.caseId}`}>{c.caseId}</a>
              <span>{c.customerName} · {c.stationName} · Kp {c.kp.toFixed(1)} · {String(c.lostPct)}% lost</span>
              <b>{c.gate === 'auto' ? `auto-${c.outcome === 'approve' ? 'approved' : c.outcome === 'deny' ? 'denied' : 'partial'}` : c.gate} at {String(c.confidence)}%</b>
              <span>{dollars(c.creditCents)} · cites <code>{c.citedRule}</code></span>
            </div>
          ))}
        </div>
      )}

      {rules.length > 0 && (
        <div className="lp-rules">
          <span className="lp-label">{rules.length} learned rule{rules.length > 1 ? 's' : ''} · written by {rules[0].writer}</span>
          {rules.map(r => (
            <details key={r.ruleId} className="lp-rule">
              <summary>
                <code>{r.ruleId}</code>
                <span className="lp-conds">{r.conditions.map(condition).join(' · ')}</span>
                <b>→ {r.outcome}</b>
                <span className="lp-support">{r.support} consistent · {r.contradictions} contradicting · {r.status}</span>
              </summary>
              <p>{r.rationale}</p>
              <div className="lp-sources">
                Source decisions:{' '}
                {r.sourceDecisionIds.slice(0, 8).map(id => {
                  const d = byId.get(id);
                  return d ? <span key={String(id)}>{d.caseId} ({d.reviewer.split(' ')[0]}, {dollars(d.creditCents)})</span> : null;
                })}
                {r.sourceDecisionIds.length > 8 && <span>and {r.sourceDecisionIds.length - 8} more</span>}
              </div>
              <pre>{r.cedarText}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

const MONTH = (us: bigint) => {
  const d = new Date(Number(us / 1000n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function HistoryView({ decisions }: { decisions: AuditDecision[] }) {
  const mining = useMiningResults();
  const months = useMemo(() => {
    const m = new Map<string, { n: number; esc: number; approve: number; partial: number; deny: number; credit: number }>();
    for (const d of decisions) {
      const key = MONTH(micros(d.decidedAt));
      const row = m.get(key) ?? { n: 0, esc: 0, approve: 0, partial: 0, deny: 0, credit: 0 };
      row.n++;
      row.esc += d.escalated ? 1 : 0;
      row[d.outcome as 'approve' | 'partial' | 'deny']++;
      row.credit += Number(d.creditCents);
      m.set(key, row);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [decisions]);
  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    decisions.forEach(d => m.set(d.reasonCode, (m.get(d.reasonCode) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [decisions]);
  const totalCredit = decisions.reduce((s, d) => s + Number(d.creditCents), 0);
  const escalated = decisions.filter(d => d.escalated).length;
  const live = decisions.filter(d => d.source === 'live');
  const reviewers = new Set(decisions.map(d => d.reviewer)).size;
  const maxN = Math.max(1, ...months.map(([, r]) => r.n));

  return (
    <div className="learning-panel">
      <div className="lp-head">
        <div>
          <h2>Decision history the policies learn from</h2>
          <span>Every human audit decision, stored with the evidence the reviewer saw, the outcome, credit, reason and the evidence marked decisive.</span>
        </div>
      </div>
      <div className="lp-metrics">
        <Metric label="Labeled decisions" value={decisions.length.toLocaleString()} sub={`${live.length} live · ${reviewers} reviewers`} />
        <Metric label="Escalated at the time" value={escalated.toLocaleString()} sub={`${((escalated * 100) / Math.max(1, decisions.length)).toFixed(1)}% below 95% confidence`} />
        <Metric label="Credits decided" value={dollars(totalCredit)} />
        <Metric label="Mining runs on live decisions" value={String(mining.length)} sub={`${mining.filter(r => r.proposalVersion).length} proposed a rule`} />
      </div>

      <div className="lp-columns">
        <table className="lp-table">
          <thead>
            <tr><th>Month</th><th className="num">Decisions</th><th></th><th className="num">Escalated</th><th className="num">Approve</th><th className="num">Partial</th><th className="num">Deny</th><th className="num">Credits</th></tr>
          </thead>
          <tbody>
            {months.map(([m, r]) => (
              <tr key={m}>
                <td>{m}</td>
                <td className="num">{r.n.toLocaleString()}</td>
                <td className="bar"><i style={{ width: `${(r.n / maxN) * 100}%` }} /></td>
                <td className="num">{r.esc}</td>
                <td className="num">{r.approve}</td>
                <td className="num">{r.partial}</td>
                <td className="num">{r.deny}</td>
                <td className="num">{dollars(r.credit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="lp-table narrow">
          <thead><tr><th>Reason</th><th className="num">Decisions</th></tr></thead>
          <tbody>
            {reasons.map(([code, n]) => (
              <tr key={code}><td>{humanize(code)}</td><td className="num">{n.toLocaleString()}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="lp-rules">
        <span className="lp-label">What the miner concluded after each live decision</span>
        {mining.length === 0 && <div className="lp-empty">No live decisions yet. Decide an escalated claim on Approvals to run the miner.</div>}
        {mining.map(r => (
          <div key={String(r.id)} className={`lp-mine ${r.status}`}>
            <a href={`#/claims/${r.caseId}`}>{r.caseId}</a>
            <span className="lp-mine-status">{r.proposalVersion ? `proposed ${r.proposalVersion}` : 'no rule proposed'}</span>
            <span>{r.detail}</span>
            <span className="lp-conds">{r.pattern.map(condition).join(' · ')}{r.outcome && ` → ${r.outcome}`}</span>
          </div>
        ))}
      </div>

      <div className="lp-rules">
        <span className="lp-label">Most recent decisions</span>
        <table className="lp-table">
          <thead><tr><th>Decided</th><th>Case</th><th>Customer</th><th>Reviewer</th><th>Outcome</th><th className="num">Credit</th><th>Reason</th><th>Decisive</th></tr></thead>
          <tbody>
            {decisions.slice(0, 15).map(d => (
              <tr key={String(d.id)}>
                <td>{fmtDate(micros(d.decidedAt))}</td>
                <td>{d.caseId}</td>
                <td>{d.customerName}</td>
                <td>{d.reviewer}</td>
                <td>{d.outcome}</td>
                <td className="num">{dollars(d.creditCents)}</td>
                <td title={d.reasonText}>{humanize(d.reasonCode)}</td>
                <td>{d.decisive.map(k => humanize(k)).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
