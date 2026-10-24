import type { Pass, SpaceWeather, Station } from '../types';
import { PassStatus } from '../types';

export interface StormLevel {
  g: 1 | 2 | 3 | 4 | 5;
  kp: number;
  name: string;
  color: string;
}

/** NOAA space weather G-scale. Kp 5 is G1 through Kp 9 for G5. */
export const STORM_LEVELS: readonly StormLevel[] = [
  { g: 1, kp: 5, name: 'Minor', color: '#facc15' },
  { g: 2, kp: 6, name: 'Moderate', color: '#fb923c' },
  { g: 3, kp: 7, name: 'Strong', color: '#ef4444' },
  { g: 4, kp: 8, name: 'Severe', color: '#be123c' },
  { g: 5, kp: 9, name: 'Extreme', color: '#d946ef' },
];

/**
 * G-level for a Kp reading, or null below storm level. Kp is reported in thirds
 * (6.7 is "7-"), and NOAA counts 7-, 7 and 7+ as Kp 7, so the reading is rounded;
 * the storm threshold stays at Kp 5 like the module's.
 */
export function stormLevel(kp: number): StormLevel | null {
  if (!(kp >= 5)) return null;
  return STORM_LEVELS[Math.min(4, Math.max(0, Math.round(kp) - 5))];
}

export function stormLabel(kp: number): string | null {
  const level = stormLevel(kp);
  return level ? `G${level.g} ${level.name} · Kp ${kp.toFixed(1)}` : null;
}

/** Geomagnetic north pole (IGRF-14 dipole, 2025). */
export const GEOMAGNETIC_POLE = { lat: 80.8, lon: -72.6 };

/**
 * Auroral oval edges in geomagnetic latitude for a Kp reading: the equatorward
 * edge moves toward the equator about 2.2° per Kp step (about 55° at Kp 5, 46° at
 * Kp 9), the poleward edge much less.
 */
export function auroralOval(kp: number): { equatorward: number; poleward: number } {
  return { equatorward: 66 - 2.2 * kp, poleward: 75 - 0.8 * kp };
}

const RAD = Math.PI / 180;

function unit(lat: number, lon: number): [number, number, number] {
  return [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
}

/** Geomagnetic latitude of a geographic point (centered dipole). */
export function geomagneticLatitude(lat: number, lon: number): number {
  const p = unit(lat, lon);
  const d = unit(GEOMAGNETIC_POLE.lat, GEOMAGNETIC_POLE.lon);
  return Math.asin(Math.max(-1, Math.min(1, p[0] * d[0] + p[1] * d[1] + p[2] * d[2]))) / RAD;
}

/** Geographic lat/lon of a point given in geomagnetic coordinates. */
export function fromGeomagnetic(mlat: number, mlon: number): { lat: number; lon: number } {
  const [x, y, z] = unit(mlat, mlon);
  const tilt = (90 - GEOMAGNETIC_POLE.lat) * RAD;
  const xr = x * Math.cos(tilt) + z * Math.sin(tilt);
  const zr = -x * Math.sin(tilt) + z * Math.cos(tilt);
  const spin = GEOMAGNETIC_POLE.lon * RAD;
  const xg = xr * Math.cos(spin) - y * Math.sin(spin);
  const yg = xr * Math.sin(spin) + y * Math.cos(spin);
  return { lat: Math.asin(Math.max(-1, Math.min(1, zr))) / RAD, lon: Math.atan2(yg, xg) / RAD };
}

/** Whether a station sits in the storm's affected zone: the auroral oval or the polar cap inside it. */
export function inStormZone(lat: number, lon: number, kp: number): boolean {
  return stormLevel(kp) !== null && Math.abs(geomagneticLatitude(lat, lon)) >= auroralOval(kp).equatorward;
}

export interface StormInterval {
  start: bigint;
  end: bigint;
  level: StormLevel;
  peakKp: number;
}

/** Contiguous runs of readings at the same G-level; each reading covers half the gap to its neighbours. */
export function stormIntervals(weather: SpaceWeather[]): StormInterval[] {
  const sorted = [...weather].sort((a, b) => Number(a.timestamp - b.timestamp));
  const out: StormInterval[] = [];
  sorted.forEach((w, i) => {
    const level = stormLevel(w.kpIndex);
    if (!level) return;
    const prev = sorted[i - 1]?.timestamp ?? w.timestamp - 1_800_000_000n;
    const next = sorted[i + 1]?.timestamp ?? w.timestamp + 1_800_000_000n;
    const start = (prev + w.timestamp) / 2n;
    const end = (w.timestamp + next) / 2n;
    const last = out[out.length - 1];
    if (last && last.level.g === level.g && last.end === start) {
      last.end = end;
      last.peakKp = Math.max(last.peakKp, w.kpIndex);
    } else {
      out.push({ start, end, level, peakKp: w.kpIndex });
    }
  });
  return out;
}

/** A pass is degraded when it dropped or its station sits inside the storm zone. */
export function isDegraded(pass: Pass, station: Station | undefined, kp: number): boolean {
  return pass.status === PassStatus.Dropped || (!!station && inStormZone(station.latitude, station.longitude, kp));
}
