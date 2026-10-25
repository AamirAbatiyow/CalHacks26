import fixture from '../../../server/fixtures/starlink.json';

/**
 * A fixed sample of operational Starlinks shown on the Overview globe, read from
 * `server/fixtures/starlink.json` (refreshed by `server/scripts/refresh-starlink.mjs`).
 * Display only: they are not in the module's `satellite` table, have no contract
 * and are never booked or billed.
 */
export interface StarlinkSatellite {
  noradId: number;
  name: string;
  tleLine1: string;
  tleLine2: string;
}

export const STARLINK_SATELLITES: StarlinkSatellite[] = fixture.satellites.map(s => ({
  noradId: s.norad_id,
  name: s.name,
  tleLine1: s.tle_line1,
  tleLine2: s.tle_line2,
}));

export const STARLINK_SOURCE = {
  tleUrl: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink',
  ephemeridesUrl: 'https://api.starlink.com/public-files/ephemerides/',
  refreshedAt: new Date(fixture.source.refreshed_at),
};

/** Starlink's orbital shells by inclination. */
export function starlinkShell(inclinationDeg: number): string {
  if (inclinationDeg > 95) return `${inclinationDeg.toFixed(0)}° polar shell`;
  return `${inclinationDeg.toFixed(0)}° shell`;
}
