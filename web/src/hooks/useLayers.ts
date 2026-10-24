import { useState, useCallback } from 'react';
import type { LayerVisibility } from '../types';

const DEFAULT_LAYERS: LayerVisibility = {
  groundStations: true,
  satellitesAndRoutes: true,
  passTraffic: false,
  spaceWeather: false,
};

export function useLayers(initialState: Partial<LayerVisibility> = {}) {
  const [layers, setLayers] = useState<LayerVisibility>({
    ...DEFAULT_LAYERS,
    ...initialState,
  });

  const toggleLayer = useCallback((layer: keyof LayerVisibility) => {
    setLayers((prev) => ({
      ...prev,
      [layer]: !prev[layer],
    }));
  }, []);

  const setLayer = useCallback((layer: keyof LayerVisibility, value: boolean) => {
    setLayers((prev) => ({
      ...prev,
      [layer]: value,
    }));
  }, []);

  const setAllLayers = useCallback((value: boolean) => {
    setLayers({
      groundStations: value,
      satellitesAndRoutes: value,
      passTraffic: value,
      spaceWeather: value,
    });
  }, []);

  return {
    layers,
    toggleLayer,
    setLayer,
    setAllLayers,
  };
}
