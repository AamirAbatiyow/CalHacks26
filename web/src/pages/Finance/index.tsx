import { useMemo, useState } from 'react';
import { useTable, micros, tag } from '../../hooks/useTable';
import { useKpi } from '../../hooks/useKpi';
import { motion } from 'motion/react';
import type { DecisionOutcome, DecisionRecord, DecisionType, LedgerEntry, LedgerEntryType, Pass } from '../../types';
import { SummaryTab } from './SummaryTab';
import { LedgerTab } from './LedgerTab';
import { AuditTab } from './AuditTab';
import { EarningsTab } from './EarningsTab';
import './Finance.css';

export type FinanceTabId = 'summary' | 'earnings' | 'ledger' | 'audit';
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
    passId: row.passId ?? null,
    stationId: row.stationId ?? null,
  })), [ledgerRows]);

  return { decisionRecords, ledgerEntries };
}

interface FinanceProps {
  initialTab?: FinanceTabId;
  passes?: Pass[];
  simNow?: bigint | null;
}

export default function Finance({ initialTab = 'summary', passes = [], simNow = null }: FinanceProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const { decisionRecords, ledgerEntries } = useFinanceData();
  const kpi = useKpi();

  const leakageAvoided = kpi ? Number(kpi.leakageAvoidedCents) : null;
  const reviewCostSaved = kpi ? Number(kpi.reviewCostSavedCents) : null;
  const creditsIssued = kpi ? Number(kpi.creditsPaidCents) : null;

  const tabs: { id: TabId; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'earnings', label: 'Earnings' },
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
            onClick={() => {
              setActiveTab(tab.id);
              window.history.replaceState(null, '', tab.id === 'summary' ? '#/finance' : `#/finance/${tab.id}`);
            }}
          >
            {tab.label}
            {activeTab === tab.id && <motion.span layoutId="finance-tab" className="finance-tab-line" transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} />}
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
        {activeTab === 'earnings' && (
          <EarningsTab
            passes={passes}
            entries={ledgerEntries}
            decisions={decisionRecords}
            atRiskNow={kpi ? Number(kpi.revenueAtRiskCents) : null}
            simNow={simNow}
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
