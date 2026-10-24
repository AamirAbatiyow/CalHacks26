import { latLonToVector3 } from './geo';

const LAND_REGIONS: Array<{
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  density?: number;
}> = [
  { latMin: 25, latMax: 70, lonMin: -170, lonMax: -50, density: 1.0 },
  { latMin: 15, latMax: 25, lonMin: -110, lonMax: -85, density: 0.9 },
  { latMin: 55, latMax: 75, lonMin: -170, lonMax: -130, density: 0.8 },
  { latMin: -55, latMax: 12, lonMin: -80, lonMax: -35, density: 1.0 },
  { latMin: 35, latMax: 72, lonMin: -10, lonMax: 40, density: 1.0 },
  { latMin: 55, latMax: 70, lonMin: 5, lonMax: 30, density: 1.0 },
  { latMin: -35, latMax: 37, lonMin: -18, lonMax: 52, density: 1.0 },
  { latMin: 5, latMax: 55, lonMin: 40, lonMax: 145, density: 1.0 },
  { latMin: 55, latMax: 77, lonMin: 40, lonMax: 180, density: 0.9 },
  { latMin: 25, latMax: 45, lonMin: 120, lonMax: 145, density: 1.0 },
  { latMin: 5, latMax: 35, lonMin: 68, lonMax: 97, density: 1.0 },
  { latMin: -10, latMax: 20, lonMin: 95, lonMax: 145, density: 0.85 },
  { latMin: -45, latMax: -10, lonMin: 112, lonMax: 155, density: 1.0 },
  { latMin: -47, latMax: -34, lonMin: 166, lonMax: 179, density: 0.9 },
  { latMin: 60, latMax: 83, lonMin: -72, lonMax: -12, density: 0.85 },
  { latMin: 63, latMax: 66, lonMin: -24, lonMax: -13, density: 0.9 },
  { latMin: 50, latMax: 59, lonMin: -10, lonMax: 2, density: 1.0 },
  { latMin: -26, latMax: -12, lonMin: 43, lonMax: 51, density: 0.9 },
  { latMin: 5, latMax: 10, lonMin: 79, lonMax: 82, density: 0.9 },
  { latMin: 22, latMax: 25, lonMin: 120, lonMax: 122, density: 0.9 },
  { latMin: 5, latMax: 20, lonMin: 117, lonMax: 127, density: 0.8 },
  { latMin: 7, latMax: 23, lonMin: -92, lonMax: -77, density: 0.85 },
  { latMin: 18, latMax: 24, lonMin: -85, lonMax: -74, density: 0.6 },
  { latMin: 12, latMax: 42, lonMin: 32, lonMax: 65, density: 0.9 },
  { latMin: -10, latMax: 0, lonMin: 140, lonMax: 150, density: 0.85 },
];

const OCEAN_CUTOUTS: Array<{
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}> = [
  { latMin: 51, latMax: 65, lonMin: -95, lonMax: -77 },
  { latMin: 18, latMax: 30, lonMin: -98, lonMax: -80 },
  { latMin: 30, latMax: 46, lonMin: -6, lonMax: 37 },
  { latMin: 53, latMax: 66, lonMin: 10, lonMax: 30 },
  { latMin: 41, latMax: 47, lonMin: 27, lonMax: 42 },
  { latMin: 36, latMax: 47, lonMin: 46, lonMax: 55 },
  { latMin: 12, latMax: 30, lonMin: 32, lonMax: 44 },
  { latMin: 23, latMax: 31, lonMin: 47, lonMax: 57 },
  { latMin: 5, latMax: 22, lonMin: 80, lonMax: 95 },
  { latMin: 0, latMax: 23, lonMin: 105, lonMax: 120 },
  { latMin: -18, latMax: -10, lonMin: 135, lonMax: 142 },
];

function isInRegion(
  lat: number,
  lon: number,
  region: { latMin: number; latMax: number; lonMin: number; lonMax: number }
): boolean {
  return (
    lat >= region.latMin &&
    lat <= region.latMax &&
    lon >= region.lonMin &&
    lon <= region.lonMax
  );
}

function isLand(lat: number, lon: number): { isLand: boolean; density: number } {
  for (const cutout of OCEAN_CUTOUTS) {
    if (isInRegion(lat, lon, cutout)) {
      return { isLand: false, density: 0 };
    }
  }
  for (const region of LAND_REGIONS) {
    if (isInRegion(lat, lon, region)) {
      return { isLand: true, density: region.density ?? 1.0 };
    }
  }
  return { isLand: false, density: 0 };
}

export interface EarthPointsConfig {
  numPoints: number;
  radius: number;
  jitter?: number;
}

export interface GeneratedPoints {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
}

export function generateEarthLandPoints(config: EarthPointsConfig): GeneratedPoints {
  const { numPoints, radius, jitter = 0.002 } = config;
  const positions: number[] = [];
  const colors: number[] = [];
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  const angleIncrement = Math.PI * 2 * goldenRatio;

  for (let i = 0; i < numPoints; i++) {
    const t = i / numPoints;
    const inclination = Math.acos(1 - 2 * t);
    const azimuth = angleIncrement * i;
    const lat = 90 - (inclination * 180) / Math.PI;
    const lon = ((azimuth * 180) / Math.PI) % 360 - 180;
    const landCheck = isLand(lat, lon);

    if (landCheck.isLand) {
      if (landCheck.density < 1 && Math.random() > landCheck.density) {
        continue;
      }
      const jitterLat = lat + (Math.random() - 0.5) * jitter * 100;
      const jitterLon = lon + (Math.random() - 0.5) * jitter * 100;
      const [x, y, z] = latLonToVector3(jitterLat, jitterLon, radius);
      positions.push(x, y, z);
      const brightness = 0.92 + Math.random() * 0.08;
      colors.push(brightness, brightness, brightness);
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    count: positions.length / 3,
  };
}

export function generateGraticule(
  radius: number,
  latSpacing: number = 15,
  lonSpacing: number = 15,
  pointsPerLine: number = 60
): Float32Array {
  const positions: number[] = [];
  for (let lat = -90 + latSpacing; lat < 90; lat += latSpacing) {
    for (let i = 0; i <= pointsPerLine; i++) {
      const lon = (i / pointsPerLine) * 360 - 180;
      const [x, y, z] = latLonToVector3(lat, lon, radius);
      positions.push(x, y, z);
    }
  }
  for (let lon = -180; lon < 180; lon += lonSpacing) {
    for (let i = 0; i <= pointsPerLine; i++) {
      const lat = (i / pointsPerLine) * 180 - 90;
      const [x, y, z] = latLonToVector3(lat, lon, radius);
      positions.push(x, y, z);
    }
  }
  return new Float32Array(positions);
}
