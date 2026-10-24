import { useState, useMemo, useEffect } from 'react';
import { motion } from 'motion/react';
import { Check, Cpu, Layers, Pencil, Play, ShieldAlert, UserCheck, X } from 'lucide-react';
import { usePendingApprovals, useApprovalActions } from '../../hooks/useApprovals';
import { useDecisionData, CLAIM_TYPE_LABELS } from '../../hooks/useDecisions';
import { tag, useConnected, useTable, micros } from '../../hooks/useTable';
import { useHashParam } from '../../hooks/useHashPage';
import { useClaimData } from '../../hooks/useClaimData';
import { CaseReview, escalationChip } from './CaseReview';
import { useClaimCases, useContracts, useAuditDecisions, useMiningResults, humanize, type MiningResult } from '../../hooks/useCases';
import CaseDetail, { type DecisionNotice } from './CaseDetail';
import { useTechMode } from '../../hooks/useTechMode';
import { plainEscalation } from '../../utils/plainReason';
import { DataTable, type Column } from '../../ui/DataTable';
import { openReplay } from '../../replay/useDecisionTrace';
import { FlowGraph, type GraphNode, type GraphEdge } from '../../ui/FlowGraph';
import { Drawer, Fact } from '../../ui/Drawer';
import { Chip } from '../../ui/Chip';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { usd } from '../../ui/CountUp';
import type { EscalatedClaim, Pass, Satellite, SpaceWeather, Station } from '../../types';
import { ClaimGlobe, type ClaimFocus } from './ClaimGlobe';
import { ClaimPlaybackBar } from './ClaimPlaybackBar';
import { ClaimPanel, ClaimSkeleton } from './ClaimPanel';
import './Approvals.css';
import './Claim.css';
import './Claims.css';

const AUTO_APPROVE_CONFIDENCE = 95;
const LOW_CONFIDENCE = 80;

function MiningBanner({ result, error }: { result?: MiningResult; error?: string }) {
  if (error) {
    return <div className="mining-banner error">Decision not recorded: {error}</div>;
  }
  if (!result) return null;
  const proposed = result.proposalVersion;
  const pattern = result.pattern.map(p => humanize(p.replace('=', ': '))).join(' · ');
  return (
    <div className={`mining-banner ${proposed ? 'proposed' : ''}`}>
      <span className="mb-case">{result.caseId} decided</span>
      {proposed ? (
        <span>
          Rule proposed as <b>{proposed}</b>: {result.consistent} consistent decisions, none contradicting ({pattern} → {result.outcome}).
          {' '}<a href={`#/policies/${proposed}`}>Review replay on Policies</a>
        </span>
      ) : (
        <span>No rule proposed. {result.detail}.{pattern && <> Pattern: {pattern} → {result.outcome}.</>}</span>
      )}
    </div>
  );
}

type QueueKind = 'decisionCase' | 'claimCase' | 'claim' | 'escalated';

interface QueueItem {
  /** Hash key: the claim id (`CLM-20001`), `ESC-<id>` for an escalation with no case, `DC-<id>` for a decision case. */
  key: string;
  kind: QueueKind;
  customer: string;
  sub: string;
  cents: number;
  confidence: number | null;
  open: boolean;
  reason: string;
  statusLabel: string;
}

function queueColumns(tech: boolean): Column<QueueItem>[] {
  const cols: Column<QueueItem>[] = [
    {
      key: 'customer', label: 'Customer', width: 'minmax(0, 1fr)', sort: q => q.customer,
      render: q => <><span className="queue-customer">{q.customer}</span><span className="ui-table-sub">{q.sub}</span></>,
    },
    {
      key: 'status', label: 'Status', width: '124px', sort: q => (q.open ? 0 : 1),
      render: q => q.open
        ? <Chip tone="warn" title={tech ? q.reason : undefined}>{tech ? escalationChip(q.reason) : plainEscalation(q.reason)}</Chip>
        : <Chip tone="pass">{q.statusLabel}</Chip>,
    },
    { key: 'amount', label: 'Amount', width: '72px', align: 'right', sort: q => q.cents, render: q => <b className="queue-amount">{usd(q.cents)}</b> },
  ];
  if (tech) {
    cols.splice(2, 0, {
      key: 'confidence', label: 'Conf.', width: '44px', align: 'right', sort: q => q.confidence ?? -1,
      render: q => <span className="ui-table-muted">{q.confidence === null ? '—' : `${q.confidence.toFixed(0)}%`}</span>,
    });
  }
  return cols;
}

function ClaimDetail({ claim, onApprove, onDeny, onEdit }: {
  claim: EscalatedClaim;
  onApprove: () => void;
  onDeny: () => void;
  onEdit: (cents: bigint) => void;
}) {
  const [openNode, setOpenNode] = useState<string | null>(null);
  const tech = useTechMode();
  const [editMode, setEditMode] = useState(false);
  const [editAmount, setEditAmount] = useState('');
  useEffect(() => { setOpenNode(null); setEditMode(false); }, [claim.id]);

  const low = claim.confidencePct < LOW_CONFIDENCE;
  const nodes: GraphNode[] = [
    { id: 'passes', title: 'Billed passes', icon: Layers, value: `${claim.passIds.length}`, hint: 'Open passes the claim covers' },
    { id: 's1', title: 'System 1', icon: Cpu, value: `${claim.confidencePct}%`, tone: low ? 'warn' : 'neutral', hint: claim.modelVersion },
    { id: 'gate', title: 'Confidence gate', icon: ShieldAlert, value: `< ${AUTO_APPROVE_CONFIDENCE}%`, tone: 'warn', hint: claim.escalationReason },
    { id: 'human', title: 'Human review', icon: UserCheck, value: usd(claim.proposedAmountCents), tone: 'warn', emphasis: true, hint: 'Proposed credit' },
  ];
  const edges: GraphEdge[] = [
    { from: 'passes', to: 's1' },
    { from: 's1', to: 'gate' },
    { from: 'gate', to: 'human', tone: 'warn' },
  ];

  const confirmEdit = () => {
    if (!editAmount) return;
    onEdit(BigInt(Math.round(parseFloat(editAmount) * 100)));
    setEditMode(false);
  };

  return (
    <div className="cr">
      <div className="cr-head">
        <div className="cr-head-main">
          <span className="ui-eyebrow">Escalated claim</span>
          <div className="cr-title">
            <span>{claim.customerName}</span>
            <span className="cr-title-amount">{usd(claim.amountClaimedCents)}</span>
          </div>
          <div className="ui-chips">
            {tech ? (<>
              <Chip tone="warn" title={claim.escalationReason}>{low ? 'Low confidence' : `Below ${AUTO_APPROVE_CONFIDENCE}%`}</Chip>
              <Chip>Policy {claim.policyVersion}</Chip>
              <Chip>{claim.modelVersion}</Chip>
            </>) : <Chip tone="warn">Needs review</Chip>}
          </div>
        </div>
        <button className="ui-link-btn" onClick={() => openReplay(`approval:${claim.id}`)}>
          <Play size={12} /> Replay path
        </button>
      </div>

      {tech ? (
        <div className="cr-graph">
          <div className="ui-section-title">Decision path <span className="cr-hint">click a node for detail</span></div>
          <FlowGraph key={String(claim.id)} nodes={nodes} edges={edges} height={150} selectedId={openNode} onSelect={setOpenNode} rankSep={56}
            label={`${claim.passIds.length} passes into System 1 at ${claim.confidencePct}%, below the gate, to human review`} />
        </div>
      ) : (
        <div className="ui-tiles cr-tiles">
          <div className="ui-tile"><span className="ui-stat-label">Claimed</span><span className="ui-stat-value">{usd(claim.amountClaimedCents)}</span></div>
          <div className="ui-tile"><span className="ui-stat-label">Proposed credit</span><span className="ui-stat-value">{usd(claim.proposedAmountCents)}</span></div>
          <div className="ui-tile"><span className="ui-stat-label">Passes covered</span><span className="ui-stat-value">{claim.passIds.length}</span></div>
        </div>
      )}

      {editMode ? (
        <div className="cr-form">
          <div className="cr-form-foot">
            <label className="cr-field cr-field-credit">
              Adjusted credit ($)
              <input type="number" value={editAmount} onChange={e => setEditAmount(e.target.value)} autoFocus />
            </label>
            <div className="detail-actions">
              <button className="btn btn-confirm" onClick={confirmEdit}>Confirm</button>
              <button className="btn btn-cancel" onClick={() => setEditMode(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="cr-form">
          <div className="detail-actions">
            <button className="btn btn-approve" onClick={onApprove}><Check size={14} /> Approve {usd(claim.proposedAmountCents)}</button>
            <button className="btn btn-edit" onClick={() => { setEditAmount((Number(claim.proposedAmountCents) / 100).toString()); setEditMode(true); }}><Pencil size={13} /> Edit</button>
            <button className="btn btn-reject" onClick={onDeny}><X size={14} /> Reject</button>
          </div>
        </div>
      )}

      <Drawer open={openNode !== null} onClose={() => setOpenNode(null)} eyebrow={claim.customerName}
        title={nodes.find(n => n.id === openNode)?.title ?? ''}>
        {openNode === 'passes' && (
          <div className="ui-chips">{claim.passIds.map(id => <Chip key={String(id)}>#{String(id)}</Chip>)}</div>
        )}
        {openNode === 's1' && (<>
          <Fact label="Confidence" value={`${claim.confidencePct}%`} tone={low ? 'warn' : undefined} />
          <Fact label="Model" value={claim.modelVersion} />
        </>)}
        {openNode === 'gate' && (<>
          <p className="ui-quote">{claim.escalationReason}</p>
          <Fact label="Rule" value={`confidence_below_${AUTO_APPROVE_CONFIDENCE}`} />
          <Fact label="Policy" value={claim.policyVersion} />
        </>)}
        {openNode === 'human' && (<>
          <Fact label="Claimed" value={usd(claim.amountClaimedCents)} />
          <Fact label="Proposed credit" value={usd(claim.proposedAmountCents)} />
        </>)}
      </Drawer>
    </div>
  );
}

interface ClaimsPageProps {
  stations: Station[];
  satellites: Satellite[];
  passes: Pass[];
  spaceWeather: SpaceWeather[];
}

function decidedLabel(outcome: string, auto: boolean): string {
  const o = outcome === 'approve' ? 'Approved' : outcome === 'deny' ? 'Denied' : outcome === 'partial' ? 'Partial' : 'Decided';
  return auto ? `Auto · ${o}` : o;
}

/** Claim globe focus for a pass from the live pass table, with Kp from the reading nearest its start. */
function passFocus(
  passId: bigint | undefined,
  passes: Map<bigint, Pass>,
  stations: Map<string, Station>,
  satellites: Map<number, Satellite>,
  weather: SpaceWeather[],
): ClaimFocus | null {
  const pass = passId !== undefined ? passes.get(passId) : undefined;
  const station = pass && stations.get(pass.stationId);
  const sat = pass && satellites.get(pass.satelliteId);
  if (!pass || !station || !sat) return null;
  const kp = weather.reduce<SpaceWeather | null>((best, w) => !best
    || Math.abs(Number(w.timestamp - pass.startTime)) < Math.abs(Number(best.timestamp - pass.startTime)) ? w : best, null)?.kpIndex ?? 0;
  return {
    satelliteName: sat.name, tle1: sat.tleLine1, tle2: sat.tleLine2,
    stationName: station.name, stationLat: station.latitude, stationLon: station.longitude,
    stationAltM: station.altitudeM, stationRevenueCents: station.monthlyRevenueCents,
    contactStart: pass.startTime, signalLost: null, contactEnd: pass.endTime, kp,
  };
}

function sameFocus(a: ClaimFocus | null, b: ClaimFocus | null): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof ClaimFocus)[]).every(k => a[k] === b[k]);
}

/** The selected claim's pass on the globe, with playback across the contact window. */
function ClaimPassView({ focus }: { focus: ClaimFocus }) {
  const lost = focus.signalLost ?? focus.contactEnd;
  const [time, setTime] = useState<bigint>(() => focus.contactStart + ((lost - focus.contactStart) * 3n) / 5n);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 4>(4);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setTime(prev => {
        const next = prev + BigInt(100_000 * speed);
        if (next >= focus.contactEnd) {
          setIsPlaying(false);
          return focus.contactEnd;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [isPlaying, focus.contactEnd, speed]);

  return (<>
    <div className="claims-globe">
      <ClaimGlobe focus={focus} currentTime={time} />
    </div>
    <ClaimPlaybackBar
      currentTime={time}
      contactStart={focus.contactStart}
      signalLost={lost}
      contactEnd={focus.contactEnd}
      isPlaying={isPlaying}
      speed={speed}
      onPlayPause={() => setIsPlaying(p => !p)}
      onSeek={t => { setTime(t); setIsPlaying(false); }}
      onSpeedChange={setSpeed}
    />
  </>);
}

/**
 * Claims: one queue for every claim (escalated ones first), and for the selected
 * claim its pass on the globe beside the claim's detail and decision form.
 */
export default function ClaimsPage({ stations, satellites, passes, spaceWeather }: ClaimsPageProps) {
  const connected = useConnected();
  const pendingClaims = usePendingApprovals();
  const { approveClaim, denyClaim, editClaim } = useApprovalActions();
  const decisionData = useDecisionData();
  const claimCases = useClaimCases();
  const contracts = useContracts();
  const decisions = useAuditDecisions();
  const miningResults = useMiningResults();
  const claimRows = useTable('claim');
  const claimDecisions = useTable('claimDecision');
  const claimPasses = useTable('claimPass');
  const claimWeathers = useTable('claimWeather');
  const policyVersions = useTable('policyVersion');
  const [notice, setNotice] = useState<DecisionNotice | null>(null);
  const tech = useTechMode();
  const columns = useMemo(() => queueColumns(tech), [tech]);
  const requested = useHashParam();

  const queue = useMemo<QueueItem[]>(() => {
    const items: QueueItem[] = [];
    for (const c of decisionData.cases) {
      const s1 = [...(decisionData.stepsByCase.get(c.id) ?? [])].reverse().find(d => tag(d.system) === 'System1');
      const status = tag(c.status);
      items.push({
        key: `DC-${c.id}`, kind: 'decisionCase', customer: c.customer,
        sub: `${c.claimRef} · ${CLAIM_TYPE_LABELS[tag(c.claimType)] ?? ''}`, cents: Number(c.amountClaimedCents),
        confidence: s1 ? s1.confidencePct : null, open: status === 'Escalated', reason: c.escalationReason,
        statusLabel: humanize(status),
      });
    }
    const pendingById = new Map(pendingClaims.map(c => [c.id, c]));
    const linkedEscalations = new Set<bigint>();
    for (const c of claimCases) {
      const esc = c.escalationId !== undefined ? pendingById.get(c.escalationId) : undefined;
      if (c.escalationId !== undefined) linkedEscalations.add(c.escalationId);
      items.push({
        key: c.caseId, kind: 'claimCase', customer: c.customerName,
        sub: `${c.caseId} · ${humanize(c.claimType)}`, cents: Number(c.claimedCents),
        confidence: Number(c.confidence), open: c.outcome === '', reason: esc?.escalationReason ?? c.gateNote,
        statusLabel: decidedLabel(c.outcome, c.gate === 'auto'),
      });
    }
    const caseIds = new Set(claimCases.map(c => c.caseId));
    for (const claim of claimRows) {
      if (caseIds.has(claim.id)) continue;
      const decision = claimDecisions.find(d => d.claimId === claim.id);
      const escalated = decision ? tag(decision.gate) === 'Escalated' : false;
      items.push({
        key: claim.id, kind: 'claim', customer: claim.customerName, sub: claim.id,
        cents: Number(claim.amountClaimedCents), confidence: decision?.confidencePercent ?? null,
        open: false, reason: decision?.rule ?? '', statusLabel: escalated ? 'Reviewed' : 'Auto · Approved',
      });
    }
    for (const claim of pendingClaims) {
      if (linkedEscalations.has(claim.id)) continue;
      items.push({
        key: `ESC-${claim.id}`, kind: 'escalated', customer: claim.customerName,
        sub: `${claim.passIds.length} pass${claim.passIds.length === 1 ? '' : 'es'}`,
        cents: Number(claim.amountClaimedCents), confidence: claim.confidencePct, open: true,
        reason: claim.escalationReason, statusLabel: '',
      });
    }
    return items.map((q, i) => ({ q, i })).sort((a, b) => Number(b.q.open) - Number(a.q.open) || a.i - b.i).map(x => x.q);
  }, [decisionData.cases, decisionData.stepsByCase, pendingClaims, claimCases, claimRows, claimDecisions]);

  const selected = queue.find(q => q.key === requested) ?? queue.find(q => q.open) ?? queue[0] ?? null;
  const select = (key: string) => { window.location.hash = `/claims/${encodeURIComponent(key)}`; };

  const selectedCase = selected?.kind === 'decisionCase' ? decisionData.cases.find(c => `DC-${c.id}` === selected.key) ?? null : null;
  const selectedClaimCase = selected?.kind === 'claimCase' ? claimCases.find(c => c.caseId === selected.key) ?? null : null;
  const selectedEscalation = selected?.kind === 'escalated'
    ? pendingClaims.find(c => `ESC-${c.id}` === selected.key) ?? null
    : selectedClaimCase?.escalationId !== undefined ? pendingClaims.find(c => c.id === selectedClaimCase.escalationId) ?? null : null;
  const panelClaimId = selected && (selected.kind === 'claim' || (selected.kind === 'claimCase' && !selected.open)) ? selected.key : null;
  const panel = useClaimData(panelClaimId);

  const stationsById = useMemo(() => new Map(stations.map(s => [s.id, s])), [stations]);
  const satellitesById = useMemo(() => new Map(satellites.map(s => [s.noradId, s])), [satellites]);
  const passesById = useMemo(() => new Map(passes.map(p => [p.id, p])), [passes]);

  const focus = useMemo<ClaimFocus | null>(() => {
    if (!selected) return null;
    if (selectedClaimCase) {
      const sat = satellitesById.get(selectedClaimCase.satelliteId);
      const station = stationsById.get(selectedClaimCase.stationId);
      if (sat && station) {
        return {
          satelliteName: selectedClaimCase.satelliteName, tle1: sat.tleLine1, tle2: sat.tleLine2,
          stationName: selectedClaimCase.stationName, stationLat: station.latitude, stationLon: station.longitude,
          stationAltM: station.altitudeM, stationRevenueCents: station.monthlyRevenueCents,
          contactStart: micros(selectedClaimCase.contactStart), signalLost: micros(selectedClaimCase.signalLost),
          contactEnd: micros(selectedClaimCase.contactEnd), kp: selectedClaimCase.kp,
        };
      }
    }
    if (selected.kind === 'claim' || selected.kind === 'claimCase') {
      const cp = claimPasses.find(p => p.claimId === selected.key);
      if (cp) {
        const station = stations.find(s => s.name === cp.stationName);
        return {
          satelliteName: satellitesById.get(cp.satelliteNoradId)?.name ?? `NORAD ${cp.satelliteNoradId}`,
          tle1: cp.satelliteTle1, tle2: cp.satelliteTle2,
          stationName: cp.stationName, stationLat: cp.stationLat, stationLon: cp.stationLon,
          stationAltM: station?.altitudeM ?? 0, stationRevenueCents: station?.monthlyRevenueCents ?? 0n,
          contactStart: micros(cp.contactStartTime), signalLost: micros(cp.signalLostTime), contactEnd: micros(cp.contactEndTime),
          kp: claimWeathers.find(w => w.claimId === selected.key)?.kpIndex ?? 0,
        };
      }
    }
    const passId = selectedCase?.passId ?? selectedEscalation?.passIds[0];
    return passFocus(passId, passesById, stationsById, satellitesById, spaceWeather);
  }, [selected, selectedClaimCase, selectedCase, selectedEscalation, claimPasses, claimWeathers, stations, stationsById, satellitesById, passesById, spaceWeather]);

  const [stableFocus, setStableFocus] = useState(focus);
  if (!sameFocus(stableFocus, focus)) setStableFocus(focus);

  const lastResult = notice ? miningResults.find(r => r.caseId === notice.caseId) : miningResults[0];
  const banner = <MiningBanner result={notice?.error ? undefined : lastResult} error={notice?.error} />;
  const openCount = queue.filter(q => q.open).length;

  if (!connected) {
    return (
      <div className="claims-page">
        <div className="approvals-list claims-queue"><SkeletonRows rows={8} height={56} /></div>
        <div className="claims-globe-col" />
        <div className="claims-detail" />
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="claims-page">
        <div className="approvals-empty">
          {banner}
          <EmptyState art="inbox" title="No claims yet" hint={<>Seed some with <code>server/seed.sh</code>.</>} />
        </div>
      </div>
    );
  }

  const detail = (() => {
    if (selectedCase) return <CaseReview row={selectedCase} data={decisionData} />;
    if (selectedClaimCase && selected.open) {
      return (<>
        {banner}
        <CaseDetail
          key={selectedClaimCase.caseId}
          c={selectedClaimCase}
          contract={contracts.get(selectedClaimCase.customerId)}
          decisions={decisions}
          onDecided={setNotice}
        />
      </>);
    }
    if (selected.kind === 'escalated' && selectedEscalation) {
      return (<>
        {banner}
        <ClaimDetail
          claim={selectedEscalation}
          onApprove={() => approveClaim(selectedEscalation.id, selectedEscalation.policyVersion, selectedEscalation.modelVersion)}
          onDeny={() => denyClaim(selectedEscalation.id, selectedEscalation.policyVersion, selectedEscalation.modelVersion)}
          onEdit={cents => editClaim(selectedEscalation.id, cents, selectedEscalation.policyVersion, selectedEscalation.modelVersion)}
        />
      </>);
    }
    const { claim, evidence, decision, outcome, weather, reasons } = panel;
    if (!claim || !evidence || !decision || !outcome || !weather) return <ClaimSkeleton />;
    return (<>
      {notice?.caseId === selected.key && banner}
      <ClaimPanel
        claim={claim}
        evidence={evidence}
        decision={decision}
        outcome={outcome}
        weather={weather}
        reasons={reasons}
        policyKnown={policyVersions.some(v => v.id === decision.policyVersion)}
      />
    </>);
  })();

  return (
    <div className="claims-page">
      <div className="approvals-list claims-queue">
        <div className="approvals-list-head">
          <span className="ui-eyebrow">Claims</span>
          <span className="approvals-count">{openCount} need review · {queue.length} total</span>
        </div>
        <DataTable
          rows={queue}
          columns={columns}
          rowKey={q => q.key}
          selectedKey={selected.key}
          onRowClick={q => select(q.key)}
          label="Claims queue"
          className="queue-table"
        />
      </div>

      <div className="claims-globe-col">
        {stableFocus ? (
          <ClaimPassView key={selected.key} focus={stableFocus} />
        ) : (
          <EmptyState art="orbit" title="No pass on record" hint="This claim has no pass the globe can show." />
        )}
      </div>

      <motion.div
        key={selected.key}
        className={`approvals-detail cr-detail claims-detail${selectedClaimCase && selected.open ? ' case' : ''}`}
        initial={{ opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      >
        {detail}
      </motion.div>
    </div>
  );
}
