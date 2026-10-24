import { useMemo } from 'react';
import { useTable, reducers, micros, type RowOf } from './useTable';

export type ClaimCase = RowOf<'claimCase'>;
export type AuditDecision = RowOf<'auditDecision'>;
export type PolicyProposal = RowOf<'policyProposal'>;
export type MiningResult = RowOf<'miningResult'>;
export type MinedRule = RowOf<'minedRule'>;
export type CustomerContract = RowOf<'customerContract'>;

export const AUTO_DECIDE_CONFIDENCE = 95;

/** Deciding features a reviewer can mark as decisive, in the miner's order. */
export const DECIDING_KEYS = [
  'claim_type',
  'tier',
  'weather_band',
  'maintenance',
  'integrity',
  'lost_band',
  'claim_vs_contract',
  'msg_cites_weather',
  'elevation_band',
  'account',
] as const;

export const KEY_LABELS: Record<string, string> = {
  claim_type: 'Claim type',
  tier: 'Contract tier',
  weather_band: 'Space weather vs exclusion',
  maintenance: 'Maintenance notice',
  integrity: 'Data integrity',
  lost_band: 'Share of contact lost',
  claim_vs_contract: 'Claim vs contract credit',
  msg_cites_weather: 'Message cites weather',
  elevation_band: 'Elevation vs contract minimum',
  account: 'Account age',
};

export const REASON_CODES: Record<string, string> = {
  contract_credit: 'Credited per contract formula',
  credit_formula: 'Claim exceeds formula; formula paid',
  notice_not_met: 'Maintenance notice not met',
  station_outage: 'Unplanned station outage',
  benefit_of_doubt: 'Benefit of the doubt',
  goodwill: 'Goodwill',
  excused_space_weather: 'Excused: space weather exclusion',
  excused_maintenance: 'Excused: notified maintenance',
  best_effort_elevation: 'Best effort: below minimum elevation',
  data_delivered: 'Data delivered; customer-side fault',
  duplicate: 'Duplicate claim',
};

/** Exact dollars, e.g. 460000n -> "$4,600". */
export function dollars(cents: bigint | number): string {
  const value = Number(cents) / 100;
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0 })}`;
}

export function signedDollars(cents: bigint | number): string {
  const n = Number(cents);
  return n > 0 ? `+${dollars(n)}` : dollars(n);
}

export function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

export function lostBand(lostPct: number): string {
  return lostPct >= 60 ? '60_plus' : lostPct >= 25 ? '25_to_59' : 'under_25';
}

/** Value of a deciding key for a case, mirroring `Features::value` on the server. */
export function caseValue(c: ClaimCase, contract: CustomerContract | undefined, key: string): string {
  switch (key) {
    case 'claim_type': return c.claimType;
    case 'tier': return contract?.tier ?? '';
    case 'weather_band': return c.weatherBand;
    case 'maintenance': return c.maintenance;
    case 'integrity': return c.integrity;
    case 'lost_band': return lostBand(Number(c.lostPct));
    case 'claim_vs_contract': return Number(c.claimedCents) * 100 > Number(c.contractCreditCents) * 110 ? 'over' : 'within';
    case 'msg_cites_weather': return c.msgCitesWeather ? 'yes' : 'no';
    case 'elevation_band': return contract && c.maxElevationDeg < contract.minElevationDeg ? 'below_contract_min' : 'ok';
    case 'account': return c.newAccount ? 'new' : 'established';
    default: return '';
  }
}

export function useClaimCases(): ClaimCase[] {
  const rows = useTable('claimCase');
  return useMemo(() => [...rows].sort((a, b) => a.caseId.localeCompare(b.caseId)), [rows]);
}

export function useContracts(): Map<string, CustomerContract> {
  const rows = useTable('customerContract');
  return useMemo(() => new Map(rows.map(r => [r.customerId, r])), [rows]);
}

export function useAuditDecisions(): AuditDecision[] {
  const rows = useTable('auditDecision');
  return useMemo(() => [...rows].sort((a, b) => Number(micros(b.decidedAt) - micros(a.decidedAt))), [rows]);
}

export function useMiningResults(): MiningResult[] {
  const rows = useTable('miningResult');
  return useMemo(() => [...rows].sort((a, b) => Number(b.id - a.id)), [rows]);
}

export function useProposals(): PolicyProposal[] {
  return useTable('policyProposal');
}

export function useMinedRules(): MinedRule[] {
  return useTable('minedRule');
}

export interface CaseEvidence {
  score?: RowOf<'caseScore'>;
  shap: RowOf<'caseShap'>[];
  rules: RowOf<'caseRule'>[];
  conflicts: RowOf<'caseConflict'>[];
  similar: { row: RowOf<'caseSimilar'>; decision?: AuditDecision }[];
  options: RowOf<'caseOption'>[];
  messages: RowOf<'claimMessage'>[];
}

export function useCaseEvidence(caseId: string | undefined, decisions: AuditDecision[]): CaseEvidence {
  const scores = useTable('caseScore');
  const shap = useTable('caseShap');
  const rules = useTable('caseRule');
  const conflicts = useTable('caseConflict');
  const similar = useTable('caseSimilar');
  const options = useTable('caseOption');
  const messages = useTable('claimMessage');
  const byId = useMemo(() => new Map(decisions.map(d => [d.id, d])), [decisions]);

  return useMemo(() => {
    const mine = <T extends { caseId: string }>(rows: T[]) => rows.filter(r => r.caseId === caseId);
    return {
      score: scores.find(s => s.caseId === caseId),
      shap: mine(shap).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
      rules: mine(rules).sort((a, b) => Number(a.id - b.id)),
      conflicts: mine(conflicts).sort((a, b) => Number(b.penalty - a.penalty)),
      similar: mine(similar).sort((a, b) => a.rank - b.rank).map(row => ({ row, decision: byId.get(row.decisionId) })),
      options: mine(options).sort((a, b) => Number(a.id - b.id)),
      messages: mine(messages),
    };
  }, [caseId, scores, shap, rules, conflicts, similar, options, messages, byId]);
}

export interface DecideArgs {
  caseId: string;
  outcome: string;
  creditCents: bigint;
  reasonCode: string;
  reasonText: string;
  decisive: string[];
  reviewer: string;
}

export function decideCase(args: DecideArgs): Promise<void> {
  const r = reducers();
  if (!r) return Promise.reject(new Error('Not connected'));
  return r.decideCase(args);
}

export function submitSimilarClaim(sourceCaseId: string): Promise<void> {
  const r = reducers();
  if (!r) return Promise.reject(new Error('Not connected'));
  return r.submitSimilarClaim({ sourceCaseId });
}

export function promoteVersion(versionId: string): Promise<void> {
  const r = reducers();
  if (!r) return Promise.reject(new Error('Not connected'));
  return r.promotePolicyVersion({ versionId });
}
