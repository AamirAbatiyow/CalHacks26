import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';
import { cosparId, nextOverheadPass } from './passPrediction.ts';

// STARLINK-37215, 97.3° polar shell, epoch 2026-10-24.
const TLE1 = '1 68392U 26063N   26297.14416024  .00027070  00000+0  83729-3 0  9990';
const TLE2 = '2 68392  97.2899  77.5071 0000885 198.7890 161.3320 15.33464826 32906';
const SVALSAT = { id: 'svalsat', latitude: 78.2306, longitude: 15.3894, altitudeM: 450 };
const HARTEBEESTHOEK = { id: 'hartebeesthoek', latitude: -25.8872, longitude: 27.7075, altitudeM: 1415 };
const FROM = Date.parse('2026-10-24T12:00:00Z');

function elevation(t: number, o: typeof SVALSAT): number {
  const satrec = satellite.twoline2satrec(TLE1, TLE2);
  const date = new Date(t);
  const pv = satellite.propagate(satrec, date);
  if (typeof pv.position === 'boolean' || !pv.position) throw new Error('propagation failed');
  const gd = { latitude: satellite.degreesToRadians(o.latitude), longitude: satellite.degreesToRadians(o.longitude), height: o.altitudeM / 1000 };
  return satellite.ecfToLookAngles(gd, satellite.eciToEcf(pv.position, satellite.gstime(date))).elevation * (180 / Math.PI);
}

test('a polar Starlink rises over SvalSat within a couple of orbits', () => {
  const pass = nextOverheadPass(TLE1, TLE2, [SVALSAT], FROM);
  assert.ok(pass);
  assert.equal(pass.stationId, 'svalsat');
  assert.ok(pass.startMs >= FROM && pass.startMs < FROM + 3 * 3_600_000);
  assert.ok(pass.endMs >= pass.startMs && pass.endMs - pass.startMs < 15 * 60_000);
  assert.ok(pass.maxElevationDeg >= 10 && pass.maxElevationDeg <= 90);
  assert.ok(elevation(pass.startMs, SVALSAT) >= 10);
  if (!pass.inProgress) assert.ok(elevation(pass.startMs - 30_000, SVALSAT) < 10);
});

test('the earliest station wins and a higher mask finds a later or equal pass', () => {
  const both = nextOverheadPass(TLE1, TLE2, [HARTEBEESTHOEK, SVALSAT], FROM)!;
  const sval = nextOverheadPass(TLE1, TLE2, [SVALSAT], FROM)!;
  const hart = nextOverheadPass(TLE1, TLE2, [HARTEBEESTHOEK], FROM)!;
  assert.equal(both.startMs, Math.min(sval.startMs, hart.startMs));
  const high = nextOverheadPass(TLE1, TLE2, [SVALSAT], FROM, { minElevationDeg: 40 });
  if (high) assert.ok(high.startMs >= sval.startMs && high.maxElevationDeg >= 40);
});

test('no observers or a bad TLE gives no pass', () => {
  assert.equal(nextOverheadPass(TLE1, TLE2, [], FROM), null);
  assert.equal(nextOverheadPass('1 garbage', '2 garbage', [SVALSAT], FROM), null);
});

test('international designator from TLE line 1', () => {
  assert.equal(cosparId(TLE1), '2026-063N');
  assert.equal(cosparId('1 48672U 21044AL  26297.25002315  .00006184  00000+0  18297-3 0  9990'), '2021-044AL');
  assert.equal(cosparId('1 25544U 98067A   24297.91667824  .00016717  00000+0  30197-3 0  9991'), '1998-067A');
});
