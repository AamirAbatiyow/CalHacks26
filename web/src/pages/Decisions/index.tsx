import { useState } from 'react';
import { micros, reducers, tag } from '../../hooks/useTable';
import { CLAIM_TYPE_LABELS, SYSTEM_LABELS, dollars, useDecisionData, type DecisionCaseRow } from '../../hooks/useDecisions';
import './Decisions.css';

const SCENARIOS = [
  ['storm_degraded', 'Storm-degraded link, 32% loss'],
  ['storm_degraded_heavy', 'Storm-degraded link, 47% loss'],
  ['calm_drop', 'Dropped pass, calm weather'],
  ['completed_pass', 'Claim on a completed pass'],
] as const;

function ago(ts: unknown): string {
  const s = Math.max(0, Math.round((Date.now() * 1000 - Number(micros(ts))) / 1e6));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dz-stat">
      <span className="dz-stat-label">{label}</span>
      <span className="dz-stat-value">{value}{sub && <span className="dz-stat-sub"> {sub}</span>}</span>
    </div>
  );
}

function SystemBadge({ system }: { system: string }) {
  return <span className={`dz-badge dz-${system.toLowerCase()}`}>{SYSTEM_LABELS[system] ?? system}</span>;
}

function CaseRow({ c, steps }: { c: DecisionCaseRow; steps: ReturnType<typeof useDecisionData>['stepsByCase'] }) {
  const [open, setOpen] = useState(false);
  const status = tag(c.status);
  const by = tag(c.decidedBy);
  const verdict = tag(c.finalVerdict);
  return (
    <>
      <button className="dz-case" onClick={() => setOpen(o => !o)}>
        <span className="dz-mono">{c.claimRef}</span>
        <span>{c.customer}</span>
        <span className="dz-muted">{CLAIM_TYPE_LABELS[tag(c.claimType)]}</span>
        <span className="dz-num">{dollars(c.amountClaimedCents)}</span>
        <span>{by ? <SystemBadge system={by} /> : <span className="dz-muted">{status === 'Queued' ? 'System 1…' : 'System 2…'}</span>}</span>
        <span className={`dz-verdict ${status === 'Escalated' ? 'esc' : verdict === 'Approve' ? 'ok' : 'no'}`}>
          {status === 'Escalated' ? 'Escalated' : verdict ? `${verdict} ${verdict === 'Approve' ? dollars(c.finalCreditCents) : ''}` : '—'}
        </span>
        <span className="dz-mono dz-muted">{c.modelVersion || '—'} · {c.policyVersion || '—'}</span>
        <span className="dz-muted">{c.attackName ? `Attack: ${c.attackName}` : c.similarTo !== undefined ? 'Similar claim' : ''}</span>
      </button>
      {open && (
        <div className="dz-steps">
          {c.escalationReason && <div className="dz-muted">Escalated: {c.escalationReason}</div>}
          {(steps.get(c.id) ?? []).map(d => (
            <div key={String(d.id)} className="dz-step">
              <SystemBadge system={tag(d.system)} />
              <span>{tag(d.verdict)} {d.confidencePct.toFixed(1)}%</span>
              <span className="dz-mono dz-muted">{d.modelVersion} · {d.policyVersion}</span>
              <span className="dz-step-text">{d.rationale}</span>
              {d.citedEvidence.length > 0 && <span className="dz-mono dz-muted">cites {d.citedEvidence.join(', ')}</span>}
              {d.checksJson && d.checksJson !== '[]' && <span className="dz-mono dz-muted">checks {d.checksJson}</span>}
              <details className="dz-inputs">
                <summary>Inputs</summary>
                <pre>{d.inputsJson}</pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function DecisionsPage() {
  const d = useDecisionData();
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="dz-page">
      <div className="dz-strip">
        <div className="dz-title">Decisions</div>
        <Stat label="System 1" value={active ? `s1-v${active.version}` : '—'} sub={active ? `${active.liveLabels} live labels` : 'no model'} />
        <Stat label="Auto-approve precision" value={active ? `${active.precisionPct.toFixed(2)}%` : '—'} sub={active ? `coverage ${active.coveragePct.toFixed(1)}%` : ''} />
        <Stat label="Calibration" value={active ? `ECE ${active.ece.toFixed(3)}` : '—'} sub={active ? `Brier ${active.brier.toFixed(3)}` : ''} />
        <Stat label="Decision to live model" value={lastLive ? `${lastLive.latencyMs.toFixed(0)} ms` : '—'} sub={lastLive ? `s1-v${lastLive.version}` : 'no live label yet'} />
        <Stat label="Learned rules" value={`${promoted.length}`} sub={`of ${d.rules.length} proposed`} />
        <Stat label="Auto-decided" value={`${auto}`} sub={`of ${d.cases.length} claims`} />
        <div className={`dz-worker ${d.workerOnline ? 'on' : ''}`}>
          Worker {d.workerOnline ? 'online' : 'offline'} · System 2 {d.worker ? `${d.worker.mode} (${d.worker.llmModel})` : '—'}
        </div>
      </div>

      <div className="dz-body">
        <div className="dz-col">
          <section className="dz-section">
            <div className="dz-section-title">File a claim</div>
            <div className="dz-actions">
              {SCENARIOS.map(([k, v]) => (
                <button key={k} className="dz-btn" onClick={() => file(k)}>{v}</button>
              ))}
            </div>
            {error && <div className="dz-error">{error}</div>}
            <p className="dz-muted">
              System 1 auto-decides at 95% confidence or higher (Cedar has the final say); otherwise System 2 reads every source,
              including the customer message, and below 95% the claim goes to Approvals with the full evidence package.
            </p>
          </section>

          <section className="dz-section">
            <div className="dz-section-title">System 1 model versions</div>
            <div className="dz-table">
              <div className="dz-tr dz-th">
                <span>Version</span><span>Status</span><span>Precision</span><span>Coverage</span><span>ECE</span><span>Labels</span><span>Live in</span><span>Cause</span>
              </div>
              {d.models.slice(0, 12).map(m => (
                <div key={m.version} className={`dz-tr ${tag(m.status) === 'Active' ? 'active' : ''}`}>
                  <span className="dz-mono">s1-v{m.version}</span>
                  <span className={`dz-status ${tag(m.status).toLowerCase()}`}>{tag(m.status)}</span>
                  <span className="dz-num">{m.precisionPct.toFixed(2)}%{m.prevPrecisionPct > 0 && <span className="dz-muted"> from {m.prevPrecisionPct.toFixed(2)}%</span>}</span>
                  <span className="dz-num">{m.coveragePct.toFixed(1)}%</span>
                  <span className="dz-num">{m.ece.toFixed(3)}</span>
                  <span className="dz-num">{m.trainedRows.toLocaleString()} ({m.liveLabels} live)</span>
                  <span className="dz-num">{m.triggeredByLabel !== undefined ? `${m.latencyMs.toFixed(0)} ms` : `fit ${m.fitMs.toFixed(0)} ms`}</span>
                  <span className="dz-muted">{m.triggeredByLabel !== undefined ? `label #${m.triggeredByLabel}` : 'bootstrap'} · {m.note}</span>
                </div>
              ))}
              {d.models.length === 0 && <div className="dz-muted">No model yet. Start the worker: cd worker &amp;&amp; npm start</div>}
            </div>
          </section>

          <section className="dz-section">
            <div className="dz-section-title">Policy proposals from labeled decisions</div>
            <p className="dz-muted">
              A rule is proposed only when three or more reviewers made the same decision on the same kind of claim, citing the same
              deciding evidence, and no labeled decision contradicts it. It is stored as Cedar, replayed on {d.labelCount.toLocaleString()} labeled
              decisions, and promoted only if precision does not regress. Customer text is never a rule input.
            </p>
            {d.worker?.note && <div className="dz-note">{d.worker.note}</div>}
            {d.rules.length === 0 && <div className="dz-note">No rule has been proposed: no consistent pattern in the labeled decisions yet.</div>}
            {d.rules.map(r => (
              <details key={String(r.id)} className="dz-rule">
                <summary>
                  <span className="dz-mono">L{String(r.id)}</span>
                  <span className={`dz-status ${tag(r.status).toLowerCase()}`}>{tag(r.status)}</span>
                  <span className="dz-rule-desc">{r.description}</span>
                  <span className="dz-muted">{r.support} decisions · {r.distinctReviewers} reviewers · {r.contradictions} contradictions</span>
                  <span className="dz-muted">precision {r.precisionBefore.toFixed(2)}% → {r.precisionAfter.toFixed(2)}%</span>
                </summary>
                <pre className="dz-cedar">{r.cedarText}</pre>
                <div className="dz-muted">{r.reason} · {r.triggeredByLabel !== undefined ? `completed by label #${r.triggeredByLabel}` : 'mined from history'} · {ago(r.createdAt)}</div>
              </details>
            ))}
          </section>
        </div>

        <section className="dz-section dz-feed">
          <div className="dz-section-title">Decision audit</div>
          {d.cases.length === 0 && <div className="dz-muted">No claims filed yet.</div>}
          {d.cases.slice(0, 60).map(c => <CaseRow key={String(c.id)} c={c} steps={d.stepsByCase} />)}
        </section>
      </div>
    </div>
  );
}
