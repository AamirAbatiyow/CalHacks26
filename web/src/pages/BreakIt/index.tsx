import { useMemo, useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  Activity, ChevronLeft, Copy, FileWarning, FileX2, Hourglass, Play, RotateCcw, Shuffle, SunMedium, Syringe, TrendingUp, Undo2, UserCog, WifiOff,
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
import { AttackDetail, InjectionDetail } from './AttackDetail';
import { attackTitle, attackTypeOf, outcomeTone, usd, useAttackEvals, type AttackEvalRow } from './useAttackEvals';
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
  held: number;
  total: number;
  caughtCents: number;
  missedCents: number;
  runs: AttackRun[];
  evals: AttackEvalRow[];
}

type Open = { kind: 'type'; type: AttackType } | { kind: 'eval'; id: bigint; from?: AttackType } | { kind: 'run'; id: bigint; from?: AttackType };

const emptyTally = (): TypeTally => ({ caught: 0, held: 0, total: 0, caughtCents: 0, missedCents: 0, runs: [], evals: [] });

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
  const missed = result ? result.total - result.caught - result.held : 0;
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
          {result.held > 0 && <div className="breakit-tile-held">{result.held} held for review</div>}
          {tech && (
            <div className="breakit-dots" aria-hidden>
              {result.evals.length > 0
                ? result.evals.map(r => <span key={String(r.id)} className={`breakit-dot ${r.outcome}`} />)
                : result.runs.map(r => (
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
  const [open, setOpen] = useState<Open | null>(null);
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

  const evals = useAttackEvals(latestSession?.id ?? null);

  const attackTypeResults = useMemo(() => {
    const results = {} as Record<AttackType, TypeTally | null>;
    for (const t of ATTACK_TYPES_ORDER) {
      results[t] = null;
    }
    for (const row of evals.after) {
      const t = attackTypeOf(row);
      const tally = results[t] ?? emptyTally();
      tally.total += 1;
      tally.evals.push(row);
      if (row.outcome === 'caught') tally.caught += 1;
      else if (row.outcome === 'escalated') tally.held += 1;
      tally.caughtCents += Number(row.protectedCents);
      tally.missedCents += Number(row.badCents);
      results[t] = tally;
    }
    for (const run of sessionRuns) {
      if (run.result === AttackResult.Pending || results[run.attackType]?.evals.length) continue;
      const tally = results[run.attackType] ?? emptyTally();
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
  }, [sessionRuns, evals.after]);

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
  const evalByRun = useMemo(() => new Map(evals.after.filter(r => r.attackRunId !== undefined).map(r => [r.attackRunId!, r])), [evals.after]);
  const scored = sessionRuns.filter(r => r.result !== AttackResult.Pending || evalByRun.has(r.id));
  const tickClass = (r: AttackRun) => evalByRun.get(r.id)?.outcome ?? (r.result === AttackResult.Caught ? 'caught' : 'missed');
  const openRun = (r: AttackRun) => {
    const row = evalByRun.get(r.id);
    setOpen(row ? { kind: 'eval', id: row.id } : { kind: 'run', id: r.id });
  };
  const openType = open?.kind === 'type' ? open.type : null;
  const openTally = openType ? attackTypeResults[openType] : null;
  const openEval = open?.kind === 'eval' ? evals.after.find(r => r.id === open.id) ?? null : null;
  const openRunRow = open?.kind === 'run' ? sessionRuns.find(r => r.id === open.id) ?? null : null;
  const back = open && open.kind !== 'type' && open.from ? () => setOpen({ kind: 'type', type: open.from! }) : null;

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
              onOpen={() => setOpen({ kind: 'type', type: attackType })}
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
            <span className="ui-legend-item"><span className="breakit-dot escalated" />Held for review</span>
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
                className={`breakit-tick ${tickClass(r)}`}
                title={`${formatTime(r.timestamp, baseTimestamp)} ${ATTACK_TYPE_LABELS[r.attackType]} · ${wholeUsd(Number(r.amountCents))} · ${tickClass(r) === 'escalated' ? 'held for review' : tickClass(r)}`}
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: 0.2 }}
                onClick={() => openRun(r)}
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
        open={open !== null}
        onClose={() => setOpen(null)}
        eyebrow={openTally ? 'Attack log' : 'Attack'}
        title={openType ? ATTACK_TYPE_LABELS[openType] : openEval ? attackTitle(openEval) : openRunRow ? ATTACK_TYPE_LABELS[openRunRow.attackType] : ''}
      >
        {back && (
          <button className="breakit-back" onClick={back}><ChevronLeft size={12} /> {ATTACK_TYPE_LABELS[(open as { from: AttackType }).from]}</button>
        )}
        {openTally && openType && (
          <>
            <div className="ui-chips">
              <Chip tone="pass">{openTally.caught} caught</Chip>
              {openTally.held > 0 && <Chip tone="warn">{openTally.held} held for review</Chip>}
              {openTally.total - openTally.caught - openTally.held > 0 && <Chip tone="block">{openTally.total - openTally.caught - openTally.held} missed</Chip>}
            </div>
            <div className="breakit-log">
              {openTally.evals.length > 0
                ? openTally.evals.map(r => (
                  <button key={String(r.id)} className="breakit-log-entry clickable" onClick={() => setOpen({ kind: 'eval', id: r.id, from: openType })}>
                    <span className="breakit-log-time">{r.decidedBy === 'policy' ? `${r.confidence}%` : r.decidedBy === 'human' ? 'human' : 'screen'}</span>
                    <span className={`breakit-dot ${r.outcome}`} aria-label={r.outcome} />
                    <span className="breakit-log-amount">{usd(r.claimedCents)}</span>
                    <span className={`breakit-log-message ${r.outcome === 'missed' ? 'missed' : ''}`}>
                      <Chip tone={outcomeTone(r.outcome)}>{r.outcome === 'escalated' ? 'held' : r.outcome}</Chip> {r.description}
                    </span>
                  </button>
                ))
                : openTally.runs.map(r => (
                  <button key={String(r.id)} className="breakit-log-entry clickable" title={r.logMessage} onClick={() => setOpen({ kind: 'run', id: r.id, from: openType })}>
                    <span className="breakit-log-time">{formatTime(r.timestamp, baseTimestamp)}</span>
                    <span className={`breakit-dot ${r.result === AttackResult.Caught ? 'caught' : 'missed'}`} aria-label={r.result} />
                    <span className="breakit-log-amount">{wholeUsd(Number(r.amountCents))}</span>
                    <span className={`breakit-log-message ${r.result === AttackResult.Missed ? 'missed' : ''}`}>
                      {r.logMessage.replace(/: (MISSED|caught) - /, ': ').replace(/^[^:]+: /, '')}
                    </span>
                  </button>
                ))}
            </div>
          </>
        )}
        {openEval && <AttackDetail row={openEval} before={evals.beforeByFixture.get(openEval.fixtureId)} />}
        {openRunRow && (openRunRow.attackType === 'PromptInjection' ? <InjectionDetail run={openRunRow} /> : <p>{openRunRow.logMessage}</p>)}
      </Drawer>
    </div>
  );
}
