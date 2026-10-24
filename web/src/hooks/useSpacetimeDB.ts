import { useState, useEffect, useCallback, useRef } from 'react';
import type { Station, Satellite, Pass, SpaceWeather, SimClock, PlaybackSpeed } from '../types';
import { PassStatus, FlareClass } from '../types';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../config';
import { DbConnection, tables, type SubscriptionHandle } from '../module_bindings';
import { Timestamp } from 'spacetimedb';
import { tag } from './useTable';

function extractMicros(timestamp: unknown): bigint {
  if (timestamp instanceof Timestamp) {
    return timestamp.microsSinceUnixEpoch;
  }
  if (typeof timestamp === 'bigint') {
    return timestamp;
  }
  if (typeof timestamp === 'number') {
    return BigInt(timestamp);
  }
  if (timestamp && typeof timestamp === 'object' && '__timestamp_micros_since_unix_epoch__' in timestamp) {
    return BigInt((timestamp as { __timestamp_micros_since_unix_epoch__: bigint | number }).__timestamp_micros_since_unix_epoch__);
  }
  if (timestamp && typeof timestamp === 'object' && 'microsSinceUnixEpoch' in timestamp) {
    return BigInt((timestamp as { microsSinceUnixEpoch: bigint | number }).microsSinceUnixEpoch);
  }
  console.warn('Unknown timestamp format:', timestamp);
  return BigInt(Date.now() * 1000);
}

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

function mapPassStatus(status: unknown): PassStatus {
  switch (tag(status)) {
    case 'Active': return PassStatus.Active;
    case 'Ok': return PassStatus.Ok;
    case 'Dropped': return PassStatus.Dropped;
    default: return PassStatus.Scheduled;
  }
}

function mapFlareClass(flare: unknown): FlareClass {
  switch (tag(flare)) {
    case 'C': return FlareClass.C;
    case 'M': return FlareClass.M;
    case 'X': return FlareClass.X;
    default: return FlareClass.None;
  }
}

export function useSpacetimeDB() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [stations, setStations] = useState<Station[]>([]);
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [spaceWeather, setSpaceWeather] = useState<SpaceWeather[]>([]);
  const [simClock, setSimClock] = useState<SimClock | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const connectionRef = useRef<DbConnection | null>(null);
  const subscriptionRef = useRef<SubscriptionHandle | null>(null);

  useEffect(() => {
    console.log('Initializing SpacetimeDB connection...');
    console.log('Host:', SPACETIMEDB_HOST, 'Module:', SPACETIMEDB_MODULE);
    
    const connect = async () => {
      try {
        setConnectionState('connecting');
        setError(null);
        
        // Build the connection using the typed builder from generated bindings
        const builder = DbConnection.builder();
        
        const conn = builder
          .withUri(SPACETIMEDB_HOST)
          .withDatabaseName(SPACETIMEDB_MODULE)
          .onConnect((connection, identity) => {
            console.log('Connected to SpacetimeDB! Identity:', identity.toHexString());
            setConnectionState('connected');
            
            // Subscribe to all tables after connection
            const sub = connection.subscriptionBuilder()
              .onApplied(() => {
                console.log('Subscription applied, syncing data...');
                synced = true;
                syncAllData(connection.db);
              })
              .onError((errCtx) => {
                console.error('Subscription error:', errCtx.event);
                setError(String(errCtx.event ?? 'Subscription error'));
              })
              .subscribe([
                tables.station,
                tables.satellite,
                tables.pass,
                tables.spaceWeather,
                tables.simClock,
              ]);
            
            subscriptionRef.current = sub;
          })
          .onDisconnect((_ctx, err) => {
            console.log('Disconnected from SpacetimeDB:', err);
            setConnectionState('disconnected');
            if (err) setError(String(err));
          })
          .onConnectError((_ctx, err) => {
            // StrictMode's simulated unmount closes the first socket mid-handshake.
            if (disposed) return;
            console.error('Connection error:', err);
            setConnectionState('error');
            setError(String(err));
          })
          .build();
        
        connectionRef.current = conn;
        
        // Set up table event listeners
        conn.db.station.onInsert((_ctx, row) => {
          console.log('Station inserted:', row);
          setStations(prev => {
            const exists = prev.some(s => s.id === row.id);
            if (exists) return prev;
            return [...prev, {
              id: row.id,
              name: row.name,
              latitude: row.latitude,
              longitude: row.longitude,
              altitudeM: row.altitudeM,
              monthlyRevenueCents: row.monthlyRevenueCents,
            }];
          });
        });
        
        conn.db.station.onDelete((_ctx, row) => {
          setStations(prev => prev.filter(s => s.id !== row.id));
        });
        
        conn.db.satellite.onInsert((_ctx, row) => {
          console.log('Satellite inserted:', row);
          setSatellites(prev => {
            const exists = prev.some(s => s.noradId === row.noradId);
            if (exists) return prev;
            return [...prev, {
              noradId: row.noradId,
              name: row.name,
              tleLine1: row.tleLine1,
              tleLine2: row.tleLine2,
              operator: row.operator,
            }];
          });
        });
        
        conn.db.satellite.onDelete((_ctx, row) => {
          setSatellites(prev => prev.filter(s => s.noradId !== row.noradId));
        });
        
        conn.db.pass.onInsert((_ctx, row) => {
          if (!synced) return;
          setPasses(prev => {
            const exists = prev.some(p => p.id === row.id);
            if (exists) return prev;
            return [...prev, {
              id: row.id,
              satelliteId: row.satelliteId,
              stationId: row.stationId,
              startTime: extractMicros(row.startTime),
              endTime: extractMicros(row.endTime),
              status: mapPassStatus(row.status),
              maxElevationDeg: row.maxElevationDeg,
              revenueCents: row.revenueCents,
            }];
          });
        });
        
        conn.db.pass.onDelete((_ctx, row) => {
          setPasses(prev => prev.filter(p => p.id !== row.id));
        });
        
        conn.db.pass.onUpdate((_ctx, oldRow, newRow) => {
          if (!synced) return;
          setPasses(prev => prev.map(p => 
            p.id === oldRow.id ? {
              id: newRow.id,
              satelliteId: newRow.satelliteId,
              stationId: newRow.stationId,
              startTime: extractMicros(newRow.startTime),
              endTime: extractMicros(newRow.endTime),
              status: mapPassStatus(newRow.status),
              maxElevationDeg: newRow.maxElevationDeg,
              revenueCents: newRow.revenueCents,
            } : p
          ));
        });
        
        conn.db.spaceWeather.onInsert((_ctx, row) => {
          const ts = extractMicros(row.timestamp);
          setSpaceWeather(prev => {
            const exists = prev.some(w => w.timestamp === ts);
            if (exists) return prev;
            return [...prev, {
              timestamp: ts,
              kpIndex: row.kpIndex,
              flareClass: mapFlareClass(row.flareClass),
              dstIndex: row.dstIndex,
            }];
          });
        });
        
        conn.db.spaceWeather.onDelete((_ctx, row) => {
          const ts = extractMicros(row.timestamp);
          setSpaceWeather(prev => prev.filter(w => w.timestamp !== ts));
        });
        
        conn.db.simClock.onInsert((_ctx, row) => {
          console.log('SimClock inserted:', row);
          setSimClock({
            id: row.id,
            currentTime: extractMicros(row.currentTime),
            speedMultiplier: row.speedMultiplier,
            isPlaying: row.isPlaying,
            realTimeAnchor: extractMicros(row.realTimeAnchor),
            simTimeAnchor: extractMicros(row.simTimeAnchor),
          });
        });
        
        conn.db.simClock.onUpdate((_ctx, _oldRow, newRow) => {
          setSimClock({
            id: newRow.id,
            currentTime: extractMicros(newRow.currentTime),
            speedMultiplier: newRow.speedMultiplier,
            isPlaying: newRow.isPlaying,
            realTimeAnchor: extractMicros(newRow.realTimeAnchor),
            simTimeAnchor: extractMicros(newRow.simTimeAnchor),
          });
        });

      } catch (err) {
        console.error('Failed to connect:', err);
        setConnectionState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    
    const syncAllData = (db: DbConnection['db']) => {
      const stationRows = Array.from(db.station.iter());
      console.log('Syncing stations:', stationRows.length);
      setStations(stationRows.map(row => ({
        id: row.id,
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
        altitudeM: row.altitudeM,
        monthlyRevenueCents: row.monthlyRevenueCents,
      })));
      
      const satelliteRows = Array.from(db.satellite.iter());
      console.log('Syncing satellites:', satelliteRows.length);
      setSatellites(satelliteRows.map(row => ({
        noradId: row.noradId,
        name: row.name,
        tleLine1: row.tleLine1,
        tleLine2: row.tleLine2,
        operator: row.operator,
      })));
      
      const passRows = Array.from(db.pass.iter());
      console.log('Syncing passes:', passRows.length);
      setPasses(passRows.map(row => ({
        id: row.id,
        satelliteId: row.satelliteId,
        stationId: row.stationId,
        startTime: extractMicros(row.startTime),
        endTime: extractMicros(row.endTime),
        status: mapPassStatus(row.status),
        maxElevationDeg: row.maxElevationDeg,
        revenueCents: row.revenueCents,
      })));
      
      const weatherRows = Array.from(db.spaceWeather.iter());
      console.log('Syncing space weather:', weatherRows.length);
      setSpaceWeather(weatherRows.map(row => ({
        timestamp: extractMicros(row.timestamp),
        kpIndex: row.kpIndex,
        flareClass: mapFlareClass(row.flareClass),
        dstIndex: row.dstIndex,
      })));
      
      const clockRows = Array.from(db.simClock.iter());
      if (clockRows.length > 0) {
        const row = clockRows[clockRows.length - 1];
        console.log('Syncing sim clock:', row);
        setSimClock({
          id: row.id,
          currentTime: extractMicros(row.currentTime),
          speedMultiplier: row.speedMultiplier,
          isPlaying: row.isPlaying,
          realTimeAnchor: extractMicros(row.realTimeAnchor),
          simTimeAnchor: extractMicros(row.simTimeAnchor),
        });
      }
    };
    
    let disposed = false;
    // Initial rows arrive in bulk through syncAllData; per-row callbacks only
    // apply live changes after that, so tens of thousands of passes load in one pass.
    let synced = false;
    connect();
    
    return () => {
      disposed = true;
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
      }
      if (connectionRef.current) {
        connectionRef.current.disconnect();
      }
    };
  }, []);

  const callReducer = useCallback((reducerName: string, args: unknown[]) => {
    const conn = connectionRef.current;
    if (!conn) {
      console.warn('Cannot call reducer, not connected');
      return;
    }
    console.log('Calling reducer:', reducerName, args);
    switch (reducerName) {
      case 'set_playback_playing':
        conn.reducers.setPlaybackPlaying({ playing: args[0] as boolean });
        break;
      case 'set_playback_speed':
        conn.reducers.setPlaybackSpeed({ speed: args[0] as number });
        break;
      case 'seek_to_time':
        conn.reducers.seekToTime({ timestampMicros: BigInt(args[0] as number) });
        break;
      case 'go_live':
        conn.reducers.goLive({});
        break;
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
    setPlaybackPlaying,
    setPlaybackSpeedDb,
    seekToTime,
    goLive,
  };
}
