import { useMemo } from 'react';
import { ArrowDownLeft, ArrowUpRight, RotateCcw, type LucideIcon } from 'lucide-react';
import type { LedgerEntry } from '../../types';
import { formatDollars } from '../../utils/money';
import { C, Sparkline, StackedBars } from '../../ui/charts';
import { CountUp, compactUsd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { dailyBuckets } from '../../ui/series';

interface LedgerTabProps {
  entries: LedgerEntry[];
}

function formatTimestamp(micros: bigint): string {
  const date = new Date(Number(micros / BigInt(1000)));
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const TYPES = ['Invoice', 'Credit', 'Recovery'] as const;
type EntryKind = (typeof TYPES)[number];

const TYPE_META: Record<EntryKind, { label: string; color: string; icon: LucideIcon }> = {
  Invoice: { label: 'Invoices', color: C.primary, icon: ArrowUpRight },
  Credit: { label: 'Credits', color: C.amber, icon: ArrowDownLeft },
  Recovery: { label: 'Recoveries', color: C.accent, icon: RotateCcw },
};

export function LedgerTab({ entries }: LedgerTabProps) {
  const sortedEntries = useMemo(() => [...entries].sort((a, b) => Number(b.createdAt - a.createdAt)), [entries]);

  const { totals, daily } = useMemo(() => {
    const totals: Record<EntryKind, number> = { Invoice: 0, Credit: 0, Recovery: 0 };
    for (const e of entries) {
      if ((TYPES as readonly string[]).includes(e.entryType)) totals[e.entryType as EntryKind] += Math.abs(Number(e.amountCents));
    }
    const daily = dailyBuckets(entries, e => e.createdAt, TYPES, e =>
      (TYPES as readonly string[]).includes(e.entryType) ? { key: e.entryType as EntryKind, amount: Math.abs(Number(e.amountCents)) } : null);
    return { totals, daily };
  }, [entries]);

  if (sortedEntries.length === 0) {
    return <EmptyState art="ledger" title="No ledger entries yet" hint="Invoices, credits and recoveries appear here as they post." />;
  }

  return (
    <div className="fin-tab">
      <div className="fin-tiles">
        {TYPES.map(t => {
          const meta = TYPE_META[t];
          const Icon = meta.icon;
          return (
            <div key={t} className="fin-tile">
              <span className="ui-stat-label"><Icon size={12} style={{ color: meta.color }} aria-hidden /> {meta.label} · 30 days</span>
              <span className="ui-stat-value"><CountUp value={totals[t]} format={compactUsd} /></span>
              <Sparkline data={daily.map(d => ({ x: d.x, y: d[t] / 100 }))} color={meta.color} height={34}
                format={v => compactUsd(v * 100)} label={`${meta.label} per day, last 30 days`} />
            </div>
          );
        })}
      </div>

      <div className="fin-chart">
        <div className="ui-section-title">Credits and recoveries per day</div>
        <StackedBars
          data={daily.map(d => ({ x: d.x, Credit: d.Credit, Recovery: d.Recovery }))}
          series={[
            { key: 'Credit', label: 'Credits', color: C.amber },
            { key: 'Recovery', label: 'Recoveries', color: C.accent },
          ]}
          height={110}
          format={v => compactUsd(v)}
          label="Credits and recoveries paid per day over the last 30 days, in dollars"
        />
      </div>

      <table className="ledger-table fin-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Reference</th>
            <th style={{ textAlign: 'right' }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map((entry) => {
            const isNegative = entry.amountCents < BigInt(0);
            const meta = TYPE_META[entry.entryType as EntryKind];
            const Icon = meta?.icon;
            return (
              <tr key={entry.id.toString()} title={entry.description}>
                <td className="fin-muted">{formatTimestamp(entry.createdAt)}</td>
                <td>
                  <span className="ledger-type">
                    {Icon && <Icon size={12} style={{ color: meta.color }} aria-hidden />}
                    {entry.entryType}
                  </span>
                </td>
                <td className="fin-muted fin-mono">{entry.referenceId || '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <span className={`ledger-amount ${isNegative ? 'negative' : 'positive'}`}>
                    {isNegative ? '−' : '+'}{formatDollars(isNegative ? -entry.amountCents : entry.amountCents)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
