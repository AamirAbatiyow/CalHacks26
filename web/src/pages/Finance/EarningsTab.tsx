import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { DecisionRecord, LedgerEntry, Pass } from '../../types';
import { micros, tag, useTable } from '../../hooks/useTable';
import { useTechMode } from '../../hooks/useTechMode';
import { C, Sparkline } from '../../ui/charts';
import { CountUp, compactUsd, wholeUsd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { Skeleton } from '../../ui/Skeleton';
import {
  DEFAULT_GRAIN, GRAINS, change, combine, periodLabel, periodWindow, savingsFlows, shortPeriodLabel, toCsv, totals,
  type Change, type Flow, type Grain, type LineTotals,
} from './earnings';

interface EarningsTabProps {
  passes: Pass[];
  entries: LedgerEntry[];
  decisions: DecisionRecord[];
  /** The live `kpi` row's open exposure; null until it arrives. */
  atRiskNow: number | null;
  /** `sim_clock.current_time` in microseconds; wall clock when the clock row has not arrived. */
  simNow: bigint | null;
}

type LineId =
  | 'atRisk' | 'credits' | 'protected'
  | 'recoveries' | 'denied' | 'trimmed' | 'reviewSaved' | 'savings'
  | 'gross' | 'invoiced' | 'passes';

interface LineDef {
  id: LineId;
  label: string;
  /** Short label for the tiles. */
  short?: string;
  hint: string;
  count?: boolean;
  /** Shown in parentheses: a deduction on the statement. */
  deduction?: boolean;
  /** Whether an increase is good news, for the colour of the change. */
  upIsGood: boolean;
  total?: boolean;
  color: string;
}

const LINE: Record<LineId, LineDef> = {
  atRisk: {
    id: 'atRisk', label: 'Revenue at risk, settled', short: 'Revenue at risk · settled',
    hint: 'Dropped-pass and disputed dollars settled this period: credits paid plus revenue protected',
    upIsGood: false, color: C.amber,
  },
  credits: {
    id: 'credits', label: 'Less: credits paid', short: 'Credits paid',
    hint: 'SLA credits posted to the ledger: the contract entitlement, paid out',
    deduction: true, upIsGood: false, color: C.amber,
  },
  protected: {
    id: 'protected', label: 'Revenue protected', short: 'Revenue protected',
    hint: 'Credits avoided: at-risk dollars kept instead of paid out',
    total: true, upIsGood: true, color: C.green,
  },
  recoveries: {
    id: 'recoveries', label: 'Recovered by backup capture',
    hint: 'A backup station captured the dropped pass, so no credit was owed',
    upIsGood: true, color: C.green,
  },
  denied: {
    id: 'denied', label: 'Claims denied',
    hint: 'Claims the evidence did not support, each capped at the fee of its pass',
    upIsGood: true, color: C.green,
  },
  trimmed: {
    id: 'trimmed', label: 'Over-claims trimmed',
    hint: 'Claimed above the contract entitlement and not paid',
    upIsGood: true, color: C.green,
  },
  reviewSaved: {
    id: 'reviewSaved', label: 'Review cost saved',
    hint: '$285 per auto-approved decision: $300 human review vs $15 automated',
    upIsGood: true, color: C.green,
  },
  savings: {
    id: 'savings', label: 'Total savings', short: 'Savings',
    hint: 'Revenue protected plus review cost saved',
    total: true, upIsGood: true, color: C.green,
  },
  gross: {
    id: 'gross', label: 'Gross billed', hint: 'Pass revenue billed when the pass is flown, dropped passes included',
    upIsGood: true, color: C.accent,
  },
  invoiced: {
    id: 'invoiced', label: 'Invoices posted', hint: 'Invoices posted to the ledger; posted in batches, so timing differs from gross',
    upIsGood: true, color: C.secondary,
  },
  passes: { id: 'passes', label: 'Passes billed', hint: 'Flown passes, each billed by the minute', count: true, upIsGood: true, color: C.secondary },
};

const SECTIONS: { title: string; lines: LineDef[] }[] = [
  { title: 'Revenue at risk', lines: [LINE.atRisk, LINE.credits, LINE.protected] },
  { title: 'Savings', lines: [LINE.recoveries, LINE.denied, LINE.trimmed, LINE.reviewSaved, LINE.savings] },
  { title: 'Memo · billing', lines: [LINE.gross, LINE.invoiced, LINE.passes] },
];

const LINES = SECTIONS.flatMap(s => s.lines);

const MINUTE_MS = 60_000;

function amount(line: LineDef, v: number): string {
  if (line.count) return Math.round(v).toLocaleString('en-US');
  const s = wholeUsd(v);
  return line.deduction && v !== 0 ? `(${s})` : s;
}

function signedAmount(line: LineDef, v: number): string {
  if (Math.round(line.count ? v : v / 100) === 0) return line.count ? '0' : '$0';
  const sign = v > 0 ? '+' : '−';
  return line.count ? `${sign}${Math.abs(Math.round(v)).toLocaleString('en-US')}` : `${sign}${wholeUsd(v)}`;
}

function pctText(pct: number | null): string {
  if (pct === null) return '—';
  if (Math.abs(pct) < 0.05) return '0.0%';
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
}

function tone(line: LineDef, c: Change): string {
  if (c.abs === 0 || c.pct === null) return '';
  return (c.abs > 0) === line.upIsGood ? 'good' : 'bad';
}

function utcTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
}

function utcStamp(ms: number): string {
  return `${new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}, ${utcTime(ms)} UTC`;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const ms = (ts: unknown) => Number(micros(ts) / 1000n);

function useFlows(passes: Pass[], entries: LedgerEntry[], decisions: DecisionRecord[]) {
  const disputeRows = useTable('dispute');
  const escalationRows = useTable('escalatedClaim');
  return useMemo(() => {
    const billed: Flow[] = [];
    const passCount: Flow[] = [];
    const passRevenue = new Map<string, number>();
    for (const p of passes) {
      passRevenue.set(String(p.id), Number(p.revenueCents));
      if (p.status === 'Scheduled') continue;
      const at = Number(p.startTime / 1000n);
      billed.push({ at, value: Number(p.revenueCents) });
      passCount.push({ at, value: 1 });
    }
    const { denied, trimmed, reviewSaved } = savingsFlows({
      passRevenue,
      decisions: decisions.map(d => ({
        at: Number(d.createdAt / 1000n), outcome: d.outcome, passId: d.passId === null ? null : String(d.passId), amountCents: Number(d.amountCents),
      })),
      disputes: disputeRows.map(d => ({
        at: ms(d.resolvedAt ?? d.filedAt), status: tag(d.status), passId: String(d.passId), claimCents: Number(d.claimAmountCents),
      })),
      escalations: escalationRows.map(c => ({
        at: ms(c.createdAt), status: tag(c.status), claimedCents: Number(c.amountClaimedCents), proposedCents: Number(c.proposedAmountCents),
      })),
    });
    const credits: Flow[] = [];
    const recoveries: Flow[] = [];
    const invoiced: Flow[] = [];
    for (const e of entries) {
      const flow = { at: Number(e.createdAt / 1000n), value: Math.abs(Number(e.amountCents)) };
      if (e.entryType === 'Credit') credits.push(flow);
      else if (e.entryType === 'Recovery') recoveries.push(flow);
      else if (e.entryType === 'Invoice') invoiced.push(flow);
    }
    let latest = 0;
    for (const f of billed) latest = Math.max(latest, f.at);
    for (const list of [credits, recoveries, invoiced, denied, trimmed, reviewSaved]) for (const f of list) latest = Math.max(latest, f.at);
    return { billed, passCount, credits, recoveries, invoiced, denied, trimmed, reviewSaved, latest };
  }, [passes, entries, decisions, disputeRows, escalationRows]);
}

export function EarningsTab({ passes, entries, decisions, atRiskNow, simNow }: EarningsTabProps) {
  const tech = useTechMode();
  const [grain, setGrain] = useState<Grain>(DEFAULT_GRAIN);
  const [wallNow, setWallNow] = useState(() => Date.now());
  useEffect(() => {
    if (simNow !== null) return;
    const id = setInterval(() => setWallNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, [simNow]);

  const flows = useFlows(passes, entries, decisions);
  // The sim clock ticks every second; recomputing per sim minute is plenty for a statement.
  const clock = Math.floor((simNow !== null ? Number(simNow / 1000n) : wallNow) / MINUTE_MS) * MINUTE_MS;
  // Playback can run the clock past the seeded passes; periods then end at the last recorded activity.
  const pastData = flows.latest > 0 && clock > flows.latest;
  const now = pastData ? flows.latest : clock;
  const history = GRAINS.find(g => g.id === grain)!.history;

  const { window: w, lines } = useMemo(() => {
    const w = periodWindow(now, grain, history);
    const sum = (...parts: LineTotals[]) => parts.reduce((a, b) => combine(a, b, (x, y) => x + y));
    const credits = totals(flows.credits, w, grain);
    const recoveries = totals(flows.recoveries, w, grain);
    const denied = totals(flows.denied, w, grain);
    const trimmed = totals(flows.trimmed, w, grain);
    const reviewSaved = totals(flows.reviewSaved, w, grain);
    const protectedRevenue = sum(recoveries, denied, trimmed);
    const lines: Record<LineId, LineTotals> = {
      atRisk: sum(credits, protectedRevenue),
      credits,
      protected: protectedRevenue,
      recoveries,
      denied,
      trimmed,
      reviewSaved,
      savings: sum(protectedRevenue, reviewSaved),
      gross: totals(flows.billed, w, grain),
      invoiced: totals(flows.invoiced, w, grain),
      passes: totals(flows.passCount, w, grain),
    };
    return { window: w, lines };
  }, [flows, now, grain, history]);

  const currentLabel = periodLabel(w.currentStart, grain);
  const previousLabel = periodLabel(w.previousStart, grain);
  const throughText = grain === 'day' ? `through ${utcTime(now)} UTC` : `through ${shortPeriodLabel(now, 'day')}, ${utcTime(now)} UTC`;
  const trendLabels = w.trendStarts.map(s => shortPeriodLabel(s, grain));

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      ['Ground Truth revenue at risk and savings statement (USD)'],
      ['Period', `${currentLabel}, to date ${throughText}`],
      ['Compared with', `${previousLabel}, same elapsed time`],
      ['As of', utcStamp(now)],
      [],
      ['Line', currentLabel, `${previousLabel} (same elapsed)`, 'Change', 'Change %', ...trendLabels.map((l, i) => (i === trendLabels.length - 1 ? `${l} (to date)` : l))],
    ];
    for (const line of LINES) {
      const t = lines[line.id];
      const c = change(t);
      // Deductions are negative in the file so the statement lines sum in a spreadsheet.
      const sign = line.deduction ? -1 : 1;
      const v = (n: number) => (line.count ? n : dollars(sign * n));
      rows.push([line.label, v(t.current), v(t.previous), v(c.abs), c.pct === null ? '' : (sign * c.pct).toFixed(1), ...t.trend.map(v)]);
    }
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `earnings-${grain}-${new Date(w.currentStart).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (passes.length === 0 && entries.length === 0) {
    return <EmptyState art="ledger" title="Nothing settled yet" hint="Billed passes, credits, recoveries and decisions appear here as they post." />;
  }

  const tiles: LineDef[] = [LINE.savings, LINE.atRisk, LINE.credits];

  return (
    <div className="fin-tab earn">
      <div className="earn-bar">
        <div className="earn-toggle" role="radiogroup" aria-label="Reporting period">
          {GRAINS.map(g => (
            <button key={g.id} role="radio" aria-checked={grain === g.id} className={grain === g.id ? 'on' : ''} onClick={() => setGrain(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <span className="earn-asof">{currentLabel} · to date {throughText}{pastData && ', last recorded activity'}</span>
        <button className="ui-link-btn earn-export" onClick={exportCsv}>
          <Download size={13} aria-hidden /> Export CSV
        </button>
      </div>

      <div className="fin-tiles earn-tiles">
        {tiles.map(line => {
          const t = lines[line.id];
          const c = change(t);
          return (
            <div key={line.id} className="fin-tile" title={line.hint}>
              <span className="ui-stat-label">{line.short ?? line.label}</span>
              <span className="ui-stat-value"><CountUp value={t.current} format={compactUsd} /></span>
              <span className="ui-stat-sub">
                <span className={`earn-delta ${tone(line, c)}`}>{pctText(c.pct)}</span> vs {shortPeriodLabel(w.previousStart, grain)}, same time
              </span>
            </div>
          );
        })}
        <div className="fin-tile" title="Billed revenue that may still be credited back: unsettled dropped passes, open disputes and claims waiting for a reviewer, each capped at its pass fee. A live figure, the same as the header.">
          <span className="ui-stat-label">Still at risk · open now</span>
          <span className="ui-stat-value">
            {atRiskNow === null ? <Skeleton width={80} height={20} /> : <CountUp value={atRiskNow} format={compactUsd} />}
          </span>
          <span className="ui-stat-sub">Unsettled drops, open disputes and reviews</span>
        </div>
      </div>

      <div className="earn-statement" role="table" aria-label={`Revenue at risk and savings, ${currentLabel}`}>
        <div className="earn-row earn-head" role="row">
          <span role="columnheader">Statement · USD</span>
          <span role="columnheader" className="right">{shortPeriodLabel(w.currentStart, grain)} to date</span>
          <span role="columnheader" className="right">{shortPeriodLabel(w.previousStart, grain)} same time</span>
          <span role="columnheader" className="right">Change</span>
          <span role="columnheader" className="right">%</span>
          <span role="columnheader" className="right">Last {history} {grain === 'year' ? 'years' : `${grain}s`}</span>
        </div>
        {SECTIONS.map(section => (
          <div key={section.title} role="rowgroup" className="earn-group">
            <div className="earn-row earn-section" role="row"><span role="cell">{section.title}</span></div>
            {section.lines.map(line => <StatementRow key={line.id} line={line} t={lines[line.id]} labels={trendLabels} />)}
          </div>
        ))}
      </div>

      <p className="earn-note">
        Revenue at risk is the money customers could have taken back on the drops and claims settled in the period;
        it splits into credits paid and revenue protected. Savings are revenue protected plus the review cost Ground Truth
        saved, with the same rules as the Overview figures. Gross billed is pass revenue, shown for scale; nothing on this
        page is a profit or net revenue figure.
      </p>
      <p className="earn-note">
        UTC calendar periods ending at {pastData
          ? <>the last recorded activity ({utcStamp(now)}); the simulation clock ({utcStamp(clock)}) has run past the seeded passes</>
          : <>the simulation clock ({utcStamp(now)})</>}. The current {grain === 'year' ? 'year' : grain} is
        compared with the same elapsed time of the previous one. Credits, recoveries and invoices count when posted to the
        ledger; denials and review savings count when decided.
      </p>
      {tech && (
        <p className="earn-note fin-mono">
          source: pass ({flows.billed.length.toLocaleString('en-US')} flown rows, revenue_cents by start_time) · ledger_entry
          ({flows.credits.length} Credit, {flows.recoveries.length} Recovery, {flows.invoiced.length} Invoice) · decision_record,
          dispute, escalated_claim ({flows.denied.length} denied, {flows.trimmed.length} trimmed, {flows.reviewSaved.length} auto-approved) · sim_clock.current_time{' '}
          {simNow === null ? 'not loaded, using wall clock' : new Date(clock).toISOString()}
          {pastData && ` · capped at latest row ${new Date(now).toISOString()}`}
          · window [{new Date(w.currentStart).toISOString()}, now] vs [{new Date(w.previousStart).toISOString()}, {new Date(w.previousEnd).toISOString()})
        </p>
      )}
    </div>
  );
}

function StatementRow({ line, t, labels }: { line: LineDef; t: LineTotals; labels: string[] }) {
  const c = change(t);
  const format = line.count ? (v: number) => Math.round(v).toLocaleString('en-US') : (v: number) => wholeUsd(v);
  const spark = t.trend.map((y, i) => ({ x: i === labels.length - 1 ? `${labels[i]} (to date)` : labels[i], y }));
  return (
    <div className={`earn-row ${line.total ? 'earn-total' : ''}`} role="row" title={line.hint}>
      <span role="cell" className="earn-label">
        {line.label}
        {line.hint && <span className="earn-hint">{line.hint}</span>}
      </span>
      <span role="cell" className="right earn-amount">{amount(line, t.current)}</span>
      <span role="cell" className="right earn-prev">{amount(line, t.previous)}</span>
      <span role="cell" className={`right earn-delta ${tone(line, c)}`}>{signedAmount(line, c.abs)}</span>
      <span role="cell" className={`right earn-delta ${tone(line, c)}`}>{pctText(c.pct)}</span>
      <span role="cell" className="earn-spark">
        <Sparkline data={spark} color={line.color} height={26} format={format} label={`${line.label} by period`} />
      </span>
    </div>
  );
}
