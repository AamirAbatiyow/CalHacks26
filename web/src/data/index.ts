// Centralized data adapter
// Currently uses mock data; swap to fetch from /data/processed/*.json later

export { mockKPIs } from './mockKpis';
export { mockStations } from './mockStations';
export { mockSatellites } from './mockSatellites';
export { mockPasses, getPassesInTimeRange, getActivePassesAtTime } from './mockPasses';
export {
  mockSpaceWeather,
  getSpaceWeatherAtTime,
  getKpIndexAtTime,
  getAuroralOvalLatitude,
} from './mockSpaceWeather';

// Re-export types for convenience
export type {
  Station,
  Satellite,
  Pass,
  PassStatus,
  SpaceWeatherEvent,
  KPIs,
  LayerVisibility,
  PlaybackState,
  TimelineEvent,
} from '../types';
