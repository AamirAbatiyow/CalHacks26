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

export interface LayerState {
  groundStations: boolean;
  satellitesAndRoutes: boolean;
  passTraffic: boolean;
  spaceWeather: boolean;
}

export type PlaybackSpeed = 1 | 4 | 16;

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
