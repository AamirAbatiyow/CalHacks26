export const AttackType = {
  InflatedClaim: 'InflatedClaim',
  DuplicateClaim: 'DuplicateClaim',
  ForgedStationLog: 'ForgedStationLog',
  InsiderRaisesOwnLimit: 'InsiderRaisesOwnLimit',
  SpaceWeatherExcuse: 'SpaceWeatherExcuse',
  ContractOutsideSla: 'ContractOutsideSla',
  MessyData: 'MessyData',
  ModelStress: 'ModelStress',
  Recovery: 'Recovery',
} as const;
export type AttackType = (typeof AttackType)[keyof typeof AttackType];

export const AttackResult = {
  Pending: 'Pending',
  Caught: 'Caught',
  Missed: 'Missed',
} as const;
export type AttackResult = (typeof AttackResult)[keyof typeof AttackResult];

export interface AttackRun {
  id: bigint;
  runId: bigint;
  attackType: AttackType;
  result: AttackResult;
  amountCents: bigint;
  timestamp: bigint;
  logMessage: string;
  attackerIdentity: string | null;
}

export interface AttackRunSession {
  id: bigint;
  startedAt: bigint;
  completedAt: bigint | null;
  totalAttacks: number;
  caught: number;
  missed: number;
  dollarsProtectedCents: bigint;
  badPayoutsCents: bigint;
}

export interface AttackFixture {
  id: bigint;
  attackType: AttackType;
  amountCents: bigint;
  description: string;
  attackParams: string;
}

export const ATTACK_TYPE_LABELS: Record<AttackType, string> = {
  InflatedClaim: 'Inflated claim',
  DuplicateClaim: 'Duplicate claim',
  ForgedStationLog: 'Forged station log',
  InsiderRaisesOwnLimit: 'Insider raises own limit',
  SpaceWeatherExcuse: 'Space weather excuse',
  ContractOutsideSla: 'Contract outside SLA',
  MessyData: 'Messy data',
  ModelStress: 'Model stress',
  Recovery: 'Recovery',
};

export const ATTACK_TYPE_CODES: Record<AttackType, number> = {
  InflatedClaim: 0,
  DuplicateClaim: 1,
  ForgedStationLog: 2,
  InsiderRaisesOwnLimit: 3,
  SpaceWeatherExcuse: 4,
  ContractOutsideSla: 5,
  MessyData: 6,
  ModelStress: 7,
  Recovery: 8,
};

export const ATTACK_TYPES_ORDER: AttackType[] = [
  AttackType.InflatedClaim,
  AttackType.DuplicateClaim,
  AttackType.ForgedStationLog,
  AttackType.InsiderRaisesOwnLimit,
  AttackType.SpaceWeatherExcuse,
  AttackType.ContractOutsideSla,
  AttackType.MessyData,
  AttackType.ModelStress,
  AttackType.Recovery,
];
