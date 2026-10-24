import { useMemo } from 'react';
import * as THREE from 'three';
import type { Pass, Station, Satellite } from '../../types';
import { latLonToVector3 } from '../../utils/geo';
import { propagateSatellite } from '../../utils/satellite';

interface PassTrafficLayerProps {
  passes: Pass[];
  stations: Station[];
  satellites: Satellite[];
  currentTime: Date;
  visible: boolean;
  globeRadius: number;
}

const OK_COLOR = 0xffffff;
const DROPPED_COLOR = 0xf59e0b;
const ALTITUDE_SCALE = 0.001;

/**
 * Create a pass traffic line connecting station to satellite
 */
function createPassLine(
  pass: Pass,
  station: Station,
  satellite: Satellite,
  currentTime: Date,
  globeRadius: number
): THREE.Group | null {
  const satPosition = propagateSatellite(satellite.tle1, satellite.tle2, currentTime);
  if (!satPosition) return null;

  const group = new THREE.Group();
  group.name = `pass-${pass.id}`;

  const stationElevation = 0.02;
  const [sx, sy, sz] = latLonToVector3(
    station.lat,
    station.lon,
    globeRadius * (1 + stationElevation)
  );

  const scaledAltitude = globeRadius + satPosition.altitude * ALTITUDE_SCALE;
  const [satX, satY, satZ] = latLonToVector3(
    satPosition.lat,
    satPosition.lon,
    scaledAltitude
  );

  const points = [
    new THREE.Vector3(sx, sy, sz),
    new THREE.Vector3(satX, satY, satZ),
  ];

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const color = pass.status === 'ok' ? OK_COLOR : DROPPED_COLOR;

  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.8,
  });

  const line = new THREE.Line(geometry, material);
  line.userData = { pass, type: 'pass-line' };
  group.add(line);

  if (pass.status === 'ok') {
    const glowMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.2,
    });
    const glowLine = new THREE.Line(geometry.clone(), glowMaterial);
    group.add(glowLine);
  }

  group.userData = { pass, station, satellite, type: 'pass-traffic' };
  return group;
}

/**
 * Create a Three.js group containing all active pass traffic lines
 */
export function createPassTrafficGroup(
  passes: Pass[],
  stations: Station[],
  satellites: Satellite[],
  currentTime: Date,
  globeRadius: number
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'pass-traffic';

  const currentMs = currentTime.getTime();
  const activePasses = passes.filter((pass) => {
    const startMs = pass.start.getTime();
    const endMs = pass.end.getTime();
    return startMs <= currentMs && currentMs <= endMs;
  });

  const stationMap = new Map<string, Station>();
  stations.forEach((s) => stationMap.set(s.id, s));

  const satelliteMap = new Map<number, Satellite>();
  satellites.forEach((s) => satelliteMap.set(s.noradId, s));

  activePasses.forEach((pass) => {
    const station = stationMap.get(pass.stationId);
    const satellite = satelliteMap.get(pass.satelliteId);

    if (!station || !satellite) return;

    const passLine = createPassLine(pass, station, satellite, currentTime, globeRadius);
    if (passLine) {
      group.add(passLine);
    }
  });

  return group;
}

/**
 * React hook for managing pass traffic layer
 */
export function usePassTrafficLayer({
  passes,
  stations,
  satellites,
  currentTime,
  visible,
  globeRadius,
}: PassTrafficLayerProps): THREE.Group | null {
  return useMemo(() => {
    if (!visible) return null;
    return createPassTrafficGroup(passes, stations, satellites, currentTime, globeRadius);
  }, [passes, stations, satellites, currentTime, visible, globeRadius]);
}

export function PassTrafficLayer({
  passes,
  stations,
  satellites,
  currentTime,
  visible,
  globeRadius,
}: PassTrafficLayerProps): THREE.Group | null {
  return usePassTrafficLayer({
    passes,
    stations,
    satellites,
    currentTime,
    visible,
    globeRadius,
  });
}

export default PassTrafficLayer;
