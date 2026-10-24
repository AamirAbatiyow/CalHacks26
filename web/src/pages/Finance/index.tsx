import { useMemo, useState } from 'react';
import { useTable, micros, tag } from '../../hooks/useTable';
import type { DecisionOutcome, DecisionRecord, DecisionType, LedgerEntry, LedgerEntryType } from '../../types';
import { SummaryTab } from './SummaryTab';
import { LedgerTab } from './LedgerTab';
import { AuditTab } from './AuditTab';
import './Finance.css';

export type FinanceTabId = 'summary' | 'ledger' | 'audit';
type TabId = FinanceTabId;

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

function useFinanceData() {
  const kpiRows = useTable('kpi');
  const decisionRows = useTable('decisionRecord');
  const ledgerRows = useTable('ledgerEntry');

  const decisionRecords = useMemo<DecisionRecord[]>(() => decisionRows.map(row => ({
    id: row.id,
    createdAt: micros(row.createdAt),
    decisionType: tag(row.decisionType) as DecisionType,
    outcome: tag(row.outcome) as DecisionOutcome,
    passId: row.passId ?? null,
    stationId: row.stationId ?? null,
    amountCents: row.amountCents,
    reason: row.reason,
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
  })), [decisionRows]);

  const ledgerEntries = useMemo<LedgerEntry[]>(() => ledgerRows.map(row => ({
    id: row.id,
    createdAt: micros(row.createdAt),
    entryType: tag(row.entryType) as LedgerEntryType,
    description: row.description,
    referenceId: row.referenceId ?? null,
    amountCents: row.amountCents,
  })), [ledgerRows]);

  return { kpi: kpiRows[0] ?? null, decisionRecords, ledgerEntries };
}

export default function Finance({ initialTab = 'summary' }: { initialTab?: FinanceTabId }) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const { kpi, decisionRecords, ledgerEntries } = useFinanceData();

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
