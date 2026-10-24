import { useCallback, useMemo } from 'react';
import { useTable, useConnected, reducers, micros, tag } from '../../hooks/useTable';
import type { AttackRun, AttackRunSession, AttackFixture, AttackType } from './types';
import { AttackResult, ATTACK_TYPE_CODES } from './types';

function mapAttackResult(result: unknown): AttackResult {
  switch (tag(result)) {
    case 'Caught': return AttackResult.Caught;
    case 'Missed': return AttackResult.Missed;
    default: return AttackResult.Pending;
  }
}

function mapAttackType(type: unknown): AttackType {
  return tag(type) as AttackType;
}

export function useBreakItDB() {
  const connected = useConnected();
  const runRows = useTable('attackRun');
  const sessionRows = useTable('attackRunSession');
  const fixtureRows = useTable('attackFixture');
  const kpiRows = useTable('kpi');

  const attackRuns = useMemo<AttackRun[]>(() => runRows.map(row => ({
    id: row.id,
    runId: row.runId,
    attackType: mapAttackType(row.attackType),
    result: mapAttackResult(row.result),
    amountCents: row.amountCents,
    timestamp: micros(row.timestamp),
    logMessage: row.logMessage,
    attackerIdentity: row.attackerIdentity ?? null,
  })), [runRows]);

  const sessions = useMemo<AttackRunSession[]>(() => sessionRows.map(row => ({
    id: row.id,
    startedAt: micros(row.startedAt),
    completedAt: row.completedAt ? micros(row.completedAt) : null,
    totalAttacks: row.totalAttacks,
    caught: row.caught,
    missed: row.missed,
    dollarsProtectedCents: row.dollarsProtectedCents,
    badPayoutsCents: row.badPayoutsCents,
  })), [sessionRows]);

  const fixtures = useMemo<AttackFixture[]>(() => fixtureRows.map(row => ({
    id: row.id,
    attackType: mapAttackType(row.attackType),
    amountCents: row.amountCents,
    description: row.description,
    attackParams: row.attackParams,
  })), [fixtureRows]);

  const seedFixtures = useCallback(() => {
    reducers()?.seedAttackFixtures({});
  }, []);

  const runAttackType = useCallback(async (attackType: AttackType) => {
    // Injection attacks are filed as real claims and scored as the decision worker decides them.
    // The module refuses to file them while the worker is offline; the rejection carries the reason.
    if (attackType === 'PromptInjection') {
      await reducers()?.runInjectionAttacks({});
      return;
    }
    await reducers()?.runAttackType({ attackTypeCode: ATTACK_TYPE_CODES[attackType] });
  }, []);

  const runAllAttacks = useCallback(() => {
    reducers()?.runAllAttacks({});
  }, []);

  const clearRuns = useCallback(() => {
    reducers()?.clearAttackRuns({});
  }, []);

  return {
    connected,
    attackRuns,
    sessions,
    fixtures,
    kpi: kpiRows[0] ?? null,
    seedFixtures,
    runAttackType,
    runAllAttacks,
    clearRuns,
  };
}
