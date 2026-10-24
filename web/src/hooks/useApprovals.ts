import { useCallback, useMemo } from 'react';
import { useTable, reducers, micros, tag } from './useTable';
import type { EscalatedClaim } from '../types';
import { EscalatedClaimStatus } from '../types';

function useEscalatedClaims(): EscalatedClaim[] {
  const rows = useTable('escalatedClaim');
  return useMemo(() => rows.map(row => ({
    id: row.id,
    customerName: row.customerName,
    amountClaimedCents: row.amountClaimedCents,
    proposedAmountCents: row.proposedAmountCents,
    confidencePct: row.confidencePct,
    escalationReason: row.escalationReason,
    status: tag(row.status) as EscalatedClaimStatus,
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
    createdAt: micros(row.createdAt),
  })), [rows]);
}

/** Escalated claims still waiting on a human decision, oldest first. */
export function usePendingApprovals(): EscalatedClaim[] {
  const claims = useEscalatedClaims();
  return useMemo(
    () => claims
      .filter(c => c.status === EscalatedClaimStatus.Pending)
      .sort((a, b) => Number(a.createdAt - b.createdAt) || Number(a.id - b.id)),
    [claims],
  );
}

export function useApprovalActions() {
  const approveClaim = useCallback((claimId: bigint, policyVersion: string, modelVersion: string) => {
    reducers()?.approveEscalatedClaim({ claimId, policyVersion, modelVersion });
  }, []);

  const denyClaim = useCallback((claimId: bigint, policyVersion: string, modelVersion: string) => {
    reducers()?.denyEscalatedClaim({ claimId, policyVersion, modelVersion });
  }, []);

  const editClaim = useCallback((claimId: bigint, newAmountCents: bigint, policyVersion: string, modelVersion: string) => {
    reducers()?.editEscalatedClaim({ claimId, newAmountCents, policyVersion, modelVersion });
  }, []);

  return { approveClaim, denyClaim, editClaim };
}
