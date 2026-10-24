import { useMemo, useState } from 'react';
import { useTable, micros } from '../../hooks/useTable';
import {
  AUTO_DECIDE_CONFIDENCE,
  DECIDING_KEYS,
  KEY_LABELS,
  REASON_CODES,
  caseValue,
  decideCase,
  dollars,
  humanize,
  signedDollars,
  useCaseEvidence,
  type ClaimCase,
  type CustomerContract,
  type AuditDecision,
} from '../../hooks/useCases';
import './CaseDetail.css';

const HOUR = 3_600_000_000n;
const DAY = 24n * HOUR;

function fmtTime(us: bigint): string {
  return new Date(Number(us / 1000n)).toISOString().slice(11, 16);
}

function fmtDate(us: bigint): string {
  return new Date(Number(us / 1000n)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Section({ title, aside, children, wide }: { title: string; aside?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`cd-section ${wide ? 'wide' : ''}`}>
      <header>
        <h3>{title}</h3>
        {aside && <span>{aside}</span>}
      </header>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode, boolean?][] }) {
  return (
    <dl className="cd-facts">
      {rows.map(([k, v, flag]) => (
        <div key={k} className={flag ? 'flag' : ''}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Elevation over the contact, modeled from the pass's max elevation, with LOS and any maintenance overlap. */
function PassTimeline({ c, contract, maintenance }: { c: ClaimCase; contract?: CustomerContract; maintenance?: { start: bigint; end: bigint } }) {
  const start = micros(c.contactStart);
  const end = micros(c.contactEnd);
  const los = micros(c.signalLost);
  const span = Number(end - start) || 1;
  const W = 400, H = 96, top = 8, bottom = 18;
  const maxEl = Math.max(c.maxElevationDeg, contract?.minElevationDeg ?? 0, 10);
  const x = (t: bigint) => (Number(t - start) / span) * W;
  const y = (el: number) => top + (1 - el / maxEl) * (H - top - bottom);
  const points = Array.from({ length: 41 }, (_, i) => {
    const f = i / 40;
    return `${(f * W).toFixed(1)},${y(c.maxElevationDeg * Math.sin(Math.PI * f)).toFixed(1)}`;
  }).join(' ');
  const losX = x(los);
  return (
    <svg className="cd-timeline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {maintenance && maintenance.end > start && maintenance.start < end && (
        <rect className="maint" x={Math.max(0, x(maintenance.start))} y={top} width={Math.min(W, x(maintenance.end)) - Math.max(0, x(maintenance.start))} height={H - top - bottom} />
      )}
      <rect className="lost" x={losX} y={top} width={W - losX} height={H - top - bottom} />
      {contract && <line className="min-el" x1={0} x2={W} y1={y(contract.minElevationDeg)} y2={y(contract.minElevationDeg)} />}
      <polyline className="elev" points={points} />
      <line className="los" x1={losX} x2={losX} y1={top} y2={H - bottom} />
      <text x={2} y={H - 4}>AOS {fmtTime(start)}{losX <= 70 ? ` · LOS ${fmtTime(los)}` : ''}</text>
      {losX > 70 && losX < W - 50 && <text x={losX} y={H - 4} textAnchor="middle">LOS {fmtTime(los)}</text>}
      <text x={W - 2} y={H - 4} textAnchor="end">{fmtTime(end)}</text>
      {contract && <text x={W - 2} y={y(contract.minElevationDeg) - 3} textAnchor="end">min {contract.minElevationDeg}°</text>}
    </svg>
  );
}

function KpSpark({ c, contract }: { c: ClaimCase; contract?: CustomerContract }) {
  const weather = useTable('spaceWeather');
  const los = micros(c.signalLost);
  const pts = useMemo(() => weather
    .map(w => ({ t: micros(w.timestamp), kp: w.kpIndex }))
    .filter(p => p.t > los - 12n * HOUR && p.t < los + 12n * HOUR)
    .sort((a, b) => Number(a.t - b.t)), [weather, los]);
  if (pts.length < 2) return null;
  const W = 400, H = 56;
  const t0 = los - 12n * HOUR;
  const x = (t: bigint) => (Number(t - t0) / Number(24n * HOUR)) * W;
  const y = (kp: number) => 4 + (1 - kp / 9) * (H - 12);
  return (
    <svg className="cd-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {contract && (
        <>
          <rect className="near" x={0} width={W} y={y(contract.kpExclusion)} height={y(contract.kpExclusion - 1) - y(contract.kpExclusion)} />
          <line className="excl" x1={0} x2={W} y1={y(contract.kpExclusion)} y2={y(contract.kpExclusion)} />
        </>
      )}
      <polyline className="kp" points={pts.map(p => `${x(p.t).toFixed(1)},${y(p.kp).toFixed(1)}`).join(' ')} />
      <line className="los" x1={x(los)} x2={x(los)} y1={0} y2={H} />
      <text x={2} y={H - 2}>−12h</text>
      <text x={W - 2} y={H - 2} textAnchor="end">+12h</text>
    </svg>
  );
}

function OutcomeMix({ decisions }: { decisions: AuditDecision[] }) {
  const n = decisions.length || 1;
  const count = (o: string) => decisions.filter(d => d.outcome === o).length;
  return (
    <span className="cd-mix">
      {['approve', 'partial', 'deny'].map(o => (
        <span key={o}>{humanize(o)} {Math.round((count(o) * 100) / n)}%</span>
      ))}
    </span>
  );
}

export interface DecisionNotice {
  caseId: string;
  error?: string;
}

interface Props {
  c: ClaimCase;
  contract?: CustomerContract;
  decisions: AuditDecision[];
  onDecided: (notice: DecisionNotice) => void;
}

export default function CaseDetail({ c, contract, decisions, onDecided }: Props) {
  const ev = useCaseEvidence(c.caseId, decisions);
  const maintenanceRows = useTable('maintenanceLog');
  const stationMaint = useMemo(() => maintenanceRows
    .filter(m => m.stationId === c.stationId)
    .sort((a, b) => Number(micros(b.startTime) - micros(a.startTime))), [maintenanceRows, c.stationId]);
  const linked = stationMaint.find(m => c.maintenanceId !== undefined && m.id === c.maintenanceId);
  const now = micros(c.createdAt);
  const recentMaint = stationMaint.filter(m => micros(m.startTime) <= now + DAY).slice(0, 4);
  const stationDecisions = useMemo(() => decisions.filter(d => d.stationId === c.stationId), [decisions, c.stationId]);
  const customerDecisions = useMemo(() => decisions.filter(d => d.customerId === c.customerId), [decisions, c.customerId]);

  const recommendedOption = ev.options.find(o => o.recommended) ?? ev.options[0];
  const [optionId, setOptionId] = useState<bigint | undefined>(recommendedOption?.id);
  const option = ev.options.find(o => o.id === optionId) ?? recommendedOption;
  const [creditInput, setCredit] = useState<string | null>(null);
  const [reasonInput, setReasonCode] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState('');
  const [decisive, setDecisive] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const credit = creditInput ?? (option ? String(Number(option.creditCents) / 100) : '');
  const defaultReason = !option || option.outcome === 'approve' ? 'contract_credit'
    : option.outcome === 'partial' ? 'credit_formula'
    : c.weatherBand === 'excluded' ? 'excused_space_weather' : 'excused_maintenance';
  const reasonCode = reasonInput ?? defaultReason;

  const chooseOption = (id: bigint) => {
    setOptionId(id);
    setCredit(null);
    setReasonCode(null);
  };

  const agreement = ev.score ? Math.floor(100 * (c.recommended === 'deny' ? 1 - ev.score.mlFailureProb : ev.score.mlFailureProb)) : undefined;
  const penalty = ev.conflicts.reduce((s, x) => s + Number(x.penalty), 0);
  const message = ev.messages[0];

  const submit = async () => {
    if (!option) return;
    setBusy(true);
    const cents = option.outcome === 'deny' ? 0n : BigInt(Math.round(parseFloat(credit || '0') * 100));
    try {
      await decideCase({
        caseId: c.caseId,
        outcome: option.outcome,
        creditCents: cents,
        reasonCode,
        reasonText: reasonText || REASON_CODES[reasonCode] || reasonCode,
        decisive,
        reviewer: 'Ops Reviewer',
      });
      onDecided({ caseId: c.caseId });
    } catch (e) {
      onDecided({ caseId: c.caseId, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="case-detail">
      <div className="cd-head">
        <div className="cd-title">
          <h2>{c.customerName}</h2>
          <span>{c.caseId} · {humanize(c.claimType)} · {c.stationName} · {c.satelliteName}</span>
        </div>
        <div className="cd-figures">
          <div><label>Claimed</label><b>{dollars(c.claimedCents)}</b></div>
          <div><label>Contract credit</label><b>{dollars(c.contractCreditCents)}</b></div>
          <div><label>AI recommends</label><b>{humanize(c.recommended)} {c.recommended !== 'deny' && dollars(c.creditCents)}</b></div>
          <div className="conf"><label>Confidence</label><b>{String(c.confidence)}%</b><small>needs {AUTO_DECIDE_CONFIDENCE}%</small></div>
        </div>
      </div>

      <div className="cd-why">
        <span className="cd-why-label">Why below {AUTO_DECIDE_CONFIDENCE}%</span>
        <span className="cd-why-row">
          <span>Model agreement with the contract reading</span>
          <b>{agreement !== undefined ? `${agreement}%` : '—'}</b>
        </span>
        {ev.conflicts.map(x => (
          <span key={String(x.id)} className="cd-why-row">
            <span><em>{x.sources}</em> {x.detail}</span>
            <b>−{String(x.penalty)}</b>
          </span>
        ))}
        <span className="cd-why-row total">
          <span>{penalty > 0 ? 'Sources disagree, so the claim needs a human' : c.gateNote}</span>
          <b>{String(c.confidence)}%</b>
        </span>
      </div>

      <div className="cd-grid">
        <Section title="Pass telemetry" aside={`max ${c.maxElevationDeg.toFixed(1)}° · ${String(c.lostPct)}% of contact lost`}>
          <PassTimeline c={c} contract={contract} maintenance={linked ? { start: micros(linked.startTime), end: micros(linked.endTime) } : undefined} />
          <Facts rows={[
            ['Signal loss', `${fmtDate(micros(c.signalLost))} ${fmtTime(micros(c.signalLost))} UTC`],
            ['Data integrity', c.integrity, c.integrity !== 'pass'],
            ['Elevation vs contract', contract ? `${c.maxElevationDeg.toFixed(1)}° vs ${contract.minElevationDeg}° min` : '—', !!contract && c.maxElevationDeg < contract.minElevationDeg],
            ['Pass fee', dollars(c.passFeeCents)],
          ]} />
          <p className="cd-note">Elevation curve modeled from the pass's max elevation. Shaded: after signal loss.</p>
        </Section>

        <Section title="Space weather" aside={humanize(c.weatherBand)}>
          <KpSpark c={c} contract={contract} />
          <Facts rows={[
            ['Kp at signal loss', c.kp.toFixed(1), c.weatherBand !== 'clear'],
            ['Contract exclusion', contract ? `Kp ≥ ${contract.kpExclusion.toFixed(1)}` : '—'],
            ['Flare / Dst', `${c.flare} / ${c.dst} nT`],
          ]} />
        </Section>

        <Section title="Station history" aside={`${c.stationName} · ${stationDecisions.length} disputes in 6 months`}>
          <Facts rows={[
            ['Maintenance at contact', linked ? `${linked.kind}, ${String(linked.noticeHours)}h notice` : 'none logged', !!linked],
            ['Contract notice', contract ? `${String(contract.maintenanceNoticeHours)}h required` : '—'],
            ['Past outcomes', <OutcomeMix key="station" decisions={stationDecisions} />],
          ]} />
          <ul className="cd-list">
            {recentMaint.map(m => (
              <li key={String(m.id)} className={m.id === linked?.id ? 'hl' : ''}>
                <span>{fmtDate(micros(m.startTime))}</span>
                <span>{m.description}</span>
                <span>{m.kind}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Contract and SLA" aside={contract ? `${contract.contractRef} · ${contract.tier}` : ''}>
          {contract && (
            <>
              <Facts rows={[
                ['Credit formula', `full fee at ≥${String(contract.fullCreditLostPct)}% lost, pro rata below`],
                ['Exclusions', `Kp ≥ ${contract.kpExclusion.toFixed(1)}, maintenance with ${String(contract.maintenanceNoticeHours)}h notice, passes below ${contract.minElevationDeg}°`],
                ['Formula credit', `${dollars(c.contractCreditCents)} for ${String(c.lostPct)}% lost`, c.claimedCents > c.contractCreditCents],
              ]} />
              <blockquote>{contract.clause}</blockquote>
            </>
          )}
        </Section>

        <Section title="Customer message" aside={message ? `${message.channel} · ${message.author}` : ''}>
          {message && <blockquote>{message.body}</blockquote>}
          <div className="cd-chips">
            <span className={c.msgCitesWeather ? 'on' : ''}>cites weather</span>
            <span className={c.msgClaimsFullLoss ? 'on' : ''}>claims full loss</span>
            <span className={c.msgMentionsMaintenance ? 'on' : ''}>mentions maintenance</span>
          </div>
          <Facts rows={[
            ['Account', c.newAccount ? `new (${contract ? String(contract.sinceDays) : '?'} days)` : 'established', c.newAccount],
            ['Disputes, 6 months', `${customerDecisions.length} · ${dollars(customerDecisions.reduce((s, d) => s + Number(d.creditCents), 0))} credited`],
            ['Past outcomes', customerDecisions.length ? <OutcomeMix key="customer" decisions={customerDecisions} /> : 'no history'],
          ]} />
        </Section>

        <Section title="Failure model" aside={ev.score ? `${ev.score.modelVersion} · ${ev.score.source}` : ''}>
          <div className="cd-prob">
            <b>{ev.score ? `${(ev.score.mlFailureProb * 100).toFixed(0)}%` : '—'}</b>
            <span>probability the station side failed</span>
          </div>
          <ul className="cd-shap">
            {ev.shap.slice(0, 6).map(s => (
              <li key={String(s.id)}>
                <span>{s.feature} <em>{s.detail}</em></span>
                <span className="bar"><i className={s.value >= 0 ? 'pos' : 'neg'} style={{ width: `${Math.min(100, Math.abs(s.value) * 40)}%` }} /></span>
                <span>{s.value >= 0 ? '+' : ''}{s.value.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Cedar rules" aside={`policy ${c.policyVersion}`} wide>
          <ul className="cd-rules">
            {ev.rules.map(r => (
              <li key={String(r.id)} className={r.status}>
                <span className="mark">{r.status === 'fired' ? 'fired' : 'not matched'}</span>
                <code>{r.ruleId}</code>
                <span>{r.detail}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Similar past decisions" aside={`${ev.similar.length} nearest of ${decisions.length.toLocaleString()}`} wide>
          <table className="cd-table">
            <thead>
              <tr><th>Case</th><th>Customer</th><th>Decided</th><th>Situation</th><th>Outcome</th><th className="num">Credit</th><th>Reason</th><th className="num">Match</th></tr>
            </thead>
            <tbody>
              {ev.similar.map(({ row, decision: d }) => d && (
                <tr key={String(row.id)}>
                  <td>{d.caseId}</td>
                  <td>{d.customerName}</td>
                  <td>{fmtDate(micros(d.decidedAt))} · {d.reviewer}</td>
                  <td>Kp {d.kp.toFixed(1)}/{d.kpExclusion.toFixed(0)} · {String(d.lostPct)}% lost · {humanize(d.maintenance)} · {d.integrity}</td>
                  <td>{d.outcome}</td>
                  <td className="num">{dollars(d.creditCents)}</td>
                  <td title={d.reasonText}>{humanize(d.reasonCode)}</td>
                  <td className="num">{Math.round(row.similarity * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>

      <div className="cd-decide">
        <div className="cd-options">
          {ev.options.map(o => (
            <button key={String(o.id)} className={`cd-option ${o.id === option?.id ? 'selected' : ''}`} onClick={() => chooseOption(o.id)}>
              <span className="label">{o.label}{o.recommended && <em> · AI</em>}</span>
              <b>{dollars(o.creditCents)}</b>
              <span>revenue {signedDollars(o.revenueImpactCents)}</span>
              <span>{o.similarSupport} of {o.similarTotal} similar decided this way</span>
            </button>
          ))}
        </div>
        <div className="cd-form">
          <div className="row">
            <label>Credit ($)
              <input type="number" value={option?.outcome === 'deny' ? '0' : credit} disabled={option?.outcome === 'deny'} onChange={e => setCredit(e.target.value)} />
            </label>
            <label>Reason
              <select value={reasonCode} onChange={e => setReasonCode(e.target.value)}>
                {Object.entries(REASON_CODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="grow">Note
              <input type="text" value={reasonText} placeholder={REASON_CODES[reasonCode]} onChange={e => setReasonText(e.target.value)} />
            </label>
          </div>
          <div className="cd-decisive">
            <span>Decisive evidence</span>
            {DECIDING_KEYS.map(k => (
              <label key={k} className={decisive.includes(k) ? 'on' : ''}>
                <input type="checkbox" checked={decisive.includes(k)} onChange={e => setDecisive(e.target.checked ? [...decisive, k] : decisive.filter(x => x !== k))} />
                {KEY_LABELS[k]}: <b>{humanize(caseValue(c, contract, k))}</b>
              </label>
            ))}
          </div>
          <div className="row end">
            <span className="cd-hint">The decision is stored with this evidence as a labeled example. A rule is proposed only when three or more consistent decisions share the decisive evidence and none contradict it.</span>
            <button className="btn btn-approve" disabled={!option || busy} onClick={submit}>
              {option ? `${humanize(option.outcome)} ${option.outcome === 'deny' ? '' : dollars(BigInt(Math.round(parseFloat(credit || '0') * 100)))}` : 'Decide'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
