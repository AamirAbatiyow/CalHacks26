import type { KPIs } from '../types';
import './KPIStrip.css';

export interface KPIStripProps {
  kpis: KPIs;
}

export function KPIStrip({ kpis }: KPIStripProps) {
  return (
    <div className="kpi-strip">
      <KPICard label="Billed this month" value={kpis.billedThisMonth} />
      <KPICard label="Revenue at risk" value={kpis.revenueAtRisk} variant="warning" />
      <KPICard label="Credits paid" value={kpis.creditsPaid} />
      <KPICard label="Recovered" value={kpis.recovered} />
    </div>
  );
}

interface KPICardProps {
  label: string;
  value: number;
  variant?: 'default' | 'warning';
}

function KPICard({ label, value, variant = 'default' }: KPICardProps) {
  const formatted = formatCurrency(value);

  return (
    <div className={`kpi-card ${variant === 'warning' ? 'kpi-card--warning' : ''}`}>
      <span className="kpi-card-label">{label}</span>
      <span className="kpi-card-value">{formatted}</span>
    </div>
  );
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${Math.round(value / 1_000)}K`;
  }
  return `$${value}`;
}
