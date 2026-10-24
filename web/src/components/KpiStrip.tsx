import type { Kpi } from '../types';
import './KpiStrip.css';

interface KpiStripProps {
  kpi: Kpi | null;
  connected: boolean;
}

function formatDollars(cents: bigint): string {
  const dollars = Number(cents) / 100;
  if (dollars >= 1000000) {
    return `$${(dollars / 1000000).toFixed(1)}M`;
  }
  if (dollars >= 1000) {
    return `$${(dollars / 1000).toFixed(0)}K`;
  }
  return `$${dollars.toFixed(0)}`;
}

interface KpiItemProps {
  label: string;
  value: string;
  isAlert?: boolean;
}

function KpiItem({ label, value, isAlert }: KpiItemProps) {
  return (
    <div className={`kpi-item ${isAlert ? 'alert' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
}

export function KpiStrip({ kpi, connected }: KpiStripProps) {
  return (
    <header className="kpi-strip">
      <div className="kpi-header">
        <h1 className="kpi-title">Ground Truth</h1>
        <span className={`connection-status ${connected ? 'connected' : ''}`}>
          {connected ? '●' : '○'}
        </span>
      </div>
      <div className="kpi-metrics">
        <KpiItem
          label="Billed this month"
          value={kpi ? formatDollars(kpi.billedThisMonthCents) : '—'}
        />
        <KpiItem
          label="Revenue at risk"
          value={kpi ? formatDollars(kpi.revenueAtRiskCents) : '—'}
          isAlert
        />
        <KpiItem
          label="Credits paid"
          value={kpi ? formatDollars(kpi.creditsPaidCents) : '—'}
        />
        <KpiItem
          label="Recovered"
          value={kpi ? formatDollars(kpi.recoveredCents) : '—'}
        />
      </div>
    </header>
  );
}
