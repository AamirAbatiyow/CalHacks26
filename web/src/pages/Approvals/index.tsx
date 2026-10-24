import { useState, useMemo, useEffect } from 'react';
import { usePendingApprovals, useApprovalActions } from '../../hooks/useApprovals';
import { useDecisionData, dollars, CLAIM_TYPE_LABELS } from '../../hooks/useDecisions';
import { tag } from '../../hooks/useTable';
import { CaseReview } from './CaseReview';
import './Approvals.css';

function formatDollarsExact(cents: bigint): string {
  const dollars = Number(cents) / 100;
  return `$${dollars.toLocaleString()}`;
}

function formatPasses(passIds: bigint[]): string {
  const shown = passIds.slice(0, 6).map(id => `#${id}`).join(', ');
  const more = passIds.length > 6 ? ` and ${passIds.length - 6} more` : '';
  return `Covers ${passIds.length} billed ${passIds.length === 1 ? 'pass' : 'passes'}: ${shown}${more}`;
}

const AUTO_APPROVE_CONFIDENCE = 95;
const LOW_CONFIDENCE = 80;

function getEscalationLabel(confidence: number): { label: string; type: 'warning' | 'info' } {
  if (confidence < LOW_CONFIDENCE) {
    return { label: 'Low confidence', type: 'warning' };
  }
  return { label: `Below ${AUTO_APPROVE_CONFIDENCE}% threshold`, type: 'info' };
}

export default function ApprovalsPage() {
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
  const [editMode, setEditMode] = useState(false);
  const [editAmount, setEditAmount] = useState('');

  const selectedClaim = useMemo(() => 
    pendingClaims.find(c => c.id === selectedClaimId) || pendingClaims[0] || null,
    [pendingClaims, selectedClaimId]
  );

  const handleApprove = () => {
    if (selectedClaim) {
      approveClaim(selectedClaim.id, selectedClaim.policyVersion, selectedClaim.modelVersion);
    }
  };

  const handleDeny = () => {
    if (selectedClaim) {
      denyClaim(selectedClaim.id, selectedClaim.policyVersion, selectedClaim.modelVersion);
    }
  };

  const handleEditStart = () => {
    if (selectedClaim) {
      setEditAmount((Number(selectedClaim.proposedAmountCents) / 100).toString());
      setEditMode(true);
    }
  };

  const handleEditConfirm = () => {
    if (selectedClaim && editAmount) {
      const newCents = BigInt(Math.round(parseFloat(editAmount) * 100));
      editClaim(selectedClaim.id, newCents, selectedClaim.policyVersion, selectedClaim.modelVersion);
      setEditMode(false);
      setEditAmount('');
    }
  };

  const handleEditCancel = () => {
    setEditMode(false);
    setEditAmount('');
  };

  if (pendingClaims.length === 0 && caseRows.length === 0) {
    return (
      <div className="approvals-page">
        <div className="approvals-empty">
          <span className="empty-icon">✓</span>
          <h2>All caught up</h2>
          <p>No claims pending review</p>
        </div>
      </div>
    );
  }

  return (
    <div className="approvals-page">
      <div className="approvals-list">
        {caseRows.map(c => {
          const s1 = [...(decisionData.stepsByCase.get(c.id) ?? [])].reverse().find(d => tag(d.system) === 'System1');
          const open = tag(c.status) === 'Escalated';
          return (
            <button
              key={`case-${c.id}`}
              className={`claim-row ${selectedCase?.id === c.id ? 'selected' : ''}`}
              onClick={() => { setSelectedCaseId(c.id); setSelectedClaimId(null); }}
            >
              <div className="claim-source">{c.claimRef} · {CLAIM_TYPE_LABELS[tag(c.claimType)] ?? ''}</div>
              <div className="claim-customer">{c.customer}</div>
              <div className="claim-amount">{dollars(c.amountClaimedCents)}</div>
              {s1 && <div className="claim-confidence">System 1 {s1.confidencePct.toFixed(1)}% {tag(s1.verdict).toLowerCase()}</div>}
              <div className={`claim-tag ${open ? 'warning' : 'info'}`}>{open ? 'Escalated with evidence' : 'Decided'}</div>
            </button>
          );
        })}
        {pendingClaims.map(claim => {
          const { label, type } = getEscalationLabel(claim.confidencePct);
          const isSelected = !selectedCase && selectedClaim?.id === claim.id;
          
          return (
            <button
              key={String(claim.id)}
              className={`claim-row ${isSelected ? 'selected' : ''}`}
              onClick={() => { setSelectedClaimId(claim.id); setSelectedCaseId(null); }}
            >
              <div className="claim-customer">{claim.customerName}</div>
              <div className="claim-amount">{formatDollarsExact(claim.amountClaimedCents)}</div>
              <div className="claim-confidence">Confidence {claim.confidencePct}%</div>
              <div className={`claim-tag ${type}`}>{label}</div>
            </button>
          );
        })}
      </div>
      
      {selectedCase ? (
        <div className="approvals-detail cr-detail">
          <CaseReview row={selectedCase} data={decisionData} />
        </div>
      ) : selectedClaim && (
        <div className="approvals-detail">
          <div className="detail-header">
            <h2>{selectedClaim.customerName}</h2>
            <span className="detail-amount">{formatDollarsExact(selectedClaim.amountClaimedCents)} credit</span>
          </div>
          
          <div className="detail-info">
            <p className="info-label">Escalated for human review.</p>
            <p className="info-reason">{selectedClaim.escalationReason}</p>
            <p className="info-reason">{formatPasses(selectedClaim.passIds)}</p>
          </div>
          
          <div className="detail-meta">
            <span>Rule: confidence_below_{AUTO_APPROVE_CONFIDENCE}</span>
            <span className="meta-sep">·</span>
            <span>Policy {selectedClaim.policyVersion}</span>
            <span className="meta-sep">·</span>
            <span>Model {selectedClaim.modelVersion}</span>
          </div>
          
          {editMode ? (
            <div className="detail-edit">
              <label className="edit-label">Adjusted amount ($)</label>
              <input
                type="number"
                className="edit-input"
                value={editAmount}
                onChange={(e) => setEditAmount(e.target.value)}
                autoFocus
              />
              <div className="edit-actions">
                <button className="btn btn-confirm" onClick={handleEditConfirm}>Confirm</button>
                <button className="btn btn-cancel" onClick={handleEditCancel}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="detail-actions">
              <button className="btn btn-approve" onClick={handleApprove}>Approve</button>
              <button className="btn btn-edit" onClick={handleEditStart}>Edit</button>
              <button className="btn btn-reject" onClick={handleDeny}>Reject</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
