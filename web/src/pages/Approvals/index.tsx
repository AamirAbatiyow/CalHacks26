import { useState, useMemo, useEffect } from 'react';
import { motion } from 'motion/react';
import { Check, Cpu, Layers, Pencil, Play, ShieldAlert, UserCheck, X } from 'lucide-react';
import { usePendingApprovals, useApprovalActions } from '../../hooks/useApprovals';
import { useDecisionData, CLAIM_TYPE_LABELS } from '../../hooks/useDecisions';
import { tag, useConnected } from '../../hooks/useTable';
import { CaseReview, escalationChip } from './CaseReview';
import { openReplay } from '../../replay/useDecisionTrace';
import { FlowGraph, type GraphNode, type GraphEdge } from '../../ui/FlowGraph';
import { Drawer, Fact } from '../../ui/Drawer';
import { Chip } from '../../ui/Chip';
import { Meter } from '../../ui/charts';
import { EmptyState } from '../../ui/EmptyState';
import { SkeletonRows } from '../../ui/Skeleton';
import { usd } from '../../ui/CountUp';
import type { EscalatedClaim } from '../../types';
import './Approvals.css';

const AUTO_APPROVE_CONFIDENCE = 95;
const LOW_CONFIDENCE = 80;

interface RowProps {
  selected: boolean;
  onClick: () => void;
  eyebrow?: string;
  customer: string;
  cents: bigint;
  confidence: number | null;
  chip: { label: string; tone: 'warn' | 'pass' | 'accent'; title?: string };
}

function QueueRow({ selected, onClick, eyebrow, customer, cents, confidence, chip }: RowProps) {
  return (
    <button className={`claim-row ${selected ? 'selected' : ''}`} onClick={onClick}>
      {selected && <motion.span layoutId="approvals-selected" className="claim-row-bg" transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} />}
      {eyebrow && <span className="claim-source">{eyebrow}</span>}
      <span className="claim-row-line">
        <span className="claim-customer">{customer}</span>
        <span className="claim-amount">{usd(cents)}</span>
      </span>
      <span className="claim-row-line">
        {confidence !== null ? (
          <span className="claim-confidence">
            <Meter value={confidence} threshold={AUTO_APPROVE_CONFIDENCE} label={`Confidence ${confidence.toFixed(1)}% against the ${AUTO_APPROVE_CONFIDENCE}% threshold`} />
            {confidence.toFixed(confidence % 1 === 0 ? 0 : 1)}%
          </span>
        ) : <span />}
        <Chip tone={chip.tone} title={chip.title}>{chip.label}</Chip>
      </span>
    </button>
  );
}

function ClaimDetail({ claim, onApprove, onDeny, onEdit }: {
  claim: EscalatedClaim;
  onApprove: () => void;
  onDeny: () => void;
  onEdit: (cents: bigint) => void;
}) {
  const [openNode, setOpenNode] = useState<string | null>(null);
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
            <Chip tone="warn" title={claim.escalationReason}>{low ? 'Low confidence' : `Below ${AUTO_APPROVE_CONFIDENCE}%`}</Chip>
            <Chip>Policy {claim.policyVersion}</Chip>
            <Chip>{claim.modelVersion}</Chip>
          </div>
        </div>
        <button className="ui-link-btn" onClick={() => openReplay(`approval:${claim.id}`)}>
          <Play size={12} /> Replay path
        </button>
      </div>

      <div className="cr-graph">
        <div className="ui-section-title">Decision path <span className="cr-hint">click a node for detail</span></div>
        <FlowGraph key={String(claim.id)} nodes={nodes} edges={edges} height={150} selectedId={openNode} onSelect={setOpenNode} rankSep={56}
          label={`${claim.passIds.length} passes into System 1 at ${claim.confidencePct}%, below the gate, to human review`} />
      </div>

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

export default function ApprovalsPage() {
  const connected = useConnected();
  const pendingClaims = usePendingApprovals();
  const { approveClaim, denyClaim, editClaim } = useApprovalActions();
  const [selectedClaimId, setSelectedClaimId] = useState<bigint | null>(null);
  const decisionData = useDecisionData();
  const [selectedCaseId, setSelectedCaseId] = useState<bigint | null>(null);
  const selectedCase = selectedCaseId !== null
    ? decisionData.cases.find(c => c.id === selectedCaseId) ?? null
    : selectedClaimId === null ? decisionData.escalated[0] ?? null : null;
  useEffect(() => {
    if (selectedCaseId === null && selectedClaimId === null && decisionData.escalated[0]) {
      setSelectedCaseId(decisionData.escalated[0].id);
    }
  }, [selectedCaseId, selectedClaimId, decisionData.escalated]);
  const caseRows = selectedCase && !decisionData.escalated.includes(selectedCase)
    ? [selectedCase, ...decisionData.escalated]
    : decisionData.escalated;

  const selectedClaim = useMemo(() =>
    pendingClaims.find(c => c.id === selectedClaimId) || pendingClaims[0] || null,
    [pendingClaims, selectedClaimId]
  );

  if (!connected) {
    return (
      <div className="approvals-page">
        <div className="approvals-list"><SkeletonRows rows={8} height={88} /></div>
        <div className="approvals-detail" />
      </div>
    );
  }

  if (pendingClaims.length === 0 && caseRows.length === 0) {
    return (
      <div className="approvals-page">
        <div className="approvals-empty">
          <EmptyState art="inbox" title="All caught up" hint="No claims are waiting for review." />
        </div>
      </div>
    );
  }

  return (
    <div className="approvals-page">
      <div className="approvals-list">
        <div className="approvals-list-head">
          <span className="ui-eyebrow">Queue</span>
          <span className="approvals-count">{caseRows.filter(c => tag(c.status) === 'Escalated').length + pendingClaims.length}</span>
        </div>
        {caseRows.map(c => {
          const s1 = [...(decisionData.stepsByCase.get(c.id) ?? [])].reverse().find(d => tag(d.system) === 'System1');
          const open = tag(c.status) === 'Escalated';
          return (
            <QueueRow
              key={`case-${c.id}`}
              selected={selectedCase?.id === c.id}
              onClick={() => { setSelectedCaseId(c.id); setSelectedClaimId(null); }}
              eyebrow={`${c.claimRef} · ${CLAIM_TYPE_LABELS[tag(c.claimType)] ?? ''}`}
              customer={c.customer}
              cents={c.amountClaimedCents}
              confidence={s1 ? s1.confidencePct : null}
              chip={open ? { label: escalationChip(c.escalationReason), tone: 'warn', title: c.escalationReason } : { label: 'Decided', tone: 'pass' }}
            />
          );
        })}
        {pendingClaims.map(claim => (
          <QueueRow
            key={String(claim.id)}
            selected={!selectedCase && selectedClaim?.id === claim.id}
            onClick={() => { setSelectedClaimId(claim.id); setSelectedCaseId(null); }}
            customer={claim.customerName}
            cents={claim.amountClaimedCents}
            confidence={claim.confidencePct}
            chip={claim.confidencePct < LOW_CONFIDENCE
              ? { label: 'Low confidence', tone: 'warn', title: claim.escalationReason }
              : { label: `Below ${AUTO_APPROVE_CONFIDENCE}%`, tone: 'accent', title: claim.escalationReason }}
          />
        ))}
      </div>

      <motion.div
        key={selectedCase ? `case-${selectedCase.id}` : `claim-${selectedClaim?.id}`}
        className="approvals-detail cr-detail"
        initial={{ opacity: 0, x: 6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
      >
        {selectedCase ? (
          <CaseReview row={selectedCase} data={decisionData} />
        ) : selectedClaim && (
          <ClaimDetail
            claim={selectedClaim}
            onApprove={() => approveClaim(selectedClaim.id, selectedClaim.policyVersion, selectedClaim.modelVersion)}
            onDeny={() => denyClaim(selectedClaim.id, selectedClaim.policyVersion, selectedClaim.modelVersion)}
            onEdit={cents => editClaim(selectedClaim.id, cents, selectedClaim.policyVersion, selectedClaim.modelVersion)}
          />
        )}
      </motion.div>
    </div>
  );
}
