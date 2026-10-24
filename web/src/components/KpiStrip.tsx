import type { Kpi } from '../types';
import type { ConnectionState } from '../hooks/useSpacetimeDB';
import { formatDollars } from '../utils/money';
import './KpiStrip.css';

interface KpiStripProps {
  kpi: Kpi | null;
  connectionState: ConnectionState;
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

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const stateConfig = {
    connecting: { className: 'connecting', label: 'Connecting...' },
    connected: { className: 'connected', label: 'Live' },
    disconnected: { className: 'disconnected', label: 'Disconnected' },
    error: { className: 'error', label: 'Error' },
  };
  
  const config = stateConfig[state];
  
  return (
    <span className={`connection-status ${config.className}`} title={config.label}>
      <span className="status-dot" />
      <span className="status-label">{config.label}</span>
    </span>
  );
}

export function KpiStrip({ kpi, connectionState }: KpiStripProps) {
  const isConnected = connectionState === 'connected';
  
  return (
    <header className="kpi-strip">
      <div className="kpi-header">
        <h1 className="kpi-title">Ground Truth</h1>
        <ConnectionIndicator state={connectionState} />
      </div>
      <div className="kpi-metrics">
        <KpiItem
          label="Billed this month"
          value={isConnected && kpi ? formatDollars(kpi.billedThisMonthCents) : '—'}
        />
        <KpiItem
          label="Revenue at risk"
          value={isConnected && kpi ? formatDollars(kpi.revenueAtRiskCents) : '—'}
          isAlert
        />
        <KpiItem
          label="Credits paid"
          value={isConnected && kpi ? formatDollars(kpi.creditsPaidCents) : '—'}
        />
        <KpiItem
          label="Recovered"
          value={isConnected && kpi ? formatDollars(kpi.recoveredCents) : '—'}
        />
      </div>
    </header>
  );
}
