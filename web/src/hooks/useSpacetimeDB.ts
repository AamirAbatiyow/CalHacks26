import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Station,
  Satellite,
  Pass,
  SpaceWeather,
  SimClock,
  Kpi,
  PlaybackSpeed,
} from '../types';
import { PassStatus, FlareClass } from '../types';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../config';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

function mapPassStatus(status: unknown): PassStatus {
  if (typeof status === 'string') {
    switch (status) {
      case 'Active': return PassStatus.Active;
      case 'Ok': return PassStatus.Ok;
      case 'Dropped': return PassStatus.Dropped;
      default: return PassStatus.Scheduled;
    }
  }
  if (typeof status === 'object' && status !== null) {
    if ('active' in status) return PassStatus.Active;
    if ('ok' in status) return PassStatus.Ok;
    if ('dropped' in status) return PassStatus.Dropped;
  }
  return PassStatus.Scheduled;
}

function mapFlareClass(flare: unknown): FlareClass {
  if (typeof flare === 'string') {
    switch (flare) {
      case 'C': return FlareClass.C;
      case 'M': return FlareClass.M;
      case 'X': return FlareClass.X;
      default: return FlareClass.None;
    }
  }
  if (typeof flare === 'object' && flare !== null) {
    if ('c' in flare) return FlareClass.C;
    if ('m' in flare) return FlareClass.M;
    if ('x' in flare) return FlareClass.X;
  }
  return FlareClass.None;
}

function extractTimestamp(timeField: unknown): bigint {
  if (typeof timeField === 'bigint') return timeField;
  if (typeof timeField === 'number') return BigInt(timeField);
  if (typeof timeField === 'object' && timeField !== null) {
    const t = timeField as Record<string, unknown>;
    if ('microseconds' in t) return BigInt(t.microseconds as number);
    if ('microsSinceUnixEpoch' in t) return BigInt(t.microsSinceUnixEpoch as number);
    if ('micros_since_unix_epoch' in t) return BigInt(t.micros_since_unix_epoch as number);
  }
  return BigInt(Date.now() * 1000);
}

export function useSpacetimeDB() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [stations, setStations] = useState<Station[]>([]);
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [spaceWeather, setSpaceWeather] = useState<SpaceWeather[]>([]);
  const [simClock, setSimClock] = useState<SimClock | null>(null);
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(() => {
    const wsProtocol = SPACETIMEDB_HOST.startsWith('https') ? 'wss' : 'ws';
    const wsHost = SPACETIMEDB_HOST.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProtocol}://${wsHost}/database/subscribe/${SPACETIMEDB_MODULE}`;
    
    console.log('Connecting to SpacetimeDB:', wsUrl);
    setConnectionState('connecting');
    setError(null);
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected, subscribing to tables...');
        reconnectAttempts.current = 0;
        
        const subscribeMsg = JSON.stringify({
          subscribe: {
            query_strings: [
              'SELECT * FROM station',
              'SELECT * FROM satellite', 
              'SELECT * FROM pass',
              'SELECT * FROM space_weather',
              'SELECT * FROM sim_clock',
              'SELECT * FROM kpi',
            ],
          },
        });
        console.log('Sending subscription:', subscribeMsg);
        ws.send(subscribeMsg);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log('Received message type:', msg.type || 'unknown', msg);
          
          if (msg.type === 'IdentityToken') {
            console.log('Received identity token');
            setConnectionState('connected');
          }
          
          if (msg.type === 'InitialSubscription' || msg.type === 'TransactionUpdate') {
            setConnectionState('connected');
            const tables = msg.database_update?.tables || msg.data?.database_update?.tables || [];
            
            for (const table of tables) {
              const tableName = table.table_name;
              const inserts = table.inserts || [];
              const deletes = table.deletes || [];

              console.log(`Table ${tableName}: ${inserts.length} inserts, ${deletes.length} deletes`);

              switch (tableName) {
                case 'station':
                  setStations(prev => {
                    const deleteIds = new Set(deletes.map((d: Record<string, unknown>) => d.id));
                    const filtered = prev.filter(s => !deleteIds.has(s.id));
                    const newStations = inserts.map((row: Record<string, unknown>) => ({
                      id: String(row.id),
                      name: String(row.name),
                      latitude: Number(row.latitude),
                      longitude: Number(row.longitude),
                      altitudeM: Number(row.altitude_m),
                      monthlyRevenueCents: BigInt(Number(row.monthly_revenue_cents) || 0),
                    }));
                    return [...filtered, ...newStations];
                  });
                  break;

                case 'satellite':
                  setSatellites(prev => {
                    const deleteIds = new Set(deletes.map((d: Record<string, unknown>) => d.norad_id));
                    const filtered = prev.filter(s => !deleteIds.has(s.noradId));
                    const newSatellites = inserts.map((row: Record<string, unknown>) => ({
                      noradId: Number(row.norad_id),
                      name: String(row.name),
                      tleLine1: String(row.tle_line1 || row.tle_line_1),
                      tleLine2: String(row.tle_line2 || row.tle_line_2),
                      operator: String(row.operator),
                    }));
                    return [...filtered, ...newSatellites];
                  });
                  break;

                case 'pass':
                  setPasses(prev => {
                    const deleteIds = new Set(deletes.map((d: Record<string, unknown>) => BigInt(Number(d.id))));
                    const filtered = prev.filter(p => !deleteIds.has(p.id));
                    const newPasses = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt(Number(row.id) || 0),
                      satelliteId: Number(row.satellite_id),
                      stationId: String(row.station_id),
                      startTime: extractTimestamp(row.start_time),
                      endTime: extractTimestamp(row.end_time),
                      status: mapPassStatus(row.status),
                      maxElevationDeg: Number(row.max_elevation_deg),
                      revenueCents: BigInt(Number(row.revenue_cents) || 0),
                    }));
                    return [...filtered, ...newPasses];
                  });
                  break;

                case 'space_weather':
                  setSpaceWeather(prev => {
                    const deleteTimes = new Set(deletes.map((d: Record<string, unknown>) => extractTimestamp(d.timestamp)));
                    const filtered = prev.filter(w => !deleteTimes.has(w.timestamp));
                    const newWeather = inserts.map((row: Record<string, unknown>) => ({
                      timestamp: extractTimestamp(row.timestamp),
                      kpIndex: Number(row.kp_index),
                      flareClass: mapFlareClass(row.flare_class),
                      dstIndex: Number(row.dst_index),
                    }));
                    return [...filtered, ...newWeather];
                  });
                  break;

                case 'sim_clock':
                  if (inserts.length > 0) {
                    const row = inserts[inserts.length - 1] as Record<string, unknown>;
                    setSimClock({
                      id: Number(row.id),
                      currentTime: extractTimestamp(row.current_time),
                      speedMultiplier: Number(row.speed_multiplier),
                      isPlaying: Boolean(row.is_playing),
                      realTimeAnchor: extractTimestamp(row.real_time_anchor),
                      simTimeAnchor: extractTimestamp(row.sim_time_anchor),
                    });
                  }
                  break;

                case 'kpi':
                  if (inserts.length > 0) {
                    const row = inserts[inserts.length - 1] as Record<string, unknown>;
                    setKpi({
                      id: String(row.id),
                      billedThisMonthCents: BigInt(Number(row.billed_this_month_cents) || 0),
                      revenueAtRiskCents: BigInt(Number(row.revenue_at_risk_cents) || 0),
                      creditsPaidCents: BigInt(Number(row.credits_paid_cents) || 0),
                      recoveredCents: BigInt(Number(row.recovered_cents) || 0),
                    });
                  }
                  break;
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse message:', e, event.data);
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        setConnectionState('disconnected');
        
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
        reconnectTimeoutRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = (event) => {
        console.error('WebSocket error:', event);
        setConnectionState('error');
        setError('Failed to connect to SpacetimeDB');
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      setConnectionState('error');
      setError(err instanceof Error ? err.message : 'Connection failed');
      
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
      reconnectAttempts.current++;
      reconnectTimeoutRef.current = window.setTimeout(connect, delay);
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const callReducer = useCallback((reducerName: string, args: unknown[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({
        call: {
          reducer: reducerName,
          args,
        },
      });
      console.log('Calling reducer:', reducerName, args);
      wsRef.current.send(msg);
    } else {
      console.warn('Cannot call reducer, WebSocket not connected');
    }
  }, []);

  const setPlaybackPlaying = useCallback((playing: boolean) => {
    callReducer('set_playback_playing', [playing]);
  }, [callReducer]);

  const setPlaybackSpeedDb = useCallback((speed: PlaybackSpeed) => {
    callReducer('set_playback_speed', [speed]);
  }, [callReducer]);

  const seekToTime = useCallback((timestamp: bigint) => {
    callReducer('seek_to_time', [Number(timestamp)]);
  }, [callReducer]);

  const goLive = useCallback(() => {
    callReducer('go_live', []);
  }, [callReducer]);

  return {
    connectionState,
    connected: connectionState === 'connected',
    error,
    stations,
    satellites,
    passes,
    spaceWeather,
    simClock,
    kpi,
    setPlaybackPlaying,
    setPlaybackSpeedDb,
    seekToTime,
    goLive,
  };
}
