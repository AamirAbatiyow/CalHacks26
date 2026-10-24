import { useState, useMemo } from 'react';
import { usePendingApprovals, useApprovalActions } from '../../hooks/useApprovals';
import { openReplay } from '../../replay/useDecisionTrace';
import './Approvals.css';

function formatDollarsExact(cents: bigint): string {
  const dollars = Number(cents) / 100;
  return `$${dollars.toLocaleString()}`;
}

function getConfidenceLabel(confidence: number, amountCents: bigint): { label: string; type: 'warning' | 'info' } {
  const amount = Number(amountCents) / 100;
  if (amount > 25000) {
    return { label: 'Above $25K limit', type: 'warning' };
  }
  if (confidence >= 95) {
    return { label: `Confidence ${confidence}%`, type: 'info' };
  }
  return { label: `Confidence ${confidence}%`, type: 'info' };
}

export default function ApprovalsPage() {
  const pendingClaims = usePendingApprovals();
  const { approveClaim, denyClaim, editClaim } = useApprovalActions();
  const [selectedClaimId, setSelectedClaimId] = useState<bigint | null>(null);
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

  if (pendingClaims.length === 0) {
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
        {pendingClaims.map(claim => {
          const { label, type } = getConfidenceLabel(claim.confidencePct, claim.amountClaimedCents);
          const isSelected = selectedClaim?.id === claim.id;
          
          return (
            <button
              key={String(claim.id)}
              className={`claim-row ${isSelected ? 'selected' : ''}`}
              onClick={() => setSelectedClaimId(claim.id)}
            >
              <div className="claim-customer">{claim.customerName}</div>
              <div className="claim-amount">{formatDollarsExact(claim.amountClaimedCents)}</div>
              <div className="claim-confidence">Confidence {claim.confidencePct}%</div>
              <div className={`claim-tag ${type}`}>{label}</div>
            </button>
          );
        })}
      </div>
      
      {selectedClaim && (
        <div className="approvals-detail">
          <div className="detail-header">
            <h2>{selectedClaim.customerName}</h2>
            <span className="detail-amount">{formatDollarsExact(selectedClaim.amountClaimedCents)} credit</span>
          </div>
          
          <div className="detail-info">
            <p className="info-label">Automated review triggered.</p>
            <p className="info-reason">{selectedClaim.escalationReason}</p>
          </div>
          
          <div className="detail-meta">
            <span>Rule: requires_approval_over_25k</span>
            <span className="meta-sep">·</span>
            <span>Policy {selectedClaim.policyVersion}</span>
            <span className="meta-sep">·</span>
            <span>Model {selectedClaim.modelVersion}</span>
            <button className="replay-trigger detail-replay" onClick={() => openReplay(`approval:${selectedClaim.id}`)}>
              <span className="replay-trigger-glyph">▶</span>Replay path
            </button>
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
