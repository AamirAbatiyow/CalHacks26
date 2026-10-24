import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTable, micros, tag, type RowOf } from '../hooks/useTable';
import type { ClaimGate, DecisionOutcome, DecisionRecord, DecisionType, EscalatedClaimStatus } from '../types';
import { buildTrace, fromAuditRecord, fromClaimDecision, fromEscalatedClaim } from './adapter';
import type { DecisionRow, DecisionTrace, PipelineStepRow } from './types';

const NO_STEPS: PipelineStepRow[] = [];

/**
 * Per-step audit path recorded by the decision pipeline. Until its table is in
 * the module bindings every replay falls back to a seeded example path.
 */
function usePipelineSteps(): PipelineStepRow[] {
  return NO_STEPS;
}

export function toDecisionRecord(row: RowOf<'decisionRecord'>): DecisionRecord {
  return {
    id: row.id,
    createdAt: micros(row.createdAt),
    decisionType: tag(row.decisionType) as DecisionType,
    outcome: tag(row.outcome) as DecisionOutcome,
    passId: row.passId ?? null,
    stationId: row.stationId ?? null,
    amountCents: row.amountCents,
    reason: row.reason,
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
  };
}

function useDecisionRow(key: string | null): DecisionRow | null {
  const decisionRecords = useTable('decisionRecord');
  const claims = useTable('claim');
  const claimDecisions = useTable('claimDecision');
  const claimReasons = useTable('claimReason');
  const escalated = useTable('escalatedClaim');

  return useMemo(() => {
    if (!key) return null;
    const sep = key.indexOf(':');
    const kind = key.slice(0, sep);
    const id = key.slice(sep + 1);
    switch (kind) {
      case 'audit': {
        const row = decisionRecords.find(r => String(r.id) === id);
        return row ? fromAuditRecord(toDecisionRecord(row)) : null;
      }
      case 'claim': {
        const claim = claims.find(c => c.id === id);
        const decision = claimDecisions.find(d => d.claimId === id);
        if (!claim || !decision) return null;
        const top = claimReasons
          .filter(r => r.claimId === id)
          .sort((a, b) => Math.abs(b.shapValue) - Math.abs(a.shapValue))[0];
        return fromClaimDecision(
          { id: claim.id, customerName: claim.customerName, amountClaimedCents: claim.amountClaimedCents, passId: claim.passId, createdAt: micros(claim.createdAt) },
          {
            claimId: decision.claimId,
            creditAmountCents: decision.creditAmountCents,
            confidencePercent: decision.confidencePercent,
            gate: tag(decision.gate) as ClaimGate,
            rule: decision.rule,
            policyVersion: decision.policyVersion,
            modelVersion: decision.modelVersion,
            decidedAt: micros(decision.decidedAt),
          },
          top?.feature,
        );
      }
      case 'approval': {
        const row = escalated.find(r => String(r.id) === id);
        return row ? fromEscalatedClaim({
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
          passIds: row.passIds,
        }) : null;
      }
      default:
        return null;
    }
  }, [key, decisionRecords, claims, claimDecisions, claimReasons, escalated]);
}

export function useDecisionTrace(key: string | null): DecisionTrace | null {
  const row = useDecisionRow(key);
  const steps = usePipelineSteps();
  return useMemo(() => (row ? buildTrace(row, steps) : null), [row, steps]);
}

function readReplayParam(): string | null {
  const query = window.location.hash.split('?')[1];
  return query ? new URLSearchParams(query).get('replay') : null;
}

function writeReplayParam(key: string | null) {
  const [path, query] = window.location.hash.split('?');
  const params = new URLSearchParams(query ?? '');
  if (key) params.set('replay', key);
  else params.delete('replay');
  const next = params.toString();
  window.location.hash = `${path.replace(/^#/, '')}${next ? `?${next}` : ''}`;
}

/** The decision whose replay is open, kept in the hash as `?replay=<key>`. */
export function useReplayParam(): [string | null, (key: string | null) => void] {
  const [key, setKey] = useState<string | null>(readReplayParam);
  useEffect(() => {
    const onHashChange = () => setKey(readReplayParam());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const set = useCallback((next: string | null) => {
    writeReplayParam(next);
    setKey(next);
  }, []);
  return [key, set];
}

export function openReplay(key: string) {
  writeReplayParam(key);
}
