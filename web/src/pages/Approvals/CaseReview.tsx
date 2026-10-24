import { useEffect, useState } from 'react';
import { reducers, tag } from '../../hooks/useTable';
import {
  CLAIM_TYPE_LABELS,
  SYSTEM_LABELS,
  dollars,
  parseJson,
  type CaseSnapshot,
  type DecisionCaseRow,
  type DecisionData,
} from '../../hooks/useDecisions';
import { openReplay } from '../../replay/useDecisionTrace';
import './CaseReview.css';

const REASON_CODES = [
  ['sla_breach', 'SLA breach confirmed'],
  ['degraded_over_threshold', 'Degradation over threshold'],
  ['storm_degradation_credited', 'Storm degradation, no weather exclusion'],
  ['operator_maintenance', 'Operator maintenance caused it'],
  ['telemetry_shows_completed', 'Telemetry shows pass completed'],
  ['weather_exclusion', 'Contract excludes space weather'],
  ['outside_claim_window', 'Outside claim window'],
  ['inflated_amount', 'Amount exceeds entitlement'],
  ['no_operator_fault', 'No operator fault'],
  ['suspected_manipulation', 'Suspected manipulation'],
] as const;

const EVIDENCE = [
  ['telemetry', 'Telemetry'],
  ['space_weather', 'Space weather'],
  ['contract_clause', 'Contract clause'],
  ['station_history', 'Station history'],
  ['amount', 'Claimed amount'],
  ['customer_message', 'Customer message'],
] as const;

interface Extracted {
  requested_amount_cents: number | null;
  asserts_total_outage: boolean;
  asserts_degradation: boolean;
  asserts_late_delivery: boolean;
  mentions_weather: boolean;
  cited_references: string[];
}

interface Screen {
  flagged: boolean;
  score: number;
  reasons: string[];
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="cr-fact">
      <span className="cr-fact-label">{label}</span>
      <span className={`cr-fact-value ${warn ? 'warn' : ''}`}>{value}</span>
    </div>
  );
}

/** Escalated decision case: the full evidence package, System 1/2 outputs and the reviewer's decision form. */
export function CaseReview({ row, data }: { row: DecisionCaseRow; data: DecisionData }) {
  const s = parseJson<CaseSnapshot>(row.snapshotJson);
  const steps = data.stepsByCase.get(row.id) ?? [];
  const s1 = [...steps].reverse().find(d => tag(d.system) === 'System1');
  const s2 = [...steps].reverse().find(d => tag(d.system) === 'System2');
  const guard = [...steps].reverse().find(d => tag(d.system) === 'Guard');
  const message = row.messageId !== undefined ? data.messageById.get(row.messageId) : undefined;
  const extracted = parseJson<Extracted>(row.extractedJson);
  const screen = parseJson<Screen>(row.screenJson);
  const label = data.labelByCase.get(row.id);
  const retrained = label ? data.modelByLabel.get(label.id) : undefined;
  const decided = tag(row.status) === 'HumanDecided';
  const similar = data.cases.find(c => c.similarTo === row.id);

  const [approve, setApprove] = useState(true);
  const [credit, setCredit] = useState('');
  const [reason, setReason] = useState<string>(REASON_CODES[0][0]);
  const [text, setText] = useState('');
  const [decisive, setDecisive] = useState<string[]>(['telemetry']);
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('gt-reviewer') ?? 'ops.reviewer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const suggested = s2 && tag(s2.verdict) === 'Approve' ? Number(s2.creditCents) : Number(row.entitledCreditCents);
    setCredit((Math.min(suggested, Number(row.amountClaimedCents)) / 100).toFixed(2));
    setError(null);
    // Reset the form only when a different case is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  if (!s) return <div className="cr-empty">Case snapshot unavailable.</div>;

  const toggle = (k: string) => setDecisive(d => (d.includes(k) ? d.filter(x => x !== k) : [...d, k]));
  const submit = async () => {
    const r = reducers();
    if (!r) return setError('Not connected to SpacetimeDB');
    const cents = approve ? Math.round(parseFloat(credit || '0') * 100) : 0;
    if (approve && !(cents > 0)) return setError('Enter the credit to issue');
    if (decisive.length === 0) return setError('Select the evidence that decided it');
    setBusy(true);
    setError(null);
    localStorage.setItem('gt-reviewer', reviewer);
    try {
      await r.humanDecideCase({
        caseId: row.id, approve, creditCents: BigInt(cents), reasonCode: reason, reasonText: text,
        decisiveEvidence: decisive, reviewer: reviewer.trim() || 'ops.reviewer',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loss = s.telemetry.loss_pct;
  return (
    <div className="cr">
      <div className="detail-header">
        <h2>{row.customer}</h2>
        <span className="detail-amount">{dollars(row.amountClaimedCents)} claimed · {row.claimRef}</span>
        <button className="replay-trigger detail-replay" onClick={() => openReplay(`case:${row.claimRef}`)}>
          <span className="replay-trigger-glyph">▶</span>Replay path
        </button>
      </div>
      <div className="cr-reason">
        <span className="cr-tag">{CLAIM_TYPE_LABELS[tag(row.claimType)] ?? tag(row.claimType)}</span>
        {row.escalationReason}
      </div>

      {row.summary && (
        <div className="cr-section">
          <div className="cr-section-title">System 2 case summary</div>
          <p className="cr-summary">{row.summary}</p>
        </div>
      )}

      <div className="cr-grid">
        <div className="cr-section">
          <div className="cr-section-title">Telemetry · pass #{s.pass.id}</div>
          <Fact label="Pass status" value={`${s.pass.status} · ${s.pass.station_id} · ${s.pass.duration_min} min`} />
          <Fact label="Data received" value={`${s.telemetry.received_mb} of ${s.telemetry.expected_mb} MB`} />
          <Fact label="Telemetry loss" value={`${loss}%`} warn={loss >= 25} />
          <Fact label="SNR" value={`${s.telemetry.snr_db} dB`} />
          <Fact label="Pass value" value={dollars(s.pass.revenue_cents)} />
        </div>
        <div className="cr-section">
          <div className="cr-section-title">Space weather</div>
          <Fact label="Kp index" value={`${s.weather.kp_index}${s.weather.storm ? ' · storm' : ''}`} warn={s.weather.storm} />
          <Fact label="Flare class" value={s.weather.flare_class} />
          <Fact label="Dst" value={`${s.weather.dst_index} nT`} />
        </div>
        <div className="cr-section">
          <div className="cr-section-title">Station history · 30 days</div>
          <Fact label="Drops" value={`${s.station_history.drops_30d} of ${s.station_history.passes_30d} (${s.station_history.drop_rate_pct}%)`} />
          <Fact label="Maintenance" value={s.station_history.maintenance_overlap ? s.station_history.maintenance_note ?? 'Overlapping window' : 'None overlapping'} warn={s.station_history.maintenance_overlap} />
        </div>
        <div className="cr-section">
          <div className="cr-section-title">Contract {s.contract.contract_id} · {s.contract.tier}</div>
          <p className="cr-clause">{s.contract.sla_clause}</p>
          <Fact label="Entitlement" value={dollars(s.contract.entitled_credit_cents)} />
          <Fact label="Weather exclusion" value={s.contract.weather_exclusion ? 'Yes' : 'No'} />
          <Fact label="Claim window" value={`${s.contract.days_since_pass} of ${s.contract.claim_window_days} days`} warn={!s.contract.within_window} />
        </div>
      </div>

      <div className="cr-section">
        <div className="cr-section-title">Customer message · untrusted</div>
        {message ? (
          <>
            <pre className="cr-message">{message.body}</pre>
            {screen && (
              <div className={`cr-screen ${screen.flagged ? 'flagged' : ''}`}>
                Injection screen {screen.flagged ? 'flagged' : 'passed'} (score {screen.score})
                {screen.reasons.length > 0 && `: ${screen.reasons.join('; ')}`}
              </div>
            )}
            {extracted && (
              <div className="cr-extracted">
                Extracted: {[
                  extracted.asserts_total_outage && 'asserts total outage',
                  extracted.asserts_degradation && 'asserts degradation',
                  extracted.asserts_late_delivery && 'asserts late delivery',
                  extracted.mentions_weather && 'mentions weather',
                  extracted.requested_amount_cents != null && `requests ${dollars(extracted.requested_amount_cents)}`,
                  extracted.cited_references.length > 0 && `cites ${extracted.cited_references.join(', ')}`,
                ].filter(Boolean).join(' · ') || 'no claims'}
              </div>
            )}
          </>
        ) : (
          <p className="cr-muted">No message filed.</p>
        )}
      </div>

      <div className="cr-grid">
        <div className="cr-section">
          <div className="cr-section-title">ML failure model · {s.ml.model_version}</div>
          <Fact label="Failure probability" value={`${(s.ml.failure_probability * 100).toFixed(1)}%`} />
          {s.ml.shap.map(r => (
            <Fact key={r.feature} label={r.feature} value={`${r.value >= 0 ? '+' : ''}${r.value.toFixed(2)}`} />
          ))}
        </div>
        <div className="cr-section">
          <div className="cr-section-title">Automated decisions</div>
          {[s1, s2, guard].filter(Boolean).map(d => (
            <div key={String(d!.id)} className="cr-step">
              <span className="cr-step-system">{SYSTEM_LABELS[tag(d!.system)]}</span>
              <span className="cr-step-verdict">{tag(d!.verdict)} {d!.confidencePct.toFixed(1)}%</span>
              <span className="cr-muted">{d!.modelVersion}</span>
              <p className="cr-step-rationale">{d!.rationale}</p>
              {d!.citedEvidence.length > 0 && <p className="cr-muted">Cites {d!.citedEvidence.join(', ')}</p>}
            </div>
          ))}
          <p className="cr-muted">Rules fired: {row.policyVersion || 'v4'} base policy; no learned rule matched.</p>
        </div>
      </div>

      {decided ? (
        <div className="cr-outcome">
          <div>
            Decided by {label?.reviewer ?? 'a human'}: {tag(row.finalVerdict)} {dollars(row.finalCreditCents)}
          </div>
          {retrained ? (
            <div className="cr-retrain">
              System 1 s1-v{retrained.version} {tag(retrained.status) === 'Rejected' ? 'rejected' : 'live'} {retrained.latencyMs.toFixed(0)} ms after this decision · {retrained.note}
            </div>
          ) : (
            <div className="cr-muted">Retraining System 1…</div>
          )}
          {similar ? (
            <div className="cr-similar">
              Similar claim {similar.claimRef}: {tag(similar.status) === 'AutoDecided'
                ? `auto-decided ${tag(similar.finalVerdict)} ${dollars(similar.finalCreditCents)} by ${SYSTEM_LABELS[tag(similar.decidedBy)]} · ${similar.modelVersion} · policy ${similar.policyVersion}`
                : tag(similar.status) === 'Escalated' ? `escalated: ${similar.escalationReason}` : 'deciding…'}
              <button className="replay-trigger detail-replay" onClick={() => openReplay(`case:${similar.claimRef}`)}>
                <span className="replay-trigger-glyph">▶</span>Replay {similar.claimRef}
              </button>
            </div>
          ) : (
            <button className="btn btn-edit cr-similar-btn" onClick={() => reducers()?.fileSimilarCase({ caseId: row.id })}>
              File a similar claim
            </button>
          )}
        </div>
      ) : (
        <div className="cr-form">
          <div className="cr-form-row">
            <div className="cr-toggle">
              <button className={approve ? 'on' : ''} onClick={() => setApprove(true)}>Approve</button>
              <button className={!approve ? 'on deny' : ''} onClick={() => setApprove(false)}>Deny</button>
            </div>
            {approve && (
              <label className="cr-field">
                Credit ($)
                <input type="number" step="0.01" min="0" value={credit} onChange={e => setCredit(e.target.value)} />
              </label>
            )}
            <label className="cr-field">
              Reason
              <select value={reason} onChange={e => setReason(e.target.value)}>
                {REASON_CODES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="cr-field">
              Reviewer
              <input value={reviewer} onChange={e => setReviewer(e.target.value)} />
            </label>
          </div>
          <div className="cr-evidence">
            <span className="cr-fact-label">Decisive evidence</span>
            {EVIDENCE.map(([k, v]) => (
              <label key={k} className={`cr-check ${decisive.includes(k) ? 'on' : ''}`}>
                <input type="checkbox" checked={decisive.includes(k)} onChange={() => toggle(k)} />
                {v}
              </label>
            ))}
          </div>
          <textarea className="cr-text" placeholder="Notes (optional)" value={text} onChange={e => setText(e.target.value)} />
          {error && <div className="cr-error">{error}</div>}
          <div className="detail-actions">
            <button className={`btn ${approve ? 'btn-approve' : 'btn-reject'}`} onClick={submit} disabled={busy}>
              {approve ? `Approve ${dollars(Math.round(parseFloat(credit || '0') * 100))}` : 'Deny claim'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
