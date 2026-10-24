import { useMemo, useCallback } from 'react';
import * as THREE from 'three';
import type { Station, Satellite, Pass, LayerVisibility } from '../../types';
import { createGroundStationGroup } from './GroundStationLayer';
import { createSatelliteGroup } from './SatelliteLayer';
import { createPassTrafficGroup } from './PassTrafficLayer';
import { createSpaceWeatherGroup } from './SpaceWeatherLayer';

export {
  GroundStationLayer,
  createGroundStationGroup,
  createStationLabel,
  useGroundStationLayer,
} from './GroundStationLayer';

export {
  SatelliteLayer,
  createSatelliteGroup,
  useSatelliteLayer,
} from './SatelliteLayer';

export {
  PassTrafficLayer,
  createPassTrafficGroup,
  usePassTrafficLayer,
} from './PassTrafficLayer';

export {
  SpaceWeatherLayer,
  createSpaceWeatherGroup,
  useSpaceWeatherLayer,
} from './SpaceWeatherLayer';

export { default as GroundStationLayerDefault } from './GroundStationLayer';
export { default as SatelliteLayerDefault } from './SatelliteLayer';
export { default as PassTrafficLayerDefault } from './PassTrafficLayer';
export { default as SpaceWeatherLayerDefault } from './SpaceWeatherLayer';

interface UseLayerGroupsConfig {
  stations: Station[];
  satellites: Satellite[];
  passes: Pass[];
  kpIndex: number;
  currentTime: Date;
  globeRadius: number;
  layers: LayerVisibility;
}

interface LayerGroupsResult {
  groundStationsGroup: THREE.Group | null;
  satellitesGroup: THREE.Group | null;
  passTrafficGroup: THREE.Group | null;
  spaceWeatherGroup: THREE.Group | null;
  updateGroups: () => void;
}

/**
 * Hook to manage Three.js groups for each layer
 * Use when working directly with Three.js scene rather than React Three Fiber
 */
export function useLayerGroups(config: UseLayerGroupsConfig): LayerGroupsResult {
  const {
    stations,
    satellites,
    passes,
    kpIndex,
    currentTime,
    globeRadius,
    layers,
  } = config;

  const groundStationsGroup = useMemo(() => {
    if (!layers.groundStations) return null;
    return createGroundStationGroup(stations, globeRadius);
  }, [stations, globeRadius, layers.groundStations]);

  const satellitesGroup = useMemo(() => {
    if (!layers.satellitesAndRoutes) return null;
    return createSatelliteGroup(satellites, currentTime, globeRadius);
  }, [satellites, currentTime, globeRadius, layers.satellitesAndRoutes]);

  const passTrafficGroup = useMemo(() => {
    if (!layers.passTraffic) return null;
    return createPassTrafficGroup(passes, stations, satellites, currentTime, globeRadius);
  }, [passes, stations, satellites, currentTime, globeRadius, layers.passTraffic]);

  const spaceWeatherGroup = useMemo(() => {
    if (!layers.spaceWeather) return null;
    return createSpaceWeatherGroup(kpIndex, stations, globeRadius);
  }, [kpIndex, stations, globeRadius, layers.spaceWeather]);

  const updateGroups = useCallback(() => {
    // Placeholder for potential imperative updates
  }, []);

  return {
    groundStationsGroup,
    satellitesGroup,
    passTrafficGroup,
    spaceWeatherGroup,
    updateGroups,
  };
}

export type { UseLayerGroupsConfig, LayerGroupsResult };
