import { useMemo } from 'react';
import type { Kpi } from '../types';
import { useTable } from './useTable';

/** The live `kpi` row. Every figure is derived server-side from pass, ledger and decision tables. */
export function useKpi(): Kpi | null {
  const rows = useTable('kpi');
  return useMemo<Kpi | null>(() => {
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      billedThisMonthCents: row.billedThisMonthCents,
      revenueAtRiskCents: row.revenueAtRiskCents,
      creditsPaidCents: row.creditsPaidCents,
      recoveredCents: row.recoveredCents,
      leakageAvoidedCents: row.leakageAvoidedCents,
      reviewCostSavedCents: row.reviewCostSavedCents,
    };
  }, [rows]);
}
