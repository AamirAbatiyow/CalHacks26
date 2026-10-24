import type { Kpi } from '../types';
import type { ConnectionState } from '../hooks/useSpacetimeDB';
import { CountUp, compactUsd } from '../ui/CountUp';
import { Skeleton } from '../ui/Skeleton';
import './KpiStrip.css';

interface KpiStripProps {
  kpi: Kpi | null;
  connectionState: ConnectionState;
}

interface KpiItemProps {
  label: string;
  cents: bigint | null;
  isAlert?: boolean;
}

function KpiItem({ label, cents, isAlert }: KpiItemProps) {
  return (
    <div className={`kpi-item ${isAlert ? 'alert' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        {cents === null ? <Skeleton width={72} height={18} /> : <CountUp value={Number(cents)} format={compactUsd} />}
      </span>
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
        <KpiItem label="Billed this month" cents={isConnected && kpi ? kpi.billedThisMonthCents : null} />
        <KpiItem label="Revenue at risk" cents={isConnected && kpi ? kpi.revenueAtRiskCents : null} isAlert />
        <KpiItem label="Credits paid" cents={isConnected && kpi ? kpi.creditsPaidCents : null} />
        <KpiItem label="Recovered" cents={isConnected && kpi ? kpi.recoveredCents : null} />
      </div>
    </header>
  );
}
