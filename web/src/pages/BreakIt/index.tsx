import { useMemo, useEffect } from 'react';
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

interface AttackRowProps {
  attackType: AttackType;
  result: AttackResult | null;
  onRun: () => void;
  isRunning: boolean;
}

function AttackRow({ attackType, result, onRun, isRunning }: AttackRowProps) {
  const resultClass = result === AttackResult.Missed ? 'missed' : result === AttackResult.Caught ? 'caught' : '';
  const resultText = result === AttackResult.Missed ? 'Missed' : result === AttackResult.Caught ? 'Caught' : '';

  return (
    <div className="breakit-attack-row">
      <span className="breakit-attack-name">{ATTACK_TYPE_LABELS[attackType]}</span>
      <button 
        className="breakit-run-btn" 
        onClick={onRun}
        disabled={isRunning}
      >
        Run
      </button>
      <span className={`breakit-attack-result ${resultClass}`}>
        {resultText}
      </span>
    </div>
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

  useEffect(() => {
    if (connected && fixtures.length === 0) {
      seedFixtures();
    }
  }, [connected, fixtures.length, seedFixtures]);

  const latestSession = useMemo(() => {
    if (sessions.length === 0) return null;
    return sessions.reduce((latest, s) => 
      s.startedAt > latest.startedAt ? s : latest
    );
  }, [sessions]);

  const aggregateStats = useMemo(() => {
    const completedSessions = sessions.filter(s => s.completedAt !== null);
    if (completedSessions.length === 0) {
      return { caught: 0, total: 0, dollarsProtected: BigInt(0), badPayouts: BigInt(0) };
    }
    
    return completedSessions.reduce(
      (acc, s) => ({
        caught: acc.caught + s.caught,
        total: acc.total + s.totalAttacks,
        dollarsProtected: acc.dollarsProtected + s.dollarsProtectedCents,
        badPayouts: acc.badPayouts + s.badPayoutsCents,
      }),
      { caught: 0, total: 0, dollarsProtected: BigInt(0), badPayouts: BigInt(0) }
    );
  }, [sessions]);

  const attackTypeResults = useMemo(() => {
    const results: Record<AttackType, AttackResult | null> = {} as Record<AttackType, AttackResult | null>;
    for (const t of ATTACK_TYPES_ORDER) {
      results[t] = null;
    }

    if (!latestSession) return results;

    const sessionRuns = attackRuns
      .filter(r => r.runId === latestSession.id && r.result !== AttackResult.Pending)
      .sort((a, b) => Number(a.timestamp - b.timestamp) || Number(a.id - b.id));

    for (const run of sessionRuns) {
      if (run.result === AttackResult.Missed) {
        results[run.attackType] = AttackResult.Missed;
      } else if (run.result === AttackResult.Caught && results[run.attackType] !== AttackResult.Missed) {
        results[run.attackType] = AttackResult.Caught;
      }
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
        message: r.result === AttackResult.Missed 
          ? r.logMessage.replace(' MISSED', '') 
          : r.logMessage,
        isMissed: r.result === AttackResult.Missed,
      }));
  }, [attackRuns, latestSession]);

  const baseTimestamp = latestSession?.startedAt ?? BigInt(0);

  const isRunning = latestSession !== null && latestSession.completedAt === null;

  const handleRunAll = () => {
    clearRuns();
    setTimeout(() => runAllAttacks(), 100);
  };

  return (
    <div className="breakit-page">
      <div className="breakit-content">
        <div className="breakit-main">
          <div className="breakit-stats-row">
            <StatBox 
              label="Caught" 
              value={`${aggregateStats.caught}`}
              subValue={` / ${aggregateStats.total}`}
            />
            <StatBox 
              label="Dollars protected" 
              value={formatDollars(aggregateStats.dollarsProtected)} 
            />
            <StatBox 
              label="Bad payouts" 
              value={formatDollars(aggregateStats.badPayouts)} 
            />
          </div>

          <div className="breakit-attacks">
            {ATTACK_TYPES_ORDER.map(attackType => (
              <AttackRow
                key={attackType}
                attackType={attackType}
                result={attackTypeResults[attackType]}
                onRun={() => runAttackType(attackType)}
                isRunning={isRunning}
              />
            ))}
          </div>

          <div className="breakit-actions">
            <button 
              className="breakit-run-all-btn"
              onClick={handleRunAll}
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
