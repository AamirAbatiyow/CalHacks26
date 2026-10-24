import { useMemo } from 'react';
import * as THREE from 'three';
import type { Satellite } from '../../types';
import { latLonToVector3 } from '../../utils/geo';
import { propagateSatellite, generateOrbitTrack, type SatellitePosition } from '../../utils/satellite';

interface SatelliteLayerProps {
  satellites: Satellite[];
  currentTime: Date;
  visible: boolean;
  globeRadius: number;
}

const ALTITUDE_SCALE = 0.001;
const TRACK_COLOR = 0x404040;
const SATELLITE_COLOR = 0x00ff88;

/**
 * Create a satellite marker (glowing dot)
 */
function createSatelliteMarker(
  satellite: Satellite,
  currentTime: Date,
  globeRadius: number
): THREE.Group | null {
  const pos = propagateSatellite(satellite.tle1, satellite.tle2, currentTime);
  if (!pos) return null;

  const group = new THREE.Group();
  group.name = `satellite-${satellite.noradId}`;

  const scaledAltitude = globeRadius + pos.altitude * ALTITUDE_SCALE;
  const [x, y, z] = latLonToVector3(pos.lat, pos.lon, scaledAltitude);

  const dotGeometry = new THREE.SphereGeometry(0.02, 16, 16);
  const dotMaterial = new THREE.MeshBasicMaterial({ color: SATELLITE_COLOR });
  const dot = new THREE.Mesh(dotGeometry, dotMaterial);
  dot.position.set(x, y, z);
  group.add(dot);

  const glowGeometry = new THREE.SphereGeometry(0.035, 16, 16);
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: SATELLITE_COLOR,
    transparent: true,
    opacity: 0.3,
  });
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  glow.position.set(x, y, z);
  group.add(glow);

  group.userData = { satellite, type: 'satellite-marker' };
  return group;
}

/**
 * Create an orbit track line
 */
function createOrbitTrack(
  satellite: Satellite,
  currentTime: Date,
  globeRadius: number
): THREE.Line | null {
  const trackPoints = generateOrbitTrack(
    satellite.tle1,
    satellite.tle2,
    currentTime,
    120
  );

  if (trackPoints.length < 2) return null;

  const points = trackPoints.map((pos: SatellitePosition) => {
    const scaledAltitude = globeRadius + pos.altitude * ALTITUDE_SCALE;
    const [x, y, z] = latLonToVector3(pos.lat, pos.lon, scaledAltitude);
    return new THREE.Vector3(x, y, z);
  });

  if (points.length > 0) {
    points.push(points[0].clone());
  }

  const curve = new THREE.CatmullRomCurve3(points, true);
  const curvePoints = curve.getPoints(200);
  const geometry = new THREE.BufferGeometry().setFromPoints(curvePoints);

  const material = new THREE.LineDashedMaterial({
    color: TRACK_COLOR,
    dashSize: 0.03,
    gapSize: 0.02,
    transparent: true,
    opacity: 0.6,
  });

  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  line.userData = { satellite, type: 'orbit-track' };

  return line;
}

/**
 * Create a Three.js group containing all satellites and their orbit tracks
 */
export function createSatelliteGroup(
  satellites: Satellite[],
  currentTime: Date,
  globeRadius: number
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'satellites';

  const tracksGroup = new THREE.Group();
  tracksGroup.name = 'orbit-tracks';
  group.add(tracksGroup);

  const markersGroup = new THREE.Group();
  markersGroup.name = 'satellite-markers';
  group.add(markersGroup);

  satellites.forEach((satellite) => {
    const marker = createSatelliteMarker(satellite, currentTime, globeRadius);
    if (marker) {
      markersGroup.add(marker);
    }

    const track = createOrbitTrack(satellite, currentTime, globeRadius);
    if (track) {
      tracksGroup.add(track);
    }
  });

  return group;
}

/**
 * React hook for managing satellite layer
 */
export function useSatelliteLayer({
  satellites,
  currentTime,
  visible,
  globeRadius,
}: SatelliteLayerProps): THREE.Group | null {
  return useMemo(() => {
    if (!visible) return null;
    return createSatelliteGroup(satellites, currentTime, globeRadius);
  }, [satellites, currentTime, visible, globeRadius]);
}

export function SatelliteLayer({
  satellites,
  currentTime,
  visible,
  globeRadius,
}: SatelliteLayerProps): THREE.Group | null {
  return useSatelliteLayer({ satellites, currentTime, visible, globeRadius });
}

export default SatelliteLayer;
