// Finds the most recent real pass of a satellite over a ground station during the
// fixture geomagnetic storm (SGP4 via satellite.js from the web app) and prints it
// as JSON for seed.sh.
// Usage: node find-claim-pass.mjs <satellites.json> <stations.json> <norad_id> <station_id>
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../web/package.json'));
const satellite = require('satellite.js');

const [satFile, stationFile, noradId, stationId] = process.argv.slice(2);
const sat = JSON.parse(readFileSync(satFile, 'utf8')).find(s => String(s.norad_id) === noradId);
const station = JSON.parse(readFileSync(stationFile, 'utf8')).find(s => s.id === stationId);
if (!sat || !station) throw new Error(`unknown satellite ${noradId} or station ${stationId}`);

const satrec = satellite.twoline2satrec(sat.tle_line1, sat.tle_line2);
const observer = {
  latitude: satellite.degreesToRadians(station.latitude),
  longitude: satellite.degreesToRadians(station.longitude),
  height: station.altitude_m / 1000,
};

function elevationDeg(ms) {
  const date = new Date(ms);
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return -90;
  const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
  return satellite.radiansToDegrees(satellite.ecfToLookAngles(observer, ecf).elevation);
}

const STEP_MS = 15_000;
const now = Date.now();
let best = null;
let current = null;
// The space_weather fixture's storm (Kp >= 5) runs from 17h to 10h before seeding;
// the window is padded so a pass that starts near its edges can still finish.
for (let t = now - 17.5 * 3600_000; t <= now - 9.5 * 3600_000; t += STEP_MS) {
  const el = elevationDeg(t);
  if (el > 0) {
    current ??= { start: t, maxEl: el };
    current.maxEl = Math.max(current.maxEl, el);
    current.end = t;
  } else if (current) {
    const lost = current.start + (current.end - current.start) * 0.42;
    const inStorm = lost >= now - 17 * 3600_000 && lost <= now - 10 * 3600_000;
    if (inStorm && current.end - current.start > 6 * 60_000 && current.maxEl > (best?.maxEl ?? 8)) best = current;
    current = null;
  }
}
if (!best) throw new Error('no qualifying pass found');

const toMicros = ms => Math.round(ms * 1000);
const signalLost = best.start + Math.round((best.end - best.start) * 0.42);
console.log(JSON.stringify({
  norad_id: sat.norad_id,
  tle1: sat.tle_line1,
  tle2: sat.tle_line2,
  station_name: station.name,
  latitude: station.latitude,
  longitude: station.longitude,
  start_micros: toMicros(best.start),
  signal_lost_micros: toMicros(signalLost),
  end_micros: toMicros(best.end),
  max_elevation_deg: Math.round(best.maxEl * 10) / 10,
}));
