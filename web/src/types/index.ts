export const PassStatus = {
  Scheduled: 'Scheduled',
  Active: 'Active',
  Ok: 'Ok',
  Dropped: 'Dropped',
} as const;
export type PassStatus = (typeof PassStatus)[keyof typeof PassStatus];

export const FlareClass = {
  None: 'None',
  C: 'C',
  M: 'M',
  X: 'X',
} as const;
export type FlareClass = (typeof FlareClass)[keyof typeof FlareClass];

export const DecisionType = {
  DisputeCreated: 'DisputeCreated',
  DisputeResolved: 'DisputeResolved',
  CreditIssued: 'CreditIssued',
  PassDropped: 'PassDropped',
  PassRecovered: 'PassRecovered',
} as const;
export type DecisionType = (typeof DecisionType)[keyof typeof DecisionType];

export const DecisionOutcome = {
  Pending: 'Pending',
  Approved: 'Approved',
  Denied: 'Denied',
  AutoApproved: 'AutoApproved',
  Escalated: 'Escalated',
} as const;
export type DecisionOutcome = (typeof DecisionOutcome)[keyof typeof DecisionOutcome];

export const EscalatedClaimStatus = {
  Pending: 'Pending',
  Approved: 'Approved',
  Denied: 'Denied',
  Edited: 'Edited',
} as const;
export type EscalatedClaimStatus = (typeof EscalatedClaimStatus)[keyof typeof EscalatedClaimStatus];

export interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  altitudeM: number;
  monthlyRevenueCents: bigint;
}

export interface Satellite {
  noradId: number;
  name: string;
  tleLine1: string;
  tleLine2: string;
  operator: string;
}

export interface Pass {
  id: bigint;
  satelliteId: number;
  stationId: string;
  startTime: bigint;
  endTime: bigint;
  status: PassStatus;
  maxElevationDeg: number;
  revenueCents: bigint;
}

export interface SpaceWeather {
  timestamp: bigint;
  kpIndex: number;
  flareClass: FlareClass;
  dstIndex: number;
}

export interface SimClock {
  id: number;
  currentTime: bigint;
  speedMultiplier: number;
  isPlaying: boolean;
  realTimeAnchor: bigint;
  simTimeAnchor: bigint;
}

export interface Kpi {
  id: string;
  billedThisMonthCents: bigint;
  revenueAtRiskCents: bigint;
  creditsPaidCents: bigint;
  recoveredCents: bigint;
  leakageAvoidedCents: bigint;
  reviewCostSavedCents: bigint;
}

export interface DecisionRecord {
  id: bigint;
  createdAt: bigint;
  decisionType: DecisionType;
  outcome: DecisionOutcome;
  passId: bigint | null;
  stationId: string | null;
  amountCents: bigint;
  reason: string;
  policyVersion: string;
  modelVersion: string;
}

export interface EscalatedClaim {
  id: bigint;
  customerName: string;
  amountClaimedCents: bigint;
  proposedAmountCents: bigint;
  confidencePct: number;
  escalationReason: string;
  status: EscalatedClaimStatus;
  policyVersion: string;
  modelVersion: string;
  createdAt: bigint;
}

export interface LayerState {
  groundStations: boolean;
  satellitesAndRoutes: boolean;
  passTraffic: boolean;
  spaceWeather: boolean;
}

export type PlaybackSpeed = 1 | 4 | 16;

export const ClaimGate = {
  Auto: 'Auto',
  Escalated: 'Escalated',
} as const;
export type ClaimGate = (typeof ClaimGate)[keyof typeof ClaimGate];

export const DataIntegrityStatus = {
  Pass: 'Pass',
  Fail: 'Fail',
  Pending: 'Pending',
} as const;
export type DataIntegrityStatus = (typeof DataIntegrityStatus)[keyof typeof DataIntegrityStatus];

export interface Claim {
  id: string;
  customerName: string;
  amountClaimedCents: bigint;
  passId: bigint;
  createdAt: bigint;
}

export interface ClaimPass {
  id: bigint;
  claimId: string;
  stationLat: number;
  stationLon: number;
  stationName: string;
  satelliteNoradId: number;
  satelliteTle1: string;
  satelliteTle2: string;
  contactStartTime: bigint;
  signalLostTime: bigint;
  contactEndTime: bigint;
  maxElevationDeg: number;
}

export interface ClaimEvidence {
  claimId: string;
  dataIntegrityStatus: DataIntegrityStatus;
  estimatedLossCents: bigint;
  missingEvidenceCents: bigint;
}

export interface ClaimDecision {
  claimId: string;
  creditAmountCents: bigint;
  confidencePercent: number;
  gate: ClaimGate;
  rule: string;
  policyVersion: string;
  modelVersion: string;
  decidedAt: bigint;
}

export interface ClaimOutcome {
  claimId: string;
  creditMemoSent: boolean;
  ledgerPosted: boolean;
  completedAt: bigint | null;
}

export interface ClaimWeather {
  claimId: string;
  kpIndex: number;
  stormActive: boolean;
}

export interface ClaimReason {
  id: bigint;
  claimId: string;
  feature: string;
  detail: string;
  shapValue: number;
}

export const LedgerEntryType = {
  Credit: 'Credit',
  Invoice: 'Invoice',
  Recovery: 'Recovery',
} as const;
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export interface LedgerEntry {
  id: bigint;
  createdAt: bigint;
  entryType: LedgerEntryType;
  description: string;
  referenceId: string | null;
  amountCents: bigint;
}

export const PolicyStatus = {
  Proposed: 'Proposed',
  Current: 'Current',
  Retired: 'Retired',
} as const;
export type PolicyStatus = (typeof PolicyStatus)[keyof typeof PolicyStatus];

export const ReplayStatus = {
  Pending: 'Pending',
  Running: 'Running',
  Completed: 'Completed',
  Blocked: 'Blocked',
} as const;
export type ReplayStatus = (typeof ReplayStatus)[keyof typeof ReplayStatus];

export interface PolicyVersion {
  id: string;
  version: number;
  status: PolicyStatus;
  author: string;
  createdAt: bigint;
  decisionCount: bigint;
}

export interface CedarRule {
  id: string;
  policyVersionId: string;
  name: string;
  description: string;
  cedarCode: string;
  enabled: boolean;
  orderIndex: number;
}

export interface PolicyReplay {
  id: bigint;
  proposedVersionId: string;
  currentVersionId: string;
  status: ReplayStatus;
  totalClaims: number;
  currentClaim: number;
  precisionBefore: number;
  precisionAfter: number;
  decisionsChanged: number;
  dollarImpactCents: bigint;
  blockReason: string;
  createdAt: bigint;
  isPlaying: boolean;
  speedMultiplier: number;
}
