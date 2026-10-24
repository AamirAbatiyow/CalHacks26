import * as satellite from 'satellite.js';

export interface SatellitePosition {
  lat: number;
  lon: number;
  altitude: number;
}

export interface PropagationResult extends SatellitePosition {
  velocity: {
    x: number;
    y: number;
    z: number;
  };
}

/**
 * Propagate satellite position from TLE data at a given time
 */
export function propagateSatellite(
  tle1: string,
  tle2: string,
  date: Date
): SatellitePosition | null {
  try {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    
    if (!satrec || satrec.error !== 0) {
      return null;
    }

    const positionAndVelocity = satellite.propagate(satrec, date);
    
    if (
      positionAndVelocity === null ||
      positionAndVelocity === undefined ||
      !positionAndVelocity.position ||
      typeof positionAndVelocity.position === 'boolean'
    ) {
      return null;
    }

    const gmst = satellite.gstime(date);
    const positionGd = satellite.eciToGeodetic(
      positionAndVelocity.position as satellite.EciVec3<number>,
      gmst
    );

    const lat = satellite.degreesLat(positionGd.latitude);
    const lon = satellite.degreesLong(positionGd.longitude);
    const altitude = positionGd.height;

    return { lat, lon, altitude };
  } catch {
    return null;
  }
}

/**
 * Get full propagation result including velocity
 */
export function propagateSatelliteFull(
  tle1: string,
  tle2: string,
  date: Date
): PropagationResult | null {
  try {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    
    if (!satrec || satrec.error !== 0) {
      return null;
    }

    const positionAndVelocity = satellite.propagate(satrec, date);
    
    if (
      positionAndVelocity === null ||
      positionAndVelocity === undefined ||
      !positionAndVelocity.position ||
      typeof positionAndVelocity.position === 'boolean' ||
      !positionAndVelocity.velocity ||
      typeof positionAndVelocity.velocity === 'boolean'
    ) {
      return null;
    }

    const gmst = satellite.gstime(date);
    const positionGd = satellite.eciToGeodetic(
      positionAndVelocity.position as satellite.EciVec3<number>,
      gmst
    );

    const lat = satellite.degreesLat(positionGd.latitude);
    const lon = satellite.degreesLong(positionGd.longitude);
    const altitude = positionGd.height;

    const vel = positionAndVelocity.velocity as satellite.EciVec3<number>;

    return {
      lat,
      lon,
      altitude,
      velocity: { x: vel.x, y: vel.y, z: vel.z },
    };
  } catch {
    return null;
  }
}

/**
 * Generate orbit track points for visualization
 */
export function generateOrbitTrack(
  tle1: string,
  tle2: string,
  date: Date,
  numPoints: number = 120
): SatellitePosition[] {
  const points: SatellitePosition[] = [];
  
  try {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    
    if (!satrec || satrec.error !== 0) {
      return points;
    }

    const meanMotion = satrec.no;
    const orbitalPeriodMinutes = (2 * Math.PI) / meanMotion;
    
    const startTime = date.getTime();
    const periodMs = orbitalPeriodMinutes * 60 * 1000;
    const stepMs = periodMs / numPoints;

    for (let i = 0; i < numPoints; i++) {
      const pointTime = new Date(startTime + i * stepMs);
      const position = propagateSatellite(tle1, tle2, pointTime);
      if (position) {
        points.push(position);
      }
    }
  } catch {
    // Return empty array on error
  }

  return points;
}

/**
 * Get the mean orbital altitude from TLE
 */
export function getMeanAltitude(tle1: string, tle2: string): number | null {
  try {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    
    if (!satrec || satrec.error !== 0) {
      return null;
    }

    const GM = 398600.4418;
    const meanMotionRadPerSec = satrec.no / 60;
    const semiMajorAxis = Math.pow(GM / (meanMotionRadPerSec * meanMotionRadPerSec), 1 / 3);
    
    const earthRadius = 6371;
    return semiMajorAxis - earthRadius;
  } catch {
    return null;
  }
}

/**
 * Get orbital inclination from TLE
 */
export function getInclination(tle2: string): number | null {
  try {
    const incStr = tle2.substring(8, 16).trim();
    const inclination = parseFloat(incStr);
    return isNaN(inclination) ? null : inclination;
  } catch {
    return null;
  }
}
