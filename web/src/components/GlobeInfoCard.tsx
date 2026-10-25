import { forwardRef, useMemo, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Pass, Satellite, Station } from '../types';
import { PassStatus } from '../types';
import { auroralOval, geomagneticLatitude, inStormZone, stormLevel } from '../utils/storm';
import { FLEET_MULTIPLIER, satelliteBand, stationAntennas, stationOperator, tleOrbit } from '../utils/fleet';
import { MARKER_COLORS, satellitePosition } from './globeMarkers';
import { cosparId, nextOverheadPass } from '../utils/passPrediction';
import { STARLINK_SOURCE, starlinkShell, type StarlinkSatellite } from '../utils/starlink';
import './GlobeInfoCard.css';

export type GlobeSelection =
  | { kind: 'station'; id: string }
  | { kind: 'satellite'; id: number }
  | { kind: 'starlink'; id: number };

interface GlobeInfoCardProps {
  selection: GlobeSelection;
  stations: Station[];
  satellites: Satellite[];
  starlinks?: StarlinkSatellite[];
  passes: Pass[];
  kp: number;
  currentTime: bigint;
  onClose: () => void;
}

const DAY_MICROS = 86_400_000_000n;
const PT = 'America/Los_Angeles';

function usdCompact(cents: bigint | number): string {
  return (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
}

function ptDateTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: PT }) + ' PT';
}

function latLon(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gic-row">
      <span className="gic-label">{label}</span>
      <span className="gic-value">{children}</span>
    </div>
  );
}

function StationBody({ station, passes, kp, currentTime }: { station: Station; passes: Pass[]; kp: number; currentTime: bigint }) {
  const recent = useMemo(() => passes.filter(p => p.stationId === station.id
    && p.startTime <= currentTime && p.startTime > currentTime - DAY_MICROS && p.status !== PassStatus.Scheduled), [passes, station.id, currentTime]);
  const dropped = recent.filter(p => p.status === PassStatus.Dropped).length;
  const antennas = stationAntennas(station.id);
  const level = stormLevel(kp);
  const mlat = geomagneticLatitude(station.latitude, station.longitude);
  const exposed = inStormZone(station.latitude, station.longitude, kp);
  return (<>
    <Row label="ID"><code>{station.id}</code></Row>
    <Row label="Operator">{stationOperator(station.id)}</Row>
    <Row label="Location">{latLon(station.latitude, station.longitude)}</Row>
    <Row label="Altitude">{station.altitudeM.toLocaleString('en-US')} m</Row>
    <Row label="Antennas">{antennas ?? '—'}</Row>
    <Row label="Passes, last 24 h">{recent.length.toLocaleString('en-US')}{dropped > 0 && <span className="gic-warn"> · {dropped} dropped</span>}</Row>
    <Row label="Revenue this month">{usdCompact(station.monthlyRevenueCents)}</Row>
    <Row label="Storm exposure">
      {level ? (
        exposed
          ? <span style={{ color: level.color }}>Inside G{level.g} zone · {Math.abs(mlat).toFixed(1)}° mag. lat</span>
          : <>Outside G{level.g} zone · {Math.abs(mlat).toFixed(1)}° mag. lat (edge {auroralOval(kp).equatorward.toFixed(0)}°)</>
      ) : <>None · Kp {kp.toFixed(1)}</>}
    </Row>
  </>);
}

function OrbitRows({ line1, line2 }: { line1: string; line2: string }) {
  const orbit = useMemo(() => tleOrbit(line1, line2), [line1, line2]);
  if (!orbit) return null;
  return (<>
    <Row label="TLE epoch">{orbit.epoch.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} UTC</Row>
    <Row label="Orbit">{orbit.inclinationDeg.toFixed(1)}° incl · {orbit.periodMin.toFixed(1)} min</Row>
    <Row label="Altitude">
      {Math.abs(orbit.apogeeKm - orbit.perigeeKm) < 20
        ? `${Math.round((orbit.apogeeKm + orbit.perigeeKm) / 2)} km`
        : `${Math.round(orbit.perigeeKm)} × ${Math.round(orbit.apogeeKm)} km`}
    </Row>
  </>);
}

function SatelliteBody({ sat, stations, passes, currentTime }: { sat: Satellite; stations: Station[]; passes: Pass[]; currentTime: bigint }) {
  const band = satelliteBand(sat.noradId);
  const pass = useMemo(() => {
    let current: Pass | null = null;
    let next: Pass | null = null;
    let last: Pass | null = null;
    for (const p of passes) {
      if (p.satelliteId !== sat.noradId) continue;
      if (p.startTime <= currentTime && p.endTime > currentTime) current = p;
      else if (p.startTime > currentTime) { if (!next || p.startTime < next.startTime) next = p; }
      else if (!last || p.endTime > last.endTime) last = p;
    }
    return current ? { label: 'In contact', p: current } : next ? { label: 'Next pass', p: next } : last ? { label: 'Last pass', p: last } : null;
  }, [passes, sat.noradId, currentTime]);
  const passStation = pass && stations.find(s => s.id === pass.p.stationId);
  return (<>
    <Row label="NORAD ID"><code>{sat.noradId}</code></Row>
    <Row label="Operator">{sat.operator}</Row>
    <Row label="Band · price">
      {band ? <>{band.band === 'wideband' ? 'Wideband' : 'Narrowband'} · ${(band.centsPerMinute / 100).toFixed(0)}/min{FLEET_MULTIPLIER > 1 && <span className="gic-muted"> (billed ×{FLEET_MULTIPLIER})</span>}</> : '—'}
    </Row>
    <OrbitRows line1={sat.tleLine1} line2={sat.tleLine2} />
    <Row label={pass?.label ?? 'Passes'}>
      {pass ? (<>
        {passStation?.name ?? pass.p.stationId} · {ptDateTime(pass.p.startTime)}
        <span className="gic-muted"> · max {pass.p.maxElevationDeg.toFixed(0)}°</span>
        {pass.p.status === PassStatus.Dropped && <span className="gic-warn"> · dropped</span>}
      </>) : 'None booked'}
    </Row>
  </>);
}

function StarlinkBody({ sat, stations, currentTime }: { sat: StarlinkSatellite; stations: Station[]; currentTime: bigint }) {
  const orbit = useMemo(() => tleOrbit(sat.tleLine1, sat.tleLine2), [sat]);
  const nowMs = Number(currentTime / 1000n);
  const minute = Math.floor(nowMs / 60_000);
  const pass = useMemo(() => nextOverheadPass(
    sat.tleLine1, sat.tleLine2,
    stations.map(s => ({ id: s.id, latitude: s.latitude, longitude: s.longitude, altitudeM: s.altitudeM })),
    minute * 60_000,
  ), [sat, stations, minute]);
  const here = satellitePosition(sat.tleLine1, sat.tleLine2, new Date(nowMs));
  const passStation = pass && stations.find(s => s.id === pass.stationId);
  const cospar = cosparId(sat.tleLine1);
  return (<>
    <Row label="NORAD ID"><code>{sat.noradId}</code>{cospar && <span className="gic-muted"> · {cospar}</span>}</Row>
    <Row label="Operator">SpaceX</Row>
    <Row label="Constellation">Starlink{orbit && <span className="gic-muted"> · {starlinkShell(orbit.inclinationDeg)}</span>}</Row>
    <OrbitRows line1={sat.tleLine1} line2={sat.tleLine2} />
    {here && <Row label="Over">{latLon(here.lat, here.lon)}</Row>}
    <Row label={pass?.inProgress ? 'Overhead now' : 'Next overhead'}>
      {pass ? (<>
        {passStation?.name ?? pass.stationId}{!pass.inProgress && <> · {ptDateTime(BigInt(pass.startMs) * 1000n)}</>}
        <span className="gic-muted"> · max {pass.maxElevationDeg.toFixed(0)}°</span>
      </>) : <span className="gic-muted">None in the next 12 h</span>}
    </Row>
    <Row label="Billing"><span className="gic-muted">Not a customer · no passes booked</span></Row>
    <div className="gic-source">
      TLE via <a href={STARLINK_SOURCE.tleUrl} target="_blank" rel="noreferrer">CelesTrak</a>, listed operational in
      SpaceX's <a href={STARLINK_SOURCE.ephemeridesUrl} target="_blank" rel="noreferrer">Starlink public ephemerides</a>.
      Next overhead is an SGP4 prediction over our stations at 10° or more.
    </div>
  </>);
}

export const GlobeInfoCard = forwardRef<HTMLDivElement, GlobeInfoCardProps>(function GlobeInfoCard(
  { selection, stations, satellites, starlinks = [], passes, kp, currentTime, onClose }, ref,
) {
  const station = selection.kind === 'station' ? stations.find(s => s.id === selection.id) : undefined;
  const sat = selection.kind === 'satellite' ? satellites.find(s => s.noradId === selection.id) : undefined;
  const starlink = selection.kind === 'starlink' ? starlinks.find(s => s.noradId === selection.id) : undefined;
  if (starlink) {
    return (
      <div ref={ref} className="globe-info-card" role="dialog" aria-label={starlink.name}>
        <div className="gic-head">
          <span className="gic-icon starlink" style={{ background: MARKER_COLORS.starlink }} />
          <div className="gic-title">
            <span>{starlink.name}</span>
            <small>Starlink satellite</small>
          </div>
          <span className="gic-badge" style={{ color: MARKER_COLORS.starlink, borderColor: `${MARKER_COLORS.starlink}80`, background: `${MARKER_COLORS.starlink}1f` }}>SpaceX</span>
          <button className="gic-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="gic-body">
          <StarlinkBody sat={starlink} stations={stations} currentTime={currentTime} />
        </div>
      </div>
    );
  }
  if (!station && !sat) return null;
  return (
    <div ref={ref} className="globe-info-card" role="dialog" aria-label={station?.name ?? sat?.name}>
      <div className="gic-head">
        <span className={`gic-icon ${station ? 'station' : 'satellite'}`} style={station ? { borderBottomColor: MARKER_COLORS.station } : undefined} />
        <div className="gic-title">
          <span>{station?.name ?? sat?.name}</span>
          <small>{station ? 'Ground station' : 'Satellite'}</small>
        </div>
        <button className="gic-close" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      <div className="gic-body">
        {station && <StationBody station={station} passes={passes} kp={kp} currentTime={currentTime} />}
        {sat && <SatelliteBody sat={sat} stations={stations} passes={passes} currentTime={currentTime} />}
      </div>
    </div>
  );
});
