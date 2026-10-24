import { useMemo, useState } from 'react';
import { useTable, micros, tag } from '../../hooks/useTable';
import { useKpi } from '../../hooks/useKpi';
import { formatDollars } from '../../utils/money';
import type { DecisionOutcome, DecisionRecord, DecisionType, LedgerEntry, LedgerEntryType } from '../../types';
import { SummaryTab } from './SummaryTab';
import { LedgerTab } from './LedgerTab';
import { AuditTab } from './AuditTab';
import './Finance.css';

export type FinanceTabId = 'summary' | 'ledger' | 'audit';
type TabId = FinanceTabId;

function useFinanceData() {
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

  return { decisionRecords, ledgerEntries };
}

export default function Finance({ initialTab = 'summary' }: { initialTab?: FinanceTabId }) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const { decisionRecords, ledgerEntries } = useFinanceData();
  const kpi = useKpi();

  const leakageAvoided = kpi ? formatDollars(kpi.leakageAvoidedCents) : '—';
  const reviewCostSaved = kpi ? formatDollars(kpi.reviewCostSavedCents) : '—';
  const creditsIssued = kpi ? formatDollars(kpi.creditsPaidCents) : '—';

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
