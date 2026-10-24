import { useMemo } from 'react';
import { ArrowDownLeft, ArrowUpRight, RotateCcw, type LucideIcon } from 'lucide-react';
import type { LedgerEntry } from '../../types';
import { formatDollars } from '../../utils/money';
import { C, LineSeries } from '../../ui/charts';
import { CountUp, compactUsd } from '../../ui/CountUp';
import { DataTable, type Column } from '../../ui/DataTable';
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
  Invoice: { label: 'Invoiced', color: C.primary, icon: ArrowUpRight },
  Credit: { label: 'Credits paid', color: C.amber, icon: ArrowDownLeft },
  Recovery: { label: 'Recovered', color: C.accent, icon: RotateCcw },
};

const COLUMNS: Column<LedgerEntry>[] = [
  { key: 'time', label: 'Time', width: '150px', sort: e => Number(e.createdAt), render: e => <span className="ui-table-muted">{formatTimestamp(e.createdAt)}</span> },
  {
    key: 'type', label: 'Type', width: '120px', sort: e => e.entryType,
    render: e => {
      const meta = TYPE_META[e.entryType as EntryKind];
      const Icon = meta?.icon;
      return <span className="ledger-type">{Icon && <Icon size={12} style={{ color: meta.color }} aria-hidden />}{e.entryType}</span>;
    },
  },
  { key: 'description', label: 'Description', width: 'minmax(0, 1fr)', sort: e => e.description, render: e => e.description || '—' },
  { key: 'ref', label: 'Reference', width: '200px', sort: e => e.referenceId ?? '', render: e => <span className="ui-table-muted fin-mono">{e.referenceId || '—'}</span> },
  {
    key: 'amount', label: 'Amount', width: '110px', align: 'right', sort: e => Number(e.amountCents),
    render: e => {
      const neg = e.amountCents < BigInt(0);
      return <span className={`ledger-amount ${neg ? 'negative' : 'positive'}`}>{neg ? '−' : '+'}{formatDollars(neg ? -e.amountCents : e.amountCents)}</span>;
    },
  },
];

export function LedgerTab({ entries }: LedgerTabProps) {
  const { totals, cumulative } = useMemo(() => {
    const totals: Record<EntryKind, number> = { Invoice: 0, Credit: 0, Recovery: 0 };
    for (const e of entries) {
      if ((TYPES as readonly string[]).includes(e.entryType)) totals[e.entryType as EntryKind] += Math.abs(Number(e.amountCents));
    }
    const daily = dailyBuckets(entries, e => e.createdAt, ['Credit', 'Recovery'] as const, e =>
      e.entryType === 'Credit' || e.entryType === 'Recovery' ? { key: e.entryType, amount: Math.abs(Number(e.amountCents)) } : null);
    const cumulative: { x: string; Credit: number; Recovery: number }[] = [];
    for (const d of daily) {
      const prev = cumulative[cumulative.length - 1];
      cumulative.push({ x: d.x, Credit: (prev?.Credit ?? 0) + d.Credit, Recovery: (prev?.Recovery ?? 0) + d.Recovery });
    }
    return { totals, cumulative };
  }, [entries]);

  if (entries.length === 0) {
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
            </div>
          );
        })}
      </div>

      <div className="fin-chart">
        <div className="fin-chart-head">
          <span className="ui-section-title">Credits paid vs recovered · cumulative, 30 days</span>
          <span className="ui-legend">
            <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: C.amber }} />Credits paid</span>
            <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: C.accent }} />Recovered</span>
          </span>
        </div>
        <LineSeries
          data={cumulative}
          series={[
            { key: 'Credit', label: 'Credits paid', color: C.amber },
            { key: 'Recovery', label: 'Recovered', color: C.accent },
          ]}
          height={190}
          format={compactUsd}
          label="Cumulative credits paid and money recovered over the last 30 days, in dollars"
        />
      </div>

      <DataTable
        rows={entries}
        columns={COLUMNS}
        rowKey={e => e.id.toString()}
        defaultSort={{ key: 'time', dir: 'desc' }}
        label="Ledger entries"
        className="fin-table-v2"
      />
    </div>
  );
}
