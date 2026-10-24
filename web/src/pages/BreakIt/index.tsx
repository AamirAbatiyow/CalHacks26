import { useMemo, useEffect, useState, useCallback } from 'react';
import { useTable } from '../../hooks/useTable';
import { INJECTION_RUN_TIMEOUT_S, useWorkerStatus } from '../../hooks/useDecisions';
import { useBreakItDB } from './useBreakItDB';
import {
  AttackType,
  AttackResult,
  ATTACK_TYPE_LABELS,
  ATTACK_TYPES_ORDER,
} from './types';
import './BreakIt.css';

function formatDollars(cents: bigint): string {
  const dollars = Number(cents) / 100;
  if (dollars >= 1000000) {
    return `$${(dollars / 1000000).toFixed(1)}M`;
  }
  if (dollars >= 1000) {
    return `$${Math.round(dollars / 1000)}K`;
  }
  return `$${Math.round(dollars)}`;
}

function formatTime(timestamp: bigint, baseTimestamp: bigint): string {
  const diffMs = Number(timestamp - baseTimestamp) / 1000;
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

interface StatBoxProps {
  label: string;
  value: string;
  subValue?: string;
}

function StatBox({ label, value, subValue }: StatBoxProps) {
  return (
    <div className="breakit-stat">
      <span className="breakit-stat-label">{label}</span>
      <span className="breakit-stat-value">
        {value}
        {subValue && <span className="breakit-stat-sub">{subValue}</span>}
      </span>
    </div>
  );
}

interface TypeTally {
  caught: number;
  total: number;
}

interface RowStatus {
  text: string;
  tone: 'pending' | 'offline';
  hint?: string;
}

interface AttackRowProps {
  attackType: AttackType;
  result: TypeTally | null;
  onRun: () => void;
  isRunning: boolean;
  blocked?: boolean;
  status?: RowStatus | null;
}

function AttackRow({ attackType, result, onRun, isRunning, blocked, status }: AttackRowProps) {
  const missed = result ? result.total - result.caught : 0;
  const resultClass = status ? status.tone : !result ? '' : missed > 0 ? 'missed' : 'caught';
  const resultText = status ? status.text : result ? `${result.caught}/${result.total} caught` : '';

  return (
    <>
      <div className="breakit-attack-row">
        <span className="breakit-attack-name">{ATTACK_TYPE_LABELS[attackType]}</span>
        <button
          className="breakit-run-btn"
          onClick={onRun}
          disabled={isRunning || blocked}
          title={blocked ? status?.hint : undefined}
        >
          Run
        </button>
        <span className={`breakit-attack-result ${resultClass}`}>
          {resultText}
        </span>
      </div>
      {status?.hint && <div className={`breakit-attack-hint ${status.tone}`}>{status.hint}</div>}
    </>
  );
}

interface LogEntry {
  timestamp: bigint;
  message: string;
  isMissed: boolean;
}

interface LogPanelProps {
  entries: LogEntry[];
  baseTimestamp: bigint;
}

function LogPanel({ entries, baseTimestamp }: LogPanelProps) {
  return (
    <div className="breakit-log">
      {entries.map((entry, idx) => (
        <div key={idx} className="breakit-log-entry">
          <span className="breakit-log-time">{formatTime(entry.timestamp, baseTimestamp)}</span>
          <span className={`breakit-log-message ${entry.isMissed ? 'missed' : ''}`}>
            {entry.message}
            {entry.isMissed && <span className="breakit-log-missed"> MISSED</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function BreakIt() {
  const {
    connected,
    attackRuns,
    sessions,
    fixtures,
    seedFixtures,
    runAttackType,
    runAllAttacks,
    clearRuns,
  } = useBreakItDB();
  const cases = useTable('decisionCase');
  const { online: workerOnline, silenceS: workerSilenceS, now } = useWorkerStatus();
  const [injectionError, setInjectionError] = useState<string | null>(null);

  useEffect(() => {
    if (connected && fixtures.length === 0) {
      seedFixtures();
    }
  }, [connected, fixtures.length, seedFixtures]);

  const latestSession = useMemo(() => {
    if (sessions.length === 0) return null;
    return sessions.reduce((latest, s) => (s.id > latest.id ? s : latest));
  }, [sessions]);

  const attackTypeResults = useMemo(() => {
    const results = {} as Record<AttackType, TypeTally | null>;
    for (const t of ATTACK_TYPES_ORDER) {
      results[t] = null;
    }
    if (!latestSession) return results;

    for (const run of attackRuns) {
      if (run.runId !== latestSession.id || run.result === AttackResult.Pending) continue;
      const tally = results[run.attackType] ?? { caught: 0, total: 0 };
      tally.total += 1;
      if (run.result === AttackResult.Caught) tally.caught += 1;
      results[run.attackType] = tally;
    }
    return results;
  }, [attackRuns, latestSession]);

  const logEntries = useMemo((): LogEntry[] => {
    if (!latestSession) return [];

    return attackRuns
      .filter(r => r.runId === latestSession.id)
      .sort((a, b) => Number(a.timestamp - b.timestamp) || Number(a.id - b.id))
      .map(r => ({
        timestamp: r.timestamp,
        message: r.logMessage.replace(/: (MISSED|caught) - /, ': '),
        isMissed: r.result === AttackResult.Missed,
      }));
  }, [attackRuns, latestSession]);

  const baseTimestamp = latestSession?.startedAt ?? BigInt(0);

  const injection = useMemo(() => {
    if (!latestSession) return null;
    const own = cases.filter(c => c.attackSessionId === latestSession.id);
    if (own.length === 0) return null;
    return { total: own.length, decided: own.filter(c => c.decidedAt !== undefined).length };
  }, [cases, latestSession]);

  const elapsedS = latestSession ? Math.max(0, (now * 1000 - Number(latestSession.startedAt)) / 1e6) : 0;
  // A run the module never closed (e.g. recorded before the scheduled timeout existed) stops counting as running.
  const staleInjectionRun = injection !== null && elapsedS > INJECTION_RUN_TIMEOUT_S + 10;
  const isRunning = latestSession !== null && latestSession.completedAt === null && !staleInjectionRun;
  const injectionRunning = isRunning && injection !== null;

  const injectionStatus = useMemo((): RowStatus | null => {
    const start = 'Start the decision worker: cd worker && npm start';
    if (injectionRunning) {
      const left = Math.max(0, Math.ceil(INJECTION_RUN_TIMEOUT_S - elapsedS));
      return workerOnline
        ? { text: `Deciding ${injection!.decided}/${injection!.total}`, tone: 'pending', hint: `The decision worker is deciding each attack as a real claim. Times out in ${left}s.` }
        : { text: 'Worker offline', tone: 'offline', hint: `${injection!.decided} of ${injection!.total} decided; the run times out in ${left}s. ${start}` };
    }
    if (!workerOnline) {
      const seen = workerSilenceS === null ? 'has never connected' : `sent its last heartbeat ${workerSilenceS}s ago`;
      return { text: 'Worker offline', tone: 'offline', hint: `The decision worker decides these claims and ${seen}. ${start}` };
    }
    if (injectionError) return { text: 'Run failed', tone: 'offline', hint: injectionError };
    if (latestSession && injection && latestSession.caught + latestSession.missed < injection.total) {
      const decided = latestSession.caught + latestSession.missed;
      return {
        text: 'Timed out',
        tone: 'offline',
        hint: `${latestSession.caught} of ${decided} decided attacks caught; ${injection.total - decided} were never decided, went to Approvals and are not scored.`,
      };
    }
    return null;
  }, [injectionRunning, injection, elapsedS, workerOnline, workerSilenceS, injectionError, latestSession]);

  const runRow = useCallback((attackType: AttackType) => {
    if (attackType !== 'PromptInjection') {
      runAttackType(attackType).catch(() => {});
      return;
    }
    setInjectionError(null);
    runAttackType(attackType).catch((e: unknown) => setInjectionError(e instanceof Error ? e.message : String(e)));
  }, [runAttackType]);

  return (
    <div className="breakit-page">
      <div className="breakit-content">
        <div className="breakit-main">
          <div className="breakit-stats-row">
            <StatBox 
              label="Caught" 
              value={`${latestSession?.caught ?? 0}`}
              subValue={` / ${latestSession?.totalAttacks ?? 0}`}
            />
            <StatBox 
              label="Dollars protected" 
              value={formatDollars(latestSession?.dollarsProtectedCents ?? 0n)} 
            />
            <StatBox 
              label="Bad payouts" 
              value={formatDollars(latestSession?.badPayoutsCents ?? 0n)} 
            />
          </div>

          <div className="breakit-attacks">
            {ATTACK_TYPES_ORDER.map(attackType => (
              <AttackRow
                key={attackType}
                attackType={attackType}
                result={attackTypeResults[attackType]}
                onRun={() => runRow(attackType)}
                isRunning={isRunning}
                blocked={attackType === 'PromptInjection' && !workerOnline}
                status={attackType === 'PromptInjection' ? injectionStatus : null}
              />
            ))}
          </div>

          <div className="breakit-actions">
            <button 
              className="breakit-run-all-btn"
              onClick={runAllAttacks}
              disabled={isRunning || !connected}
            >
              Run all {fixtures.length}
            </button>
            <button
              className="breakit-clear-btn"
              onClick={clearRuns}
              disabled={isRunning}
            >
              Clear
            </button>
          </div>
        </div>

        <LogPanel entries={logEntries} baseTimestamp={baseTimestamp} />
      </div>
    </div>
  );
}
