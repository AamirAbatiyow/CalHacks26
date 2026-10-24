// Builds the seeded pass history for seed.sh from the fixtures:
//   - every contracted satellite's real contacts (SGP4 via satellite.js) over the
//     last `history_days` and the next `schedule_ahead_hours`, booked best-elevation
//     first within its contract's daily quota and each station's antenna count;
//   - the hand-written passes in passes.json (Break It and Overview reference them);
//   - the Claim page's NOAA-20 pass (find-claim-pass.mjs).
// Every pass is priced at AWS Ground Station on-demand rates per started minute,
// times the fleet multiplier, and each station's monthly revenue is the sum of its
// billed passes.
// Usage: node generate-passes.mjs <fixtures_dir> <now_micros>  (JSON on stdout)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../web/package.json'));
const satellite = require('satellite.js');

const [fixturesDir, nowArg] = process.argv.slice(2);
const read = name => JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
const stations = read('stations.json');
const satellites = read('satellites.json');
const curated = read('passes.json');
const weather = read('space_weather.json');
const config = read('contracts.json');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const nowMs = Math.floor(Number(nowArg) / 1000);
const STATUS = { scheduled: 0, active: 1, ok: 2, dropped: 3 };

// Deterministic PRNG so the same fixtures give the same drops.
let seed = 0x6a7e5;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const satById = new Map(satellites.map(s => [s.norad_id, s]));
const stationById = new Map(stations.map(s => [s.id, s]));
const rate = noradId =>
  satById.get(noradId)?.band === 'narrowband'
    ? config.pricing.narrowband_cents_per_minute
    : config.pricing.wideband_cents_per_minute;
// Each generated pass row stands for `fleet_multiplier` contacts of the operator's
// full network (see contracts.json), so revenue scales without multiplying rows.
const fleetMultiplier = config.fleet_multiplier ?? 1;
const price = (noradId, startMs, endMs) => Math.ceil((endMs - startMs) / MINUTE) * rate(noradId) * fleetMultiplier;

const stormWindows = weather
  .filter(w => w.kp_index >= 5)
  .map(w => [nowMs + (w.offset_minutes - 30) * MINUTE, nowMs + (w.offset_minutes + 30) * MINUTE]);
const inStorm = ms => stormWindows.some(([a, b]) => ms >= a && ms <= b);

function statusFor(stationId, startMs, endMs) {
  if (startMs > nowMs) return STATUS.scheduled;
  if (endMs > nowMs) return STATUS.active;
  const station = stationById.get(stationId);
  const stormy = Math.abs(station.latitude) >= config.storm_min_abs_latitude_deg && inStorm(startMs);
  return random() < (stormy ? config.storm_drop_rate : config.drop_rate) ? STATUS.dropped : STATUS.ok;
}

// --- Contacts of every contracted satellite ---------------------------------

const observers = stations.map(s => ({
  id: s.id,
  antennas: s.antennas,
  gd: {
    latitude: satellite.degreesToRadians(s.latitude),
    longitude: satellite.degreesToRadians(s.longitude),
    height: s.altitude_m / 1000,
  },
}));
const windowStart = nowMs - config.history_days * DAY;
const windowEnd = nowMs + config.schedule_ahead_hours * 60 * MINUTE;

function contactsOf(noradId) {
  const sat = satById.get(noradId);
  const satrec = satellite.twoline2satrec(sat.tle_line1, sat.tle_line2);
  const open = new Map();
  const found = [];
  const close = (id, c) => {
    if (c.end - c.start >= config.min_contact_minutes * MINUTE) found.push({ noradId, stationId: id, ...c });
    open.delete(id);
  };
  for (let t = windowStart; t <= windowEnd; t += MINUTE) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
    for (const o of observers) {
      const el = satellite.radiansToDegrees(satellite.ecfToLookAngles(o.gd, ecf).elevation);
      const c = open.get(o.id);
      if (el >= config.min_elevation_deg) {
        if (c) {
          c.end = t;
          c.maxEl = Math.max(c.maxEl, el);
        } else {
          open.set(o.id, { start: t, end: t, maxEl: el });
        }
      } else if (c) {
        close(o.id, c);
      }
    }
  }
  for (const [id, c] of open) close(id, c);
  return found;
}

// --- Booking -----------------------------------------------------------------

const quota = new Map();
for (const contract of config.contracts) {
  for (const id of contract.norad_ids) quota.set(id, contract.contacts_per_satellite_per_day);
}
const candidates = [...quota.keys()].flatMap(contactsOf).sort((a, b) => b.maxEl - a.maxEl);

const SLEW_GAP = 5 * MINUTE;
const satBookings = new Map();
const stationBookings = new Map();
const perDay = new Map();
const overlaps = (list, c, gap) => list.filter(b => c.start < b.end + gap && b.start < c.end + gap).length;
const booked = [];
for (const c of candidates) {
  const dayKey = `${c.noradId}:${Math.floor((c.start - windowStart) / DAY)}`;
  if ((perDay.get(dayKey) ?? 0) >= quota.get(c.noradId)) continue;
  const mine = satBookings.get(c.noradId) ?? [];
  if (overlaps(mine, c, SLEW_GAP) > 0) continue;
  const atStation = stationBookings.get(c.stationId) ?? [];
  if (overlaps(atStation, c, 0) >= stationById.get(c.stationId).antennas) continue;
  mine.push(c);
  atStation.push(c);
  satBookings.set(c.noradId, mine);
  stationBookings.set(c.stationId, atStation);
  perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);
  booked.push(c);
}
booked.sort((a, b) => a.start - b.start);

// --- Claim pass ----------------------------------------------------------------

function claimPass() {
  try {
    const out = execFileSync(process.execPath, [
      path.join(here, 'find-claim-pass.mjs'),
      path.join(fixturesDir, 'satellites.json'),
      path.join(fixturesDir, 'stations.json'),
      '43013',
      'svalsat',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch {
    const sat = satById.get(43013);
    const station = stationById.get('svalsat');
    const start = nowMs - 840 * MINUTE;
    return {
      norad_id: 43013,
      tle1: sat.tle_line1,
      tle2: sat.tle_line2,
      station_name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      start_micros: start * 1000,
      signal_lost_micros: (start + 5 * MINUTE) * 1000,
      end_micros: (start + 12 * MINUTE) * 1000,
      max_elevation_deg: 41.0,
    };
  }
}
const claim = claimPass();
const claimStart = Math.round(claim.start_micros / 1000);
const claimEnd = Math.round(claim.end_micros / 1000);
claim.station_id = 'svalsat';
claim.revenue_cents = price(43013, claimStart, claimEnd);

// --- Output --------------------------------------------------------------------

const row = (noradId, stationId, startMs, endMs, status, maxEl) => ({
  sat_id: noradId,
  station_id: stationId,
  start_micros: startMs * 1000,
  end_micros: endMs * 1000,
  status,
  max_el: Math.round(maxEl * 10) / 10,
  revenue: price(noradId, startMs, endMs),
});

const passes = [
  ...curated.map(p => {
    const start = nowMs + p.start_offset_minutes * MINUTE;
    return row(p.satellite_id, p.station_id, start, start + p.duration_minutes * MINUTE, p.status, p.max_elevation_deg);
  }),
  row(43013, 'svalsat', claimStart, claimEnd, STATUS.ok, claim.max_elevation_deg),
  ...booked.map(c => row(c.noradId, c.stationId, c.start, c.end + MINUTE, statusFor(c.stationId, c.start, c.end + MINUTE), c.maxEl)),
];

const monthStart = nowMs - 30 * DAY;
const revenue = new Map(stations.map(s => [s.id, 0]));
for (const p of passes) {
  const start = p.start_micros / 1000;
  if (p.status !== STATUS.scheduled && start >= monthStart && start <= nowMs) {
    revenue.set(p.station_id, revenue.get(p.station_id) + p.revenue);
  }
}

process.stdout.write(JSON.stringify({
  stations: stations.map(s => ({ ...s, monthly_revenue_cents: revenue.get(s.id) })),
  passes,
  claim_pass: claim,
}));
