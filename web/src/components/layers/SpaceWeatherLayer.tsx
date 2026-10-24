import { useMemo } from 'react';
import * as THREE from 'three';
import type { Station } from '../../types';
import { latLonToVector3 } from '../../utils/geo';
import { getAuroralOvalLatitude } from '../../data/mockSpaceWeather';

interface SpaceWeatherLayerProps {
  kpIndex: number;
  stations: Station[];
  visible: boolean;
  globeRadius: number;
}

const OVAL_COLOR = 0x8b5cf6;
const HIGHLIGHT_COLOR = 0xf59e0b;

/**
 * Create an auroral oval line around a pole
 */
function createAuroralOval(
  latitude: number,
  isNorth: boolean,
  globeRadius: number
): THREE.Line {
  const points: THREE.Vector3[] = [];
  const numPoints = 72;
  const elevation = 0.015;
  const adjustedRadius = globeRadius * (1 + elevation);
  const lat = isNorth ? latitude : -latitude;

  for (let i = 0; i <= numPoints; i++) {
    const lon = (i / numPoints) * 360 - 180;
    const [x, y, z] = latLonToVector3(lat, lon, adjustedRadius);
    points.push(new THREE.Vector3(x, y, z));
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineDashedMaterial({
    color: OVAL_COLOR,
    dashSize: 0.05,
    gapSize: 0.03,
    transparent: true,
    opacity: 0.7,
  });

  const line = new THREE.Line(geometry, material);
  line.computeLineDistances();
  line.userData = { type: 'auroral-oval', isNorth };

  return line;
}

/**
 * Create a highlight ring for an affected station
 */
function createAffectedStationHighlight(
  station: Station,
  globeRadius: number
): THREE.Group {
  const group = new THREE.Group();
  group.name = `affected-${station.id}`;

  const elevation = 0.025;
  const [x, y, z] = latLonToVector3(
    station.lat,
    station.lon,
    globeRadius * (1 + elevation)
  );

  const innerRingGeometry = new THREE.RingGeometry(0.06, 0.08, 32);
  const innerRingMaterial = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
  });
  const innerRing = new THREE.Mesh(innerRingGeometry, innerRingMaterial);
  innerRing.position.set(x, y, z);
  innerRing.lookAt(0, 0, 0);
  group.add(innerRing);

  const outerRingGeometry = new THREE.RingGeometry(0.09, 0.1, 32);
  const outerRingMaterial = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLOR,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
  });
  const outerRing = new THREE.Mesh(outerRingGeometry, outerRingMaterial);
  outerRing.position.set(x, y, z);
  outerRing.lookAt(0, 0, 0);
  group.add(outerRing);

  group.userData = { station, affected: true, type: 'affected-station' };
  return group;
}

/**
 * Create a storm label sprite
 */
function createStormLabel(kpIndex: number, globeRadius: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = 192;
  canvas.height = 48;

  if (ctx) {
    ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 24);
    ctx.fill();

    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Kp ${kpIndex} storm`, canvas.width / 2, canvas.height / 2);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });

  const sprite = new THREE.Sprite(material);
  
  const [x, y, z] = latLonToVector3(75, 0, globeRadius * 1.15);
  sprite.position.set(x, y, z);
  sprite.scale.set(0.3, 0.075, 1);
  sprite.userData = { type: 'storm-label', kpIndex };

  return sprite;
}

/**
 * Create a Three.js group containing space weather visualization
 */
export function createSpaceWeatherGroup(
  kpIndex: number,
  stations: Station[],
  globeRadius: number
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'space-weather';

  const ovalLatitude = getAuroralOvalLatitude(kpIndex);

  const northOval = createAuroralOval(ovalLatitude, true, globeRadius);
  group.add(northOval);

  const southOval = createAuroralOval(ovalLatitude, false, globeRadius);
  group.add(southOval);

  const affectedStationsGroup = new THREE.Group();
  affectedStationsGroup.name = 'affected-stations';
  group.add(affectedStationsGroup);

  const affectedStations = stations.filter((station) => {
    const absLat = Math.abs(station.lat);
    return absLat >= ovalLatitude;
  });

  affectedStations.forEach((station) => {
    const highlight = createAffectedStationHighlight(station, globeRadius);
    affectedStationsGroup.add(highlight);
  });

  const isStorm = kpIndex >= 5;
  if (isStorm) {
    const label = createStormLabel(kpIndex, globeRadius);
    group.add(label);
  }

  group.userData = { kpIndex, ovalLatitude, affectedCount: affectedStations.length };
  return group;
}

/**
 * React hook for managing space weather layer
 */
export function useSpaceWeatherLayer({
  kpIndex,
  stations,
  visible,
  globeRadius,
}: SpaceWeatherLayerProps): THREE.Group | null {
  return useMemo(() => {
    if (!visible) return null;
    return createSpaceWeatherGroup(kpIndex, stations, globeRadius);
  }, [kpIndex, stations, visible, globeRadius]);
}

export function SpaceWeatherLayer({
  kpIndex,
  stations,
  visible,
  globeRadius,
}: SpaceWeatherLayerProps): THREE.Group | null {
  return useSpaceWeatherLayer({ kpIndex, stations, visible, globeRadius });
}

export default SpaceWeatherLayer;
