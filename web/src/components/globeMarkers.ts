import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { CONTINENT_PATHS } from '../data/continents';
import { auroralOval, fromGeomagnetic, stormLevel } from '../utils/storm';

export const EARTH_RADIUS = 1;
export const SATELLITE_ALTITUDE = 0.08;

export const MARKER_COLORS = {
  station: '#38bdf8',
  satellite: '#ffffff',
  link: '#e5e7eb',
  dropped: '#f59e0b',
} as const;

export function latLonToVector3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

const satrecs = new Map<string, satellite.SatRec>();

/** Sub-satellite point and globe position at `time`, or null if SGP4 fails. */
export function satellitePosition(tle1: string, tle2: string, time: Date, altitude = SATELLITE_ALTITUDE): { pos: THREE.Vector3; lat: number; lon: number } | null {
  try {
    const key = tle1 + tle2;
    let satrec = satrecs.get(key);
    if (!satrec) {
      satrec = satellite.twoline2satrec(tle1, tle2);
      satrecs.set(key, satrec);
    }
    const pv = satellite.propagate(satrec, time);
    if (!pv || typeof pv.position === 'boolean' || !pv.position) return null;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(time));
    const lat = satellite.degreesLat(geo.latitude);
    const lon = satellite.degreesLong(geo.longitude);
    return { pos: latLonToVector3(lat, lon, EARTH_RADIUS + altitude), lat, lon };
  } catch {
    return null;
  }
}

/** Elevation of a satellite above a station's horizon, in degrees. */
export function elevationDeg(tle1: string, tle2: string, stationLat: number, stationLon: number, altitudeM: number, time: Date): number | null {
  try {
    const key = tle1 + tle2;
    const satrec = satrecs.get(key) ?? satellite.twoline2satrec(tle1, tle2);
    satrecs.set(key, satrec);
    const pv = satellite.propagate(satrec, time);
    if (!pv || typeof pv.position === 'boolean' || !pv.position) return null;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(time));
    const look = satellite.ecfToLookAngles(
      { latitude: satellite.degreesToRadians(stationLat), longitude: satellite.degreesToRadians(stationLon), height: altitudeM / 1000 },
      ecf,
    );
    return look.elevation * (180 / Math.PI);
  } catch {
    return null;
  }
}

export function createDottedEarth(): THREE.Points {
  const positions: number[] = [];
  const latCount = 90;
  const lonCount = 180;
  for (let latIdx = 0; latIdx < latCount; latIdx++) {
    const lat = (latIdx / (latCount - 1)) * 180 - 90;
    const pointsAtLat = Math.max(1, Math.floor(lonCount * Math.cos(lat * Math.PI / 180)));
    for (let lonIdx = 0; lonIdx < pointsAtLat; lonIdx++) {
      const pos = latLonToVector3(lat, (lonIdx / pointsAtLat) * 360 - 180, EARTH_RADIUS);
      positions.push(pos.x, pos.y, pos.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x333333, size: 0.008, sizeAttenuation: true }));
}

export function createContinentOutlines(): THREE.Group {
  const group = new THREE.Group();
  for (const continent of CONTINENT_PATHS) {
    const points = continent.map(([lon, lat]) => latLonToVector3(lat, lon, EARTH_RADIUS + 0.001));
    if (points.length > 1) {
      const material = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.8 });
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
    }
  }
  return group;
}

/** Black sphere just under the surface so the far side does not show through. */
export function createOccluder(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS * 0.995, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
}

/** Ground station: a flat triangle on the surface, pointing north, sized by monthly revenue. */
export function createStationMarker(lat: number, lon: number, monthlyRevenueCents: bigint | number, highlight?: string): THREE.Group {
  const group = new THREE.Group();
  const share = Math.min(1, Number(monthlyRevenueCents) / 1_000_000_000);
  const size = 0.016 + 0.012 * Math.sqrt(share);
  const shape = new THREE.Shape();
  shape.moveTo(0, size);
  shape.lineTo(-size * 0.87, -size * 0.5);
  shape.lineTo(size * 0.87, -size * 0.5);
  shape.closePath();
  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: MARKER_COLORS.station, side: THREE.DoubleSide }),
  );
  group.add(fill);
  if (highlight) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(size * 1.35, size * 1.75, 32),
      new THREE.MeshBasicMaterial({ color: highlight, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
    );
    group.add(ring);
  }
  const surface = latLonToVector3(lat, lon, EARTH_RADIUS + 0.003);
  group.position.copy(surface);
  const north = latLonToVector3(Math.min(89.9, lat + 1), lon, EARTH_RADIUS + 0.003).sub(surface).normalize();
  group.up.copy(north);
  group.lookAt(surface.clone().multiplyScalar(2));
  return group;
}

/** Satellite: a small bright dot. */
export function createSatelliteMarker(pos: THREE.Vector3, size = 0.009): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(size, 12, 12),
    new THREE.MeshBasicMaterial({ color: MARKER_COLORS.satellite }),
  );
  mesh.position.copy(pos);
  return mesh;
}

/** Motion trail fading from the satellite's current position back to `points[0]`. */
export function createTrail(points: THREE.Vector3[], opacity = 0.8): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const colors: number[] = [];
  points.forEach((_, i) => {
    const t = points.length > 1 ? i / (points.length - 1) : 1;
    const v = t * t * opacity;
    colors.push(v, v, v);
  });
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Line(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
}

/** Station-to-satellite link, bowed slightly outward so it reads as a link rather than a chord. */
export function createLink(from: THREE.Vector3, to: THREE.Vector3, color: string, opacity: number): THREE.Line {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.normalize().multiplyScalar(Math.max(mid.length(), EARTH_RADIUS + 0.04));
  const points = new THREE.QuadraticBezierCurve3(from, mid, to).getPoints(24);
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
}

function bandMesh(from: number, to: number, hemisphere: 1 | -1, color: string, opacity: number, radius: number): THREE.Mesh {
  const positions: number[] = [];
  const step = 4;
  // Wide flat quads would cut under the sphere and vanish behind the occluder,
  // so the band is split into rows about 1° of latitude tall.
  const rows = Math.max(1, Math.ceil(Math.abs(to - from)));
  for (let r = 0; r < rows; r++) {
    const a = hemisphere * (from + ((to - from) * r) / rows);
    const b = hemisphere * (from + ((to - from) * (r + 1)) / rows);
    for (let m = 0; m < 360; m += step) {
      const quad = [
        fromGeomagnetic(a, m), fromGeomagnetic(a, m + step),
        fromGeomagnetic(b, m + step), fromGeomagnetic(b, m),
      ].map(p => latLonToVector3(p.lat, p.lon, radius));
      for (const i of [0, 1, 2, 0, 2, 3]) positions.push(quad[i].x, quad[i].y, quad[i].z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false,
  }));
}

function ring(mlat: number, color: string, opacity: number, radius: number): THREE.Line {
  const points: THREE.Vector3[] = [];
  for (let m = 0; m <= 360; m += 3) {
    const p = fromGeomagnetic(mlat, m);
    points.push(latLonToVector3(p.lat, p.lon, radius));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

/**
 * Storm-affected zone for a Kp reading, in both hemispheres: the auroral oval as a
 * filled band in the severity color with a solid equatorward edge, and the polar
 * cap inside it filled more faintly. Empty below storm level.
 */
export function createStormZone(kp: number): THREE.Group {
  const group = new THREE.Group();
  const level = stormLevel(kp);
  if (!level) return group;
  const { equatorward, poleward } = auroralOval(kp);
  const r = EARTH_RADIUS + 0.004;
  for (const h of [1, -1] as const) {
    group.add(bandMesh(equatorward, poleward, h, level.color, 0.34, r));
    group.add(bandMesh(poleward, 89.9, h, level.color, 0.12, r));
    group.add(ring(h * equatorward, level.color, 1, r + 0.001));
    group.add(ring(h * (equatorward - 0.6), level.color, 0.5, r + 0.001));
    group.add(ring(h * poleward, level.color, 0.45, r + 0.001));
  }
  return group;
}

export function disposeObject(obj: THREE.Object3D) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry.dispose();
      const m = child.material;
      if (Array.isArray(m)) m.forEach(x => x.dispose());
      else m.dispose();
    }
  });
}

/** Replaces the children of `group` with `next`, disposing what was there. */
export function replaceChildren(group: THREE.Group, next: THREE.Object3D[]) {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
  for (const child of next) group.add(child);
}
