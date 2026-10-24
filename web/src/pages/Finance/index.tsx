import { useState } from 'react';
import { useSpacetimeDB } from '../../hooks/useSpacetimeDB';
import { SummaryTab } from './SummaryTab';
import { LedgerTab } from './LedgerTab';
import { AuditTab } from './AuditTab';
import './Finance.css';

type TabId = 'summary' | 'ledger' | 'audit';

function formatDollars(cents: bigint): string {
  const dollars = Number(cents) / 100;
  if (dollars >= 1000000) {
    return `$${(dollars / 1000000).toFixed(1)}M / yr`;
  }
  if (dollars >= 1000) {
    return `$${Math.round(dollars / 1000)}K`;
  }
  return `$${dollars.toFixed(0)}`;
}

export default function Finance() {
  const [activeTab, setActiveTab] = useState<TabId>('summary');
  const { kpi, decisionRecords, ledgerEntries } = useSpacetimeDB();

  const leakageAvoided = '$1.0M / yr';
  const reviewCostSaved = '$8.6M / yr';
  const creditsIssued = kpi ? formatDollars(kpi.creditsPaidCents) : '$86K';

  const tabs: { id: TabId; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'ledger', label: 'Ledger' },
    { id: 'audit', label: 'Audit' },
  ];

  return (
    <div className="finance-page">
      <div className="finance-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`finance-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="finance-content">
        {activeTab === 'summary' && (
          <SummaryTab
            leakageAvoided={leakageAvoided}
            reviewCostSaved={reviewCostSaved}
            creditsIssued={creditsIssued}
          />
        )}
        {activeTab === 'ledger' && (
          <LedgerTab entries={ledgerEntries} />
        )}
        {activeTab === 'audit' && (
          <AuditTab decisions={decisionRecords} />
        )}
      </div>
    </div>
  );
}
