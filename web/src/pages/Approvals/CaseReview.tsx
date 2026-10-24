import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  Bot,
  Building2,
  Check,
  Cpu,
  FileText,
  Gavel,
  MessageSquareWarning,
  Play,
  RadioTower,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  SunMedium,
  UserCheck,
} from 'lucide-react';
import { reducers, tag } from '../../hooks/useTable';
import {
  CLAIM_TYPE_LABELS,
  SYSTEM_LABELS,
  parseJson,
  type CaseSnapshot,
  type DecisionCaseRow,
  type DecisionData,
} from '../../hooks/useDecisions';
import { openReplay } from '../../replay/useDecisionTrace';
import { FlowGraph, type GraphEdge, type GraphNode } from '../../ui/FlowGraph';
import { Drawer, Fact } from '../../ui/Drawer';
import { Chip } from '../../ui/Chip';
import { DivergingBars } from '../../ui/charts';
import { usd } from '../../ui/CountUp';
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

const AUTO_PCT = 95;

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

/** A short chip label for why the case escalated; the full sentence is the chip's tooltip. */
export function escalationChip(reason: string): string {
  if (/verif/i.test(reason)) return 'Failed re-verify';
  if (/flag|inject/i.test(reason)) return 'Input flagged';
  if (/threshold|below/i.test(reason)) return `Below ${AUTO_PCT}%`;
  if (/cedar|deny/i.test(reason)) return 'Cedar denied';
  return 'Escalated';
}

/** Escalated decision case: the evidence package as a graph, details on click, and the reviewer's decision form. */
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
  const escalated = tag(row.status) === 'Escalated';
  const similar = data.cases.find(c => c.similarTo === row.id);

  const [approve, setApprove] = useState(true);
  const [credit, setCredit] = useState('');
  const [reason, setReason] = useState<string>(REASON_CODES[0][0]);
  const [text, setText] = useState('');
  const [decisive, setDecisive] = useState<string[]>(['telemetry']);
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('gt-reviewer') ?? 'ops.reviewer');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openNode, setOpenNode] = useState<string | null>(null);

  useEffect(() => {
    const suggested = s2 && tag(s2.verdict) === 'Approve' ? Number(s2.creditCents) : Number(row.entitledCreditCents);
    setCredit((Math.min(suggested, Number(row.amountClaimedCents)) / 100).toFixed(2));
    setError(null);
    setOpenNode(null);
    // Reset the form only when a different case is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const graph = useMemo(() => {
    if (!s) return null;
    const loss = s.telemetry.loss_pct;
    const flagged = screen?.flagged ?? false;
    const s1Pct = s1?.confidencePct ?? 0;
    const gateTone = guard ? 'block' : escalated ? 'warn' : tag(row.finalVerdict) === 'Approve' ? 'pass' : 'block';
    const verdictText = escalated ? usd(row.amountClaimedCents) : tag(row.finalVerdict) === 'Approve' ? usd(row.finalCreditCents) : 'Denied';
    const nodes: GraphNode[] = [
      { id: 'telemetry', title: 'Telemetry', icon: Activity, value: `${loss}% loss`, tone: loss >= 25 ? 'warn' : 'neutral', hint: `${s.telemetry.received_mb} of ${s.telemetry.expected_mb} MB received` },
      { id: 'weather', title: 'Space weather', icon: SunMedium, value: `Kp ${s.weather.kp_index}`, tone: s.weather.storm ? 'warn' : 'neutral', hint: s.weather.storm ? 'Geomagnetic storm' : 'Quiet' },
      { id: 'station', title: 'Station', icon: RadioTower, value: `${s.station_history.drop_rate_pct}% drops`, tone: s.station_history.maintenance_overlap ? 'warn' : 'neutral', hint: '30-day drop rate' },
      { id: 'contract', title: 'Contract', icon: FileText, value: usd(s.contract.entitled_credit_cents), tone: s.contract.within_window ? 'neutral' : 'warn', hint: 'Entitled credit' },
      { id: 'ml', title: 'Failure model', icon: Sparkles, value: `${(s.ml.failure_probability * 100).toFixed(1)}%`, hint: 'ML failure probability' },
      { id: 'message', title: 'Message', icon: MessageSquareWarning, value: message ? (flagged ? 'Flagged' : 'Clean') : 'None', tone: flagged ? 'block' : 'neutral', hint: 'Untrusted customer text' },
      { id: 's1', title: 'System 1', icon: Cpu, value: s1 ? `${s1Pct.toFixed(1)}%` : '—', tone: s1Pct >= AUTO_PCT ? 'pass' : 'neutral', hint: s1 ? `${tag(s1.verdict)} · features only` : undefined },
      s2
        ? { id: 's2', title: 'System 2', icon: Bot, value: `${s2.confidencePct.toFixed(0)}%`, tone: s2.confidencePct >= AUTO_PCT ? 'pass' : 'warn', hint: `${tag(s2.verdict)} · reads every source` }
        : { id: 's2', title: 'System 2', icon: Bot, value: 'Not run', ghost: true, hint: flagged ? 'Guard stopped the case before System 2' : undefined },
      { id: 'gate', title: 'Re-verify · Cedar', icon: ShieldCheck, value: guard ? 'Failed' : escalated ? 'Escalate' : 'Allow', tone: gateTone, hint: row.escalationReason || undefined },
      { id: 'verdict', title: escalated ? 'Human review' : 'Verdict', icon: escalated ? UserCheck : Gavel, value: verdictText, tone: escalated ? 'warn' : tag(row.finalVerdict) === 'Approve' ? 'pass' : 'block', emphasis: true },
    ];
    const structured = ['telemetry', 'weather', 'station', 'contract', 'ml'];
    const edges: GraphEdge[] = [
      ...structured.map(id => ({ from: id, to: 's1' })),
      ...[...structured, 'message'].map(id => ({ from: id, to: 's2', dashed: !s2 })),
      { from: 's1', to: 'gate' },
      { from: 's2', to: 'gate', dashed: !s2 },
      { from: 'gate', to: 'verdict', tone: gateTone },
    ];
    return { nodes, edges };
  }, [s, s1, s2, guard, screen, message, escalated, row]);

  if (!s || !graph) return <div className="cr-empty">Case snapshot unavailable.</div>;

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

  const stepDetail = (d: typeof s1) => d && (
    <>
      <div className="ui-chips">
        <Chip tone={tag(d.verdict) === 'Approve' ? 'pass' : tag(d.verdict) === 'Deny' ? 'block' : 'warn'}>{tag(d.verdict)}</Chip>
        <Chip>{d.confidencePct.toFixed(1)}%</Chip>
        <Chip>{d.modelVersion}</Chip>
      </div>
      <p className="ui-quote">{d.rationale}</p>
      {d.citedEvidence.length > 0 && (
        <div>
          <div className="ui-section-title">Cites</div>
          <div className="ui-chips">{d.citedEvidence.map(c => <Chip key={c}>{c.split(':')[0]}</Chip>)}</div>
        </div>
      )}
    </>
  );

  const drawer: Record<string, { eyebrow: string; title: string; body: ReactNode }> = {
    telemetry: {
      eyebrow: `Pass #${s.pass.id}`, title: 'Telemetry',
      body: (<>
        <Fact label="Pass status" value={`${s.pass.status} · ${s.pass.station_id} · ${s.pass.duration_min} min`} />
        <Fact label="Data received" value={`${s.telemetry.received_mb} of ${s.telemetry.expected_mb} MB`} />
        <Fact label="Telemetry loss" value={`${s.telemetry.loss_pct}%`} tone={s.telemetry.loss_pct >= 25 ? 'warn' : undefined} />
        <Fact label="SNR" value={`${s.telemetry.snr_db} dB`} />
        <Fact label="Pass value" value={usd(s.pass.revenue_cents)} />
      </>),
    },
    weather: {
      eyebrow: 'Nearest reading', title: 'Space weather',
      body: (<>
        <Fact label="Kp index" value={`${s.weather.kp_index}${s.weather.storm ? ' · storm' : ''}`} tone={s.weather.storm ? 'warn' : undefined} />
        <Fact label="Flare class" value={s.weather.flare_class} />
        <Fact label="Dst" value={`${s.weather.dst_index} nT`} />
      </>),
    },
    station: {
      eyebrow: '30 days', title: 'Station history',
      body: (<>
        <Fact label="Drops" value={`${s.station_history.drops_30d} of ${s.station_history.passes_30d} (${s.station_history.drop_rate_pct}%)`} />
        <Fact label="Maintenance" value={s.station_history.maintenance_overlap ? s.station_history.maintenance_note ?? 'Overlapping window' : 'None overlapping'} tone={s.station_history.maintenance_overlap ? 'warn' : undefined} />
      </>),
    },
    contract: {
      eyebrow: `${s.contract.contract_id} · ${s.contract.tier}`, title: 'Contract',
      body: (<>
        <p className="ui-quote">{s.contract.sla_clause}</p>
        <Fact label="Entitlement" value={usd(s.contract.entitled_credit_cents)} />
        <Fact label="Weather exclusion" value={s.contract.weather_exclusion ? 'Yes' : 'No'} />
        <Fact label="Claim window" value={`${s.contract.days_since_pass} of ${s.contract.claim_window_days} days`} tone={s.contract.within_window ? undefined : 'warn'} />
      </>),
    },
    ml: {
      eyebrow: s.ml.model_version, title: 'Failure model',
      body: (<>
        <Fact label="Failure probability" value={`${(s.ml.failure_probability * 100).toFixed(1)}%`} />
        <div>
          <div className="ui-section-title">SHAP contributions</div>
          <DivergingBars data={s.ml.shap.map(r => ({ name: r.feature, value: r.value }))} label="SHAP contribution per feature" />
        </div>
      </>),
    },
    message: {
      eyebrow: 'Untrusted', title: 'Customer message',
      body: message ? (<>
        <pre>{message.body}</pre>
        {screen && (
          <div className="ui-chips">
            <Chip tone={screen.flagged ? 'block' : 'pass'} icon={screen.flagged ? MessageSquareWarning : Check}>Screen {screen.flagged ? 'flagged' : 'passed'} · {screen.score}</Chip>
            {screen.reasons.map(r => <Chip key={r} tone="block">{r}</Chip>)}
          </div>
        )}
        {extracted && (
          <div>
            <div className="ui-section-title">Extracted</div>
            <div className="ui-chips">
              {[
                extracted.asserts_total_outage && 'total outage',
                extracted.asserts_degradation && 'degradation',
                extracted.asserts_late_delivery && 'late delivery',
                extracted.mentions_weather && 'weather',
                extracted.requested_amount_cents != null && `requests ${usd(extracted.requested_amount_cents)}`,
                ...extracted.cited_references.map(c => `cites ${c}`),
              ].filter(Boolean).map(x => <Chip key={String(x)}>{x}</Chip>)}
            </div>
          </div>
        )}
      </>) : <p>No message filed.</p>,
    },
    s1: { eyebrow: s1?.modelVersion ?? '', title: 'System 1', body: stepDetail(s1) ?? <p>Not run.</p> },
    s2: { eyebrow: s2?.modelVersion ?? '', title: 'System 2', body: stepDetail(s2) ?? <p>Not invoked.</p> },
    gate: {
      eyebrow: `Policy ${row.policyVersion || 'v4'}`, title: 'Re-verify and Cedar',
      body: (<>
        {row.escalationReason && <p className="ui-quote">{row.escalationReason}</p>}
        {guard && stepDetail(guard)}
        <Fact label="Rules fired" value={`${row.policyVersion || 'v4'} base policy`} />
        <Fact label="Learned rule" value="None matched" />
      </>),
    },
    verdict: {
      eyebrow: row.claimRef, title: escalated ? 'Awaiting human review' : 'Verdict',
      body: (<>
        {row.summary && (<div><div className="ui-section-title">System 2 case summary</div><p>{row.summary}</p></div>)}
        <Fact label="Claimed" value={usd(row.amountClaimedCents)} />
        <Fact label="Entitled" value={usd(row.entitledCreditCents)} />
        {!escalated && <Fact label="Credited" value={usd(row.finalCreditCents)} />}
      </>),
    },
  };
  const active = openNode ? drawer[openNode] : null;

  return (
    <div className="cr">
      <div className="cr-head">
        <div className="cr-head-main">
          <span className="ui-eyebrow">{row.claimRef}</span>
          <div className="cr-title">
            <span>{row.customer}</span>
            <span className="cr-title-amount">{usd(row.amountClaimedCents)}</span>
          </div>
          <div className="ui-chips">
            <Chip>{CLAIM_TYPE_LABELS[tag(row.claimType)] ?? tag(row.claimType)}</Chip>
            {escalated && <Chip tone="warn" title={row.escalationReason}>{escalationChip(row.escalationReason)}</Chip>}
            {decided && <Chip tone="accent" icon={UserCheck}>Human decided</Chip>}
          </div>
        </div>
        <button className="ui-link-btn" onClick={() => openReplay(`case:${row.claimRef}`)}>
          <Play size={12} /> Replay path
        </button>
      </div>

      <div className="cr-graph">
        <div className="ui-section-title">Evidence package <span className="cr-hint">click a node for detail</span></div>
        <FlowGraph
          key={String(row.id)}
          nodes={graph.nodes}
          edges={graph.edges}
          height={420}
          selectedId={openNode}
          onSelect={setOpenNode}
          rankSep={56}
          label={`Evidence for ${row.claimRef} feeding System 1 and System 2, then re-verify and Cedar, then the verdict`}
        />
      </div>

      {decided ? (
        <motion.div className="cr-outcome" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div className="ui-chips">
            <Chip tone={tag(row.finalVerdict) === 'Approve' ? 'pass' : 'block'} icon={UserCheck}>
              {label?.reviewer ?? 'Human'} · {tag(row.finalVerdict)} {usd(row.finalCreditCents)}
            </Chip>
            {retrained
              ? <Chip tone={tag(retrained.status) === 'Rejected' ? 'warn' : 'accent'} icon={RotateCcw} title={retrained.note}>
                  s1-v{retrained.version} {tag(retrained.status) === 'Rejected' ? 'rejected' : 'live'} · {retrained.latencyMs.toFixed(0)} ms
                </Chip>
              : <Chip icon={RotateCcw}>Retraining…</Chip>}
            {similar && (
              <Chip tone={tag(similar.status) === 'AutoDecided' ? 'pass' : 'warn'} icon={Building2}
                title={tag(similar.status) === 'Escalated' ? similar.escalationReason : `${SYSTEM_LABELS[tag(similar.decidedBy)] ?? ''} · ${similar.modelVersion} · policy ${similar.policyVersion}`}>
                {similar.claimRef} {tag(similar.status) === 'AutoDecided' ? `auto ${tag(similar.finalVerdict)} ${usd(similar.finalCreditCents)}` : tag(similar.status) === 'Escalated' ? 'escalated' : 'deciding…'}
              </Chip>
            )}
          </div>
          {similar ? (
            <button className="ui-link-btn" onClick={() => openReplay(`case:${similar.claimRef}`)}><Play size={12} /> Replay {similar.claimRef}</button>
          ) : (
            <button className="btn btn-edit cr-similar-btn" onClick={() => reducers()?.fileSimilarCase({ caseId: row.id })}>
              File a similar claim
            </button>
          )}
        </motion.div>
      ) : (
        <div className="cr-form">
          <div className="cr-form-row">
            <div className="cr-toggle" role="radiogroup" aria-label="Verdict">
              <button className={approve ? 'on' : ''} onClick={() => setApprove(true)} role="radio" aria-checked={approve}>Approve</button>
              <button className={!approve ? 'on deny' : ''} onClick={() => setApprove(false)} role="radio" aria-checked={!approve}>Deny</button>
            </div>
            {approve && (
              <label className="cr-field cr-field-credit">
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
          <div className="cr-evidence" aria-label="Decisive evidence">
            <span className="ui-eyebrow">Decided by</span>
            {EVIDENCE.map(([k, v]) => (
              <button key={k} type="button" className={`cr-check ${decisive.includes(k) ? 'on' : ''}`} onClick={() => toggle(k)} aria-pressed={decisive.includes(k)}>
                {decisive.includes(k) && <Check size={11} />}{v}
              </button>
            ))}
          </div>
          <div className="cr-form-foot">
            <input className="cr-text" placeholder="Notes (optional)" value={text} onChange={e => setText(e.target.value)} />
            <button className={`btn ${approve ? 'btn-approve' : 'btn-reject'}`} onClick={submit} disabled={busy}>
              {approve ? `Approve ${usd(Math.round(parseFloat(credit || '0') * 100))}` : 'Deny claim'}
            </button>
          </div>
          {error && <div className="cr-error">{error}</div>}
        </div>
      )}

      <Drawer open={!!active} onClose={() => setOpenNode(null)} eyebrow={active?.eyebrow} title={active?.title ?? ''}>
        {active?.body}
      </Drawer>
    </div>
  );
}
