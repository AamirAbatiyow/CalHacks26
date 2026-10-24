import { useMemo, useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  Activity, Copy, FileWarning, FileX2, Hourglass, Play, RotateCcw, Shuffle, SunMedium, Syringe, TrendingUp, Undo2, UserCog, WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useTable } from '../../hooks/useTable';
import { INJECTION_RUN_TIMEOUT_S, useWorkerStatus } from '../../hooks/useDecisions';
import { useTechMode } from '../../hooks/useTechMode';
import { useBreakItDB } from './useBreakItDB';
import {
  AttackType,
  AttackResult,
  ATTACK_TYPE_LABELS,
  ATTACK_TYPES_ORDER,
} from './types';
import type { AttackRun } from './types';
import { Chip } from '../../ui/Chip';
import { Drawer } from '../../ui/Drawer';
import { C, SplitBar } from '../../ui/charts';
import { CountUp, compactUsd, wholeUsd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import './BreakIt.css';

function formatTime(timestamp: bigint, baseTimestamp: bigint): string {
  const diffMs = Number(timestamp - baseTimestamp) / 1000;
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

const ATTACK_ICONS: Record<AttackType, LucideIcon> = {
  InflatedClaim: TrendingUp,
  DuplicateClaim: Copy,
  ForgedStationLog: FileWarning,
  InsiderRaisesOwnLimit: UserCog,
  SpaceWeatherExcuse: SunMedium,
  ContractOutsideSla: FileX2,
  MessyData: Shuffle,
  ModelStress: Activity,
  Recovery: Undo2,
  PromptInjection: Syringe,
};

interface TypeTally {
  caught: number;
  total: number;
  caughtCents: number;
  missedCents: number;
  runs: AttackRun[];
}

interface RowStatus {
  text: string;
  tone: 'pending' | 'offline';
  hint?: string;
}

interface AttackTileProps {
  attackType: AttackType;
  result: TypeTally | null;
  onRun: () => void;
  onOpen: () => void;
  isRunning: boolean;
  blocked?: boolean;
  status?: RowStatus | null;
  index: number;
  tech: boolean;
}

function AttackTile({ attackType, result, onRun, onOpen, isRunning, blocked, status, index, tech }: AttackTileProps) {
  const Icon = ATTACK_ICONS[attackType];
  const missed = result ? result.total - result.caught : 0;
  const tone = status ? 'status' : !result ? 'idle' : missed > 0 ? 'missed' : 'caught';
  const StatusIcon = status?.tone === 'pending' ? Hourglass : WifiOff;
  const statusText = status && !tech ? (status.tone === 'pending' ? 'Running' : 'Unavailable') : status?.text;
  const hint = tech ? status?.hint : undefined;

  return (
    <motion.div
      className={`breakit-tile ${tone}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.03 }}
      whileHover={{ y: -2 }}
      onClick={result ? onOpen : undefined}
      role={result ? 'button' : undefined}
      tabIndex={result ? 0 : undefined}
      onKeyDown={e => { if (result && (e.key === 'Enter' || e.key === ' ')) onOpen(); }}
      aria-label={`${ATTACK_TYPE_LABELS[attackType]}${result ? `: ${result.caught} of ${result.total} caught` : ''}`}
    >
      <div className="breakit-tile-head">
        <Icon size={14} className="breakit-tile-icon" aria-hidden />
        <span className="breakit-tile-name">{ATTACK_TYPE_LABELS[attackType]}</span>
        <button
          className="breakit-run-btn"
          onClick={e => { e.stopPropagation(); onRun(); }}
          disabled={isRunning || blocked}
          title={blocked ? (hint ?? 'Unavailable right now') : `Run ${ATTACK_TYPE_LABELS[attackType]}`}
          aria-label={`Run ${ATTACK_TYPE_LABELS[attackType]}`}
        >
          <Play size={11} />
        </button>
      </div>

      {status ? (
        <div className="breakit-tile-status">
          <Chip tone={status.tone === 'pending' ? 'accent' : 'warn'} icon={StatusIcon} title={hint}>{statusText}</Chip>
        </div>
      ) : result ? (
        <>
          <div className="breakit-tile-score">
            <span className="breakit-tile-caught">{result.caught}</span>
            <span className="breakit-tile-total">/ {result.total}</span>
          </div>
          {tech && (
            <div className="breakit-dots" aria-hidden>
              {result.runs.map(r => (
                <span key={String(r.id)} className={`breakit-dot ${r.result === AttackResult.Caught ? 'caught' : 'missed'}`} />
              ))}
            </div>
          )}
          <div className="breakit-tile-dollars">
            {result.missedCents > 0
              ? <span className="missed">{compactUsd(result.missedCents)} paid out</span>
              : <span>{compactUsd(result.caughtCents)} protected</span>}
          </div>
        </>
      ) : (
        <div className="breakit-tile-idle">Not run</div>
      )}
      {hint && <div className="breakit-tile-hint">{hint}</div>}
    </motion.div>
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
  const [openType, setOpenType] = useState<AttackType | null>(null);
  const tech = useTechMode();

  useEffect(() => {
    if (connected && fixtures.length === 0) {
      seedFixtures();
    }
  }, [connected, fixtures.length, seedFixtures]);

  const latestSession = useMemo(() => {
    if (sessions.length === 0) return null;
    return sessions.reduce((latest, s) => (s.id > latest.id ? s : latest));
  }, [sessions]);

  const sessionRuns = useMemo(() => {
    if (!latestSession) return [];
    return attackRuns
      .filter(r => r.runId === latestSession.id)
      .sort((a, b) => Number(a.timestamp - b.timestamp) || Number(a.id - b.id));
  }, [attackRuns, latestSession]);

  const attackTypeResults = useMemo(() => {
    const results = {} as Record<AttackType, TypeTally | null>;
    for (const t of ATTACK_TYPES_ORDER) {
      results[t] = null;
    }
    for (const run of sessionRuns) {
      if (run.result === AttackResult.Pending) continue;
      const tally = results[run.attackType] ?? { caught: 0, total: 0, caughtCents: 0, missedCents: 0, runs: [] };
      tally.total += 1;
      tally.runs.push(run);
      if (run.result === AttackResult.Caught) {
        tally.caught += 1;
        tally.caughtCents += Number(run.amountCents);
      } else {
        tally.missedCents += Number(run.amountCents);
      }
      results[run.attackType] = tally;
    }
    return results;
  }, [sessionRuns]);

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

  const protectedCents = Number(latestSession?.dollarsProtectedCents ?? 0n);
  const badCents = Number(latestSession?.badPayoutsCents ?? 0n);
  const loading = !connected && sessions.length === 0;
  const scored = sessionRuns.filter(r => r.result !== AttackResult.Pending);
  const openTally = openType ? attackTypeResults[openType] : null;

  return (
    <div className="breakit-page">
      <div className="breakit-content">
        <div className="ui-tiles breakit-tiles">
          <div className="ui-tile">
            <span className="ui-stat-label">Caught</span>
            <span className="ui-stat-value">
              {loading ? <Skeleton width={60} height={20} /> : <><CountUp value={latestSession?.caught ?? 0} format={n => String(Math.round(n))} /><span className="breakit-of"> / {latestSession?.totalAttacks ?? 0}</span></>}
            </span>
          </div>
          <div className="ui-tile">
            <span className="ui-stat-label">Dollars protected</span>
            <span className="ui-stat-value">{loading ? <Skeleton width={80} height={20} /> : <CountUp value={protectedCents} format={compactUsd} />}</span>
          </div>
          <div className="ui-tile">
            <span className="ui-stat-label">Bad payouts</span>
            <span className={`ui-stat-value ${badCents > 0 ? 'tone-warn' : ''}`}>{loading ? <Skeleton width={80} height={20} /> : <CountUp value={badCents} format={compactUsd} />}</span>
          </div>
          {tech && <div className="ui-tile breakit-tile-split">
            <span className="ui-stat-label">Attack dollars</span>
            <SplitBar
              label={`${compactUsd(protectedCents)} protected, ${compactUsd(badCents)} paid out`}
              parts={[
                { label: `Protected ${compactUsd(protectedCents)}`, value: protectedCents, color: C.green },
                { label: `Paid out ${compactUsd(badCents)}`, value: badCents, color: C.red, pattern: true },
              ]}
            />
            <span className="ui-legend">
              <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: C.green }} />Protected</span>
              <span className="ui-legend-item"><span className="ui-legend-swatch hatched" style={{ color: C.red }} />Paid out</span>
            </span>
          </div>}
        </div>

        <div className="breakit-section-head">
          <span className="ui-section-title">Attacks</span>
          <div className="breakit-actions">
            <button className="breakit-run-all-btn" onClick={runAllAttacks} disabled={isRunning || !connected}>
              <Play size={12} /> Run all {fixtures.length}
            </button>
            <button className="breakit-clear-btn" onClick={clearRuns} disabled={isRunning}>
              <RotateCcw size={12} /> Clear
            </button>
          </div>
        </div>

        <div className="breakit-grid">
          {ATTACK_TYPES_ORDER.map((attackType, i) => (
            <AttackTile
              key={attackType}
              index={i}
              attackType={attackType}
              result={attackTypeResults[attackType]}
              onRun={() => runRow(attackType)}
              onOpen={() => setOpenType(attackType)}
              isRunning={isRunning}
              blocked={attackType === 'PromptInjection' && !workerOnline}
              status={attackType === 'PromptInjection' ? injectionStatus : null}
              tech={tech}
            />
          ))}
        </div>

        {tech && <>
        <div className="breakit-section-head">
          <span className="ui-section-title">Run timeline</span>
          {scored.length > 0 && <span className="ui-legend">
            <span className="ui-legend-item"><span className="breakit-dot caught" />Caught</span>
            <span className="ui-legend-item"><span className="breakit-dot missed" />Missed</span>
          </span>}
        </div>
        {scored.length === 0 ? (
          <EmptyState art="shield" compact title="No attacks run yet" hint="Run all to throw every fixture at the pipeline." />
        ) : (
          <div className="breakit-timeline" role="img" aria-label={`${scored.length} attacks in run order`}>
            {scored.map(r => (
              <motion.span
                key={String(r.id)}
                className={`breakit-tick ${r.result === AttackResult.Caught ? 'caught' : 'missed'}`}
                title={`${formatTime(r.timestamp, baseTimestamp)} ${ATTACK_TYPE_LABELS[r.attackType]} · ${wholeUsd(Number(r.amountCents))} · ${r.result === AttackResult.Caught ? 'caught' : 'missed'}`}
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: 0.2 }}
                onClick={() => setOpenType(r.attackType)}
              />
            ))}
          </div>
        )}
        </>}
        {!tech && scored.length === 0 && (
          <EmptyState art="shield" compact title="No attacks run yet" hint="Run all to throw every fixture at the pipeline." />
        )}
      </div>

      <Drawer
        open={openTally !== null}
        onClose={() => setOpenType(null)}
        eyebrow="Attack log"
        title={openType ? ATTACK_TYPE_LABELS[openType] : ''}
      >
        {openTally && (
          <>
            <div className="ui-chips">
              <Chip tone="pass">{openTally.caught} caught</Chip>
              {openTally.total - openTally.caught > 0 && <Chip tone="block">{openTally.total - openTally.caught} missed</Chip>}
            </div>
            <div className="breakit-log">
              {openTally.runs.map(r => (
                <div key={String(r.id)} className="breakit-log-entry" title={r.logMessage}>
                  <span className="breakit-log-time">{formatTime(r.timestamp, baseTimestamp)}</span>
                  <span className={`breakit-dot ${r.result === AttackResult.Caught ? 'caught' : 'missed'}`} aria-label={r.result} />
                  <span className="breakit-log-amount">{wholeUsd(Number(r.amountCents))}</span>
                  <span className={`breakit-log-message ${r.result === AttackResult.Missed ? 'missed' : ''}`}>
                    {r.logMessage.replace(/: (MISSED|caught) - /, ': ').replace(/^[^:]+: /, '')}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Drawer>
    </div>
  );
}
