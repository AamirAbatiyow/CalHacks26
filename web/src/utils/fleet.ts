import stationFixtures from '../../../server/fixtures/stations.json';
import satelliteFixtures from '../../../server/fixtures/satellites.json';
import contracts from '../../../server/fixtures/contracts.json';

/**
 * Seed facts the module's `station` and `satellite` tables do not store (antenna
 * count, band and price), read from the same fixtures `seed.sh` loads.
 */
const antennas = new Map(stationFixtures.map(s => [s.id, s.antennas]));
const bands = new Map(satelliteFixtures.map(s => [s.norad_id, s.band]));

export const FLEET_MULTIPLIER: number = contracts.fleet_multiplier ?? 1;

export function stationAntennas(id: string): number | null {
  return antennas.get(id) ?? null;
}

/** Network operator: the AWS Ground Station sites are AWS's; the rest are KSAT's. */
export function stationOperator(id: string): string {
  return id.startsWith('aws-') ? 'AWS Ground Station' : 'KSAT';
}

export function satelliteBand(noradId: number): { band: string; centsPerMinute: number } | null {
  const band = bands.get(noradId);
  if (!band) return null;
  const centsPerMinute = band === 'wideband' ? contracts.pricing.wideband_cents_per_minute : contracts.pricing.narrowband_cents_per_minute;
  return { band, centsPerMinute };
}

const MU_KM3_S2 = 398600.4418;
const EARTH_RADIUS_KM = 6378.137;

export interface TleOrbit {
  epoch: Date;
  inclinationDeg: number;
  periodMin: number;
  perigeeKm: number;
  apogeeKm: number;
}

/** Epoch and mean orbital elements straight from the TLE's fixed columns. */
export function tleOrbit(line1: string, line2: string): TleOrbit | null {
  const yy = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  const inclinationDeg = Number(line2.slice(8, 16));
  const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`);
  const revsPerDay = Number(line2.slice(52, 63));
  if (![yy, day, inclinationDeg, eccentricity, revsPerDay].every(Number.isFinite) || revsPerDay <= 0) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const epoch = new Date(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
  const n = (revsPerDay * 2 * Math.PI) / 86_400;
  const a = Math.cbrt(MU_KM3_S2 / (n * n));
  return {
    epoch,
    inclinationDeg,
    periodMin: 1440 / revsPerDay,
    perigeeKm: a * (1 - eccentricity) - EARTH_RADIUS_KM,
    apogeeKm: a * (1 + eccentricity) - EARTH_RADIUS_KM,
  };
}
