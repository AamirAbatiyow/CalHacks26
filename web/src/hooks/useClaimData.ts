import { useCallback, useMemo } from 'react';
import type {
  Claim,
  ClaimPass,
  ClaimEvidence,
  ClaimDecision,
  ClaimOutcome,
  ClaimWeather,
  ClaimReason,
} from '../types';
import { ClaimGate, DataIntegrityStatus } from '../types';
import { useTable, useConnected, reducers, micros, tag } from './useTable';

function mapClaimGate(gate: unknown): ClaimGate {
  switch (tag(gate)) {
    case 'Escalated': return ClaimGate.Escalated;
    default: return ClaimGate.Auto;
  }
}

function mapDataIntegrityStatus(status: unknown): DataIntegrityStatus {
  switch (tag(status)) {
    case 'Fail': return DataIntegrityStatus.Fail;
    case 'Pending': return DataIntegrityStatus.Pending;
    default: return DataIntegrityStatus.Pass;
  }
}

export interface ClaimData {
  claim: Claim | null;
  pass: ClaimPass | null;
  evidence: ClaimEvidence | null;
  decision: ClaimDecision | null;
  outcome: ClaimOutcome | null;
  weather: ClaimWeather | null;
  reasons: ClaimReason[];
  stationRevenueCents: bigint;
}

/** Live rows for one claim; with no id, the most recently created claim. */
export function useClaimData(requestedClaimId: string | null) {
  const connected = useConnected();
  const claims = useTable('claim');
  const passes = useTable('claimPass');
  const evidences = useTable('claimEvidence');
  const decisions = useTable('claimDecision');
  const outcomes = useTable('claimOutcome');
  const weathers = useTable('claimWeather');
  const reasonRows = useTable('claimReason');
  const stations = useTable('station');

  const claimId = useMemo(() => {
    if (requestedClaimId) return requestedClaimId;
    const latest = claims.reduce<(typeof claims)[number] | null>(
      (best, c) => (!best || micros(c.createdAt) > micros(best.createdAt) ? c : best),
      null,
    );
    return latest?.id ?? null;
  }, [claims, requestedClaimId]);

  const claim = useMemo<Claim | null>(() => {
    const row = claims.find(c => c.id === claimId);
    return row ? {
      id: row.id,
      customerName: row.customerName,
      amountClaimedCents: row.amountClaimedCents,
      passId: row.passId,
      createdAt: micros(row.createdAt),
    } : null;
  }, [claims, claimId]);

  const pass = useMemo<ClaimPass | null>(() => {
    const row = passes.find(p => p.claimId === claimId);
    return row ? {
      id: row.id,
      claimId: row.claimId,
      stationLat: row.stationLat,
      stationLon: row.stationLon,
      stationName: row.stationName,
      satelliteNoradId: row.satelliteNoradId,
      satelliteTle1: row.satelliteTle1,
      satelliteTle2: row.satelliteTle2,
      contactStartTime: micros(row.contactStartTime),
      signalLostTime: micros(row.signalLostTime),
      contactEndTime: micros(row.contactEndTime),
      maxElevationDeg: row.maxElevationDeg,
    } : null;
  }, [passes, claimId]);

  const evidence = useMemo<ClaimEvidence | null>(() => {
    const row = evidences.find(e => e.claimId === claimId);
    return row ? {
      claimId: row.claimId,
      dataIntegrityStatus: mapDataIntegrityStatus(row.dataIntegrityStatus),
      estimatedLossCents: row.estimatedLossCents,
      missingEvidenceCents: row.missingEvidenceCents,
    } : null;
  }, [evidences, claimId]);

  const decision = useMemo<ClaimDecision | null>(() => {
    const row = decisions.find(d => d.claimId === claimId);
    return row ? {
      claimId: row.claimId,
      creditAmountCents: row.creditAmountCents,
      confidencePercent: row.confidencePercent,
      gate: mapClaimGate(row.gate),
      rule: row.rule,
      policyVersion: row.policyVersion,
      modelVersion: row.modelVersion,
      decidedAt: micros(row.decidedAt),
    } : null;
  }, [decisions, claimId]);

  const outcome = useMemo<ClaimOutcome | null>(() => {
    const row = outcomes.find(o => o.claimId === claimId);
    return row ? {
      claimId: row.claimId,
      creditMemoSent: row.creditMemoSent,
      ledgerPosted: row.ledgerPosted,
      completedAt: row.completedAt ? micros(row.completedAt) : null,
    } : null;
  }, [outcomes, claimId]);

  const weather = useMemo<ClaimWeather | null>(() => {
    const row = weathers.find(w => w.claimId === claimId);
    return row ? { claimId: row.claimId, kpIndex: row.kpIndex, stormActive: row.stormActive } : null;
  }, [weathers, claimId]);

  const reasons = useMemo<ClaimReason[]>(() => reasonRows
    .filter(r => r.claimId === claimId)
    .map(r => ({ id: r.id, claimId: r.claimId, feature: r.feature, detail: r.detail, shapValue: r.shapValue }))
    .sort((a, b) => Math.abs(b.shapValue) - Math.abs(a.shapValue)), [reasonRows, claimId]);

  const stationRevenueCents = useMemo(
    () => stations.find(s => s.name === pass?.stationName)?.monthlyRevenueCents ?? 0n,
    [stations, pass],
  );

  const approveClaim = useCallback((id: string) => {
    reducers()?.approveClaimDecision({ claimId: id });
  }, []);

  const escalateClaim = useCallback((id: string, reason: string) => {
    reducers()?.escalateClaimDecision({ claimId: id, reason });
  }, []);

  const updateOutcome = useCallback((id: string, memoSent: boolean, posted: boolean) => {
    reducers()?.updateClaimOutcome({ claimId: id, creditMemoSent: memoSent, ledgerPosted: posted });
  }, []);

  return {
    connected,
    claimId,
    claim,
    pass,
    evidence,
    decision,
    outcome,
    weather,
    reasons,
    stationRevenueCents,
    approveClaim,
    escalateClaim,
    updateOutcome,
  };
}
