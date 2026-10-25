import * as satellite from 'satellite.js';

export interface Observer {
  id: string;
  latitude: number;
  longitude: number;
  altitudeM: number;
}

export interface PredictedPass {
  stationId: string;
  startMs: number;
  endMs: number;
  maxElevationDeg: number;
  /** Already above the mask at `fromMs`; `startMs` is then `fromMs`, not the true rise. */
  inProgress: boolean;
}

const MINUTE = 60_000;

/**
 * The next time the satellite rises above `minElevationDeg` at any observer, by
 * SGP4 in `stepMs` steps over the next `horizonMs`. A prediction from the TLE
 * alone: nothing is booked or priced.
 */
export function nextOverheadPass(
  tle1: string,
  tle2: string,
  observers: Observer[],
  fromMs: number,
  { minElevationDeg = 10, horizonMs = 12 * 60 * MINUTE, stepMs = 30_000 } = {},
): PredictedPass | null {
  let satrec: satellite.SatRec;
  try {
    satrec = satellite.twoline2satrec(tle1, tle2);
  } catch {
    return null;
  }
  const sites = observers.map(o => ({
    id: o.id,
    gd: { latitude: satellite.degreesToRadians(o.latitude), longitude: satellite.degreesToRadians(o.longitude), height: o.altitudeM / 1000 },
  }));
  const elevations = (t: number): number[] | null => {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv || typeof pv.position === 'boolean' || !pv.position) return null;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    return sites.map(s => satellite.ecfToLookAngles(s.gd, ecf).elevation * (180 / Math.PI));
  };

  for (let t = fromMs; t <= fromMs + horizonMs; t += stepMs) {
    const els = elevations(t);
    if (!els) continue;
    let best = -1;
    for (let i = 0; i < els.length; i++) if (els[i] >= minElevationDeg && (best < 0 || els[i] > els[best])) best = i;
    if (best < 0) continue;
    let end = t;
    let maxEl = els[best];
    for (let u = t + stepMs; u <= t + 30 * MINUTE; u += stepMs) {
      const el = elevations(u)?.[best];
      if (el === undefined || el < minElevationDeg) break;
      end = u;
      maxEl = Math.max(maxEl, el);
    }
    return { stationId: sites[best].id, startMs: t, endMs: end, maxElevationDeg: maxEl, inProgress: t === fromMs };
  }
  return null;
}

/** International designator from TLE line 1, e.g. "25157Z" → "2025-157Z". */
export function cosparId(line1: string): string | null {
  const m = /^(\d{2})(\d{3})(\S+)$/.exec(line1.slice(9, 17).trim());
  if (!m) return null;
  const yy = Number(m[1]);
  return `${yy < 57 ? 2000 + yy : 1900 + yy}-${m[2]}${m[3]}`;
}
