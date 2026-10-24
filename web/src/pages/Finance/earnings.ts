/**
 * Period statement math for the Finance > Earnings tab. Pure, so it runs under `node --test`.
 *
 * Periods are UTC calendar periods (ISO weeks start Monday) ending at `now`, which the page
 * takes from `sim_clock.current_time`. The current period is to-date, so it is compared with
 * the same elapsed span of the previous period, never with a whole one.
 */

export type Grain = 'day' | 'week' | 'month' | 'year';

export const GRAINS: { id: Grain; label: string; history: number }[] = [
  { id: 'day', label: 'Day', history: 14 },
  { id: 'week', label: 'Week', history: 12 },
  { id: 'month', label: 'Month', history: 12 },
  { id: 'year', label: 'Annual', history: 5 },
];

/** One dated amount: cents for money lines, 1 per item for counts. */
export interface Flow {
  at: number;
  value: number;
}

const DAY_MS = 86_400_000;

export function periodStart(ms: number, grain: Grain): number {
  const d = new Date(ms);
  switch (grain) {
    case 'day':
      return Math.floor(ms / DAY_MS) * DAY_MS;
    case 'week': {
      const day = Math.floor(ms / DAY_MS);
      return (day - ((day + 3) % 7)) * DAY_MS;
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}

/** Start of the period `n` periods after (negative: before) the one starting at `start`. */
export function shiftPeriod(start: number, grain: Grain, n: number): number {
  const d = new Date(start);
  switch (grain) {
    case 'day':
      return start + n * DAY_MS;
    case 'week':
      return start + n * 7 * DAY_MS;
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear() + n, 0, 1);
  }
}

/** Whole periods from the one containing `ms` to the one starting at `currentStart`. */
function periodsBack(ms: number, currentStart: number, grain: Grain): number {
  switch (grain) {
    case 'day':
      return Math.floor((currentStart - periodStart(ms, 'day')) / DAY_MS);
    case 'week':
      return Math.floor((currentStart - periodStart(ms, 'week')) / (7 * DAY_MS));
    case 'month': {
      const a = new Date(ms);
      const b = new Date(currentStart);
      return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
    }
    case 'year':
      return new Date(currentStart).getUTCFullYear() - new Date(ms).getUTCFullYear();
  }
}

const fmt = (ms: number, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

export function periodLabel(start: number, grain: Grain): string {
  switch (grain) {
    case 'day':
      return fmt(start, { month: 'short', day: 'numeric', year: 'numeric' });
    case 'week':
      return `Week of ${fmt(start, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    case 'month':
      return fmt(start, { month: 'long', year: 'numeric' });
    case 'year':
      return String(new Date(start).getUTCFullYear());
  }
}

/** Short label for chart tooltips and CSV headers. */
export function shortPeriodLabel(start: number, grain: Grain): string {
  switch (grain) {
    case 'day':
      return fmt(start, { month: 'short', day: 'numeric' });
    case 'week':
      return `Wk ${fmt(start, { month: 'short', day: 'numeric' })}`;
    case 'month':
      return fmt(start, { month: 'short', year: 'numeric' });
    case 'year':
      return String(new Date(start).getUTCFullYear());
  }
}

export interface Window {
  /** Current period: [currentStart, now]. */
  currentStart: number;
  now: number;
  /** Previous period cut at the same elapsed time: [previousStart, previousEnd). */
  previousStart: number;
  previousEnd: number;
  /** Starts of the trend periods, oldest first; the last is the current period. */
  trendStarts: number[];
}

export function periodWindow(now: number, grain: Grain, history: number): Window {
  const currentStart = periodStart(now, grain);
  const previousStart = shiftPeriod(currentStart, grain, -1);
  const previousEnd = Math.min(previousStart + (now - currentStart), currentStart);
  const trendStarts = Array.from({ length: history }, (_, i) => shiftPeriod(currentStart, grain, i - history + 1));
  return { currentStart, now, previousStart, previousEnd, trendStarts };
}

export interface LineTotals {
  current: number;
  previous: number;
  /** One total per trend period, aligned with `Window.trendStarts`; the last is to-date. */
  trend: number[];
}

/** Sums flows into the current period, the like-for-like previous period and the trend. Flows after `now` are ignored. */
export function totals(flows: Flow[], w: Window, grain: Grain): LineTotals {
  const history = w.trendStarts.length;
  const out: LineTotals = { current: 0, previous: 0, trend: new Array(history).fill(0) };
  for (const f of flows) {
    if (f.at > w.now) continue;
    const back = periodsBack(f.at, w.currentStart, grain);
    if (back < 0) continue;
    if (back < history) out.trend[history - 1 - back] += f.value;
    if (back === 0) out.current += f.value;
    else if (back === 1 && f.at < w.previousEnd) out.previous += f.value;
  }
  return out;
}

export function combine(a: LineTotals, b: LineTotals, op: (x: number, y: number) => number): LineTotals {
  return {
    current: op(a.current, b.current),
    previous: op(a.previous, b.previous),
    trend: a.trend.map((v, i) => op(v, b.trend[i])),
  };
}

export interface Change {
  abs: number;
  /** Null when the previous period was zero: a percentage of nothing is not a number. */
  pct: number | null;
}

export function change({ current, previous }: Pick<LineTotals, 'current' | 'previous'>): Change {
  const abs = current - previous;
  return { abs, pct: previous === 0 ? null : (abs / Math.abs(previous)) * 100 };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
