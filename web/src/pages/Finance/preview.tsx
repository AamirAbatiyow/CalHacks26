import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Finance from './index';
import '../../index.css';
import '../../App.css';
import { KpiStrip } from '../../components/KpiStrip';
import { Sidebar } from '../../components/Sidebar';

function FinancePreview() {
  const mockKpi = {
    id: 'main',
    billedThisMonthCents: BigInt(1940000000),
    revenueAtRiskCents: BigInt(41200000),
    creditsPaidCents: BigInt(8600000),
    recoveredCents: BigInt(13100000),
  };

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <KpiStrip kpi={mockKpi} connected={true} />
        <Finance />
      </main>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <FinancePreview />
    </StrictMode>
  );
}

export default FinancePreview;
