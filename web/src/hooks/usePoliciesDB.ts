import { useCallback, useMemo } from 'react';
import type { PolicyVersion, CedarRule, PolicyReplay } from '../types';
import { PolicyStatus, ReplayStatus } from '../types';
import { useTable, useConnected, reducers, micros, tag } from './useTable';

function mapPolicyStatus(status: unknown): PolicyStatus {
  switch (tag(status)) {
    case 'Current': return PolicyStatus.Current;
    case 'Retired': return PolicyStatus.Retired;
    default: return PolicyStatus.Proposed;
  }
}

function mapReplayStatus(status: unknown): ReplayStatus {
  switch (tag(status)) {
    case 'Running': return ReplayStatus.Running;
    case 'Completed': return ReplayStatus.Completed;
    case 'Blocked': return ReplayStatus.Blocked;
    default: return ReplayStatus.Pending;
  }
}

export function usePoliciesDB() {
  const connected = useConnected();
  const versionRows = useTable('policyVersion');
  const ruleRows = useTable('cedarRule');
  const replayRows = useTable('policyReplay');

  const policyVersions = useMemo<PolicyVersion[]>(() => versionRows
    .map(row => ({
      id: row.id,
      version: row.version,
      status: mapPolicyStatus(row.status),
      author: row.author,
      createdAt: micros(row.createdAt),
      decisionCount: row.decisionCount,
    }))
    .sort((a, b) => b.version - a.version), [versionRows]);

  const cedarRules = useMemo<CedarRule[]>(() => ruleRows
    .map(row => ({
      id: row.id,
      policyVersionId: row.policyVersionId,
      name: row.name,
      description: row.description,
      cedarCode: row.cedarCode,
      enabled: row.enabled,
      orderIndex: row.orderIndex,
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex), [ruleRows]);

  const replays = useMemo<PolicyReplay[]>(() => replayRows.map(row => ({
    id: row.id,
    proposedVersionId: row.proposedVersionId,
    currentVersionId: row.currentVersionId,
    status: mapReplayStatus(row.status),
    totalClaims: row.totalClaims,
    currentClaim: row.currentClaim,
    precisionBefore: row.precisionBefore,
    precisionAfter: row.precisionAfter,
    decisionsChanged: row.decisionsChanged,
    dollarImpactCents: row.dollarImpactCents,
    blockReason: row.blockReason,
    createdAt: micros(row.createdAt),
    isPlaying: row.isPlaying,
    speedMultiplier: row.speedMultiplier,
  })), [replayRows]);

  const startReplay = useCallback((proposedVersionId: string, currentVersionId: string, totalClaims: number) => {
    reducers()?.startReplay({ proposedVersionId, currentVersionId, totalClaims });
  }, []);

  const advanceReplay = useCallback((replayId: bigint, claimsToAdvance: number) => {
    reducers()?.advanceReplay({ replayId, claimsToAdvance });
  }, []);

  const seekReplay = useCallback((replayId: bigint, claim: number) => {
    reducers()?.seekReplay({ replayId, claim });
  }, []);

  const setReplayPlaying = useCallback((replayId: bigint, playing: boolean) => {
    reducers()?.setReplayPlaying({ replayId, playing });
  }, []);

  const setReplaySpeed = useCallback((replayId: bigint, speed: number) => {
    reducers()?.setReplaySpeed({ replayId, speed });
  }, []);

  const toggleRule = useCallback((ruleId: string) => {
    reducers()?.toggleRule({ ruleId });
  }, []);

  const createPolicyVersion = useCallback((newId: string, newVersion: number, author: string, sourceVersionId: string) => {
    reducers()?.createPolicyVersion({ newId, newVersion, author, sourceVersionId });
  }, []);

  const promotePolicyVersion = useCallback((versionId: string) => {
    reducers()?.promotePolicyVersion({ versionId });
  }, []);

  return {
    connected,
    policyVersions,
    cedarRules,
    replays,
    startReplay,
    advanceReplay,
    seekReplay,
    setReplayPlaying,
    setReplaySpeed,
    toggleRule,
    createPolicyVersion,
    promotePolicyVersion,
  };
}
