import type { Pass } from '../types';

const now = new Date();
const hour = 60 * 60 * 1000;

function hoursAgo(h: number): Date {
  return new Date(now.getTime() - h * hour);
}

function hoursFromNow(h: number): Date {
  return new Date(now.getTime() + h * hour);
}

export const mockPasses: Pass[] = [
  // Recent/active passes
  {
    id: 'pass-001',
    satelliteId: 25544,
    stationId: 'svalbard',
    start: hoursAgo(0.2),
    end: hoursFromNow(0.1),
    status: 'ok',
    revenue: 12500,
  },
  {
    id: 'pass-002',
    satelliteId: 43013,
    stationId: 'antarctica',
    start: hoursAgo(1),
    end: hoursAgo(0.8),
    status: 'ok',
    revenue: 8900,
  },
  {
    id: 'pass-003',
    satelliteId: 39084,
    stationId: 'athens',
    start: hoursAgo(2),
    end: hoursAgo(1.8),
    status: 'dropped',
    revenue: 15200,
  },
  {
    id: 'pass-004',
    satelliteId: 49260,
    stationId: 'singapore',
    start: hoursAgo(3),
    end: hoursAgo(2.7),
    status: 'ok',
    revenue: 22000,
  },
  {
    id: 'pass-005',
    satelliteId: 41866,
    stationId: 'dubai',
    start: hoursAgo(4),
    end: hoursAgo(3.8),
    status: 'ok',
    revenue: 9800,
  },
  {
    id: 'pass-006',
    satelliteId: 36508,
    stationId: 'svalbard',
    start: hoursAgo(5),
    end: hoursAgo(4.7),
    status: 'dropped',
    revenue: 18500,
  },
  {
    id: 'pass-007',
    satelliteId: 27424,
    stationId: 'bangalore',
    start: hoursAgo(6),
    end: hoursAgo(5.8),
    status: 'ok',
    revenue: 7200,
  },
  {
    id: 'pass-008',
    satelliteId: 28654,
    stationId: 'mauritius',
    start: hoursAgo(8),
    end: hoursAgo(7.7),
    status: 'ok',
    revenue: 6100,
  },
  {
    id: 'pass-009',
    satelliteId: 25544,
    stationId: 'punta-arenas',
    start: hoursAgo(10),
    end: hoursAgo(9.8),
    status: 'dropped',
    revenue: 11300,
  },
  {
    id: 'pass-010',
    satelliteId: 43013,
    stationId: 'hartebeesthoek',
    start: hoursAgo(12),
    end: hoursAgo(11.8),
    status: 'ok',
    revenue: 8400,
  },
  {
    id: 'pass-011',
    satelliteId: 39084,
    stationId: 'alaska',
    start: hoursAgo(14),
    end: hoursAgo(13.7),
    status: 'ok',
    revenue: 19800,
  },
  {
    id: 'pass-012',
    satelliteId: 49260,
    stationId: 'svalbard',
    start: hoursAgo(16),
    end: hoursAgo(15.6),
    status: 'ok',
    revenue: 24100,
  },
  {
    id: 'pass-013',
    satelliteId: 41866,
    stationId: 'antarctica',
    start: hoursAgo(18),
    end: hoursAgo(17.7),
    status: 'dropped',
    revenue: 13700,
  },
  {
    id: 'pass-014',
    satelliteId: 36508,
    stationId: 'athens',
    start: hoursAgo(20),
    end: hoursAgo(19.8),
    status: 'ok',
    revenue: 5900,
  },
  {
    id: 'pass-015',
    satelliteId: 27424,
    stationId: 'singapore',
    start: hoursAgo(22),
    end: hoursAgo(21.5),
    status: 'ok',
    revenue: 16200,
  },
];

export function getPassesInTimeRange(start: Date, end: Date): Pass[] {
  return mockPasses.filter(
    (pass) => pass.end >= start && pass.start <= end
  );
}

export function getActivePassesAtTime(time: Date): Pass[] {
  return mockPasses.filter(
    (pass) => pass.start <= time && pass.end >= time
  );
}
