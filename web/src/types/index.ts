export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  bands: string[];
  monthlyRevenue: number; // USD - for marker sizing
}

export interface Satellite {
  noradId: number;
  name: string;
  tle1: string;
  tle2: string;
}

export type PassStatus = 'ok' | 'dropped';

export interface Pass {
  id: string;
  satelliteId: number;
  stationId: string;
  start: Date;
  end: Date;
  status: PassStatus;
  revenue: number; // USD
}

export interface SpaceWeatherEvent {
  time: Date;
  kpIndex: number;
  flareClass?: 'C' | 'M' | 'X';
  flareIntensity?: number;
}

export interface KPIs {
  billedThisMonth: number;
  revenueAtRisk: number;
  creditsPaid: number;
  recovered: number;
}

export interface LayerVisibility {
  groundStations: boolean;
  satellitesAndRoutes: boolean;
  passTraffic: boolean;
  spaceWeather: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  speed: 1 | 4 | 16;
  currentTime: Date;
  isLive: boolean;
}

export interface TimelineEvent {
  time: Date;
  type: 'dispute' | 'dropped' | 'flare';
  description: string;
}
