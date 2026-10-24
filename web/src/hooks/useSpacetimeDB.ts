import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Station,
  Satellite,
  Pass,
  SpaceWeather,
  SimClock,
  Kpi,
  Claim,
  PlaybackSpeed,
} from '../types';
import { PassStatus, FlareClass, ClaimStatus } from '../types';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../config';

function mapClaimStatus(status: string): ClaimStatus {
  switch (status) {
    case 'Approved': return ClaimStatus.Approved;
    case 'Denied': return ClaimStatus.Denied;
    case 'Edited': return ClaimStatus.Edited;
    default: return ClaimStatus.Pending;
  }
}

function mapPassStatus(status: string): PassStatus {
  switch (status) {
    case 'Active': return PassStatus.Active;
    case 'Ok': return PassStatus.Ok;
    case 'Dropped': return PassStatus.Dropped;
    default: return PassStatus.Scheduled;
  }
}

function mapFlareClass(flare: string): FlareClass {
  switch (flare) {
    case 'C': return FlareClass.C;
    case 'M': return FlareClass.M;
    case 'X': return FlareClass.X;
    default: return FlareClass.None;
  }
}

interface WebSocketMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export function useSpacetimeDB() {
  const [connected, setConnected] = useState(false);
  const [stations, setStations] = useState<Station[]>([]);
  const [satellites, setSatellites] = useState<Satellite[]>([]);
  const [passes, setPasses] = useState<Pass[]>([]);
  const [spaceWeather, setSpaceWeather] = useState<SpaceWeather[]>([]);
  const [simClock, setSimClock] = useState<SimClock | null>(null);
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    const wsUrl = SPACETIMEDB_HOST.replace('http', 'ws') + '/database/subscribe/' + SPACETIMEDB_MODULE;
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Connected to SpacetimeDB');
        setConnected(true);
        
        ws.send(JSON.stringify({
          subscribe: {
            query_strings: [
              'SELECT * FROM station',
              'SELECT * FROM satellite', 
              'SELECT * FROM pass',
              'SELECT * FROM space_weather',
              'SELECT * FROM sim_clock',
              'SELECT * FROM kpi',
              'SELECT * FROM claim',
            ],
          },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg: WebSocketMessage = JSON.parse(event.data);
          
          if (msg.type === 'InitialSubscription' || msg.type === 'TransactionUpdate') {
            const tables = msg.data?.database_update?.tables || [];
            
            for (const table of tables) {
              const tableName = table.table_name;
              const inserts = table.inserts || [];
              const deletes = table.deletes || [];

              switch (tableName) {
                case 'station':
                  setStations(prev => {
                    const deleteIds = new Set(deletes.map((d: {id: string}) => d.id));
                    const filtered = prev.filter(s => !deleteIds.has(s.id));
                    const newStations = inserts.map((row: Record<string, unknown>) => ({
                      id: row.id as string,
                      name: row.name as string,
                      latitude: row.latitude as number,
                      longitude: row.longitude as number,
                      altitudeM: row.altitude_m as number,
                      monthlyRevenueCents: BigInt((row.monthly_revenue_cents as number) || 0),
                    }));
                    return [...filtered, ...newStations];
                  });
                  break;

                case 'satellite':
                  setSatellites(prev => {
                    const deleteIds = new Set(deletes.map((d: {norad_id: number}) => d.norad_id));
                    const filtered = prev.filter(s => !deleteIds.has(s.noradId));
                    const newSatellites = inserts.map((row: Record<string, unknown>) => ({
                      noradId: row.norad_id as number,
                      name: row.name as string,
                      tleLine1: row.tle_line1 as string,
                      tleLine2: row.tle_line2 as string,
                      operator: row.operator as string,
                    }));
                    return [...filtered, ...newSatellites];
                  });
                  break;

                case 'pass':
                  setPasses(prev => {
                    const deleteIds = new Set(deletes.map((d: {id: number}) => BigInt(d.id)));
                    const filtered = prev.filter(p => !deleteIds.has(p.id));
                    const newPasses = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt((row.id as number) || 0),
                      satelliteId: row.satellite_id as number,
                      stationId: row.station_id as string,
                      startTime: BigInt(((row.start_time as {microseconds?: number})?.microseconds) || Date.now() * 1000),
                      endTime: BigInt(((row.end_time as {microseconds?: number})?.microseconds) || Date.now() * 1000),
                      status: mapPassStatus(row.status as string),
                      maxElevationDeg: row.max_elevation_deg as number,
                      revenueCents: BigInt((row.revenue_cents as number) || 0),
                    }));
                    return [...filtered, ...newPasses];
                  });
                  break;

                case 'space_weather':
                  setSpaceWeather(prev => {
                    const deleteTimes = new Set(deletes.map((d: {timestamp: {microseconds: number}}) => BigInt(d.timestamp?.microseconds || 0)));
                    const filtered = prev.filter(w => !deleteTimes.has(w.timestamp));
                    const newWeather = inserts.map((row: Record<string, unknown>) => ({
                      timestamp: BigInt(((row.timestamp as {microseconds?: number})?.microseconds) || 0),
                      kpIndex: row.kp_index as number,
                      flareClass: mapFlareClass(row.flare_class as string),
                      dstIndex: row.dst_index as number,
                    }));
                    return [...filtered, ...newWeather];
                  });
                  break;

                case 'sim_clock':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setSimClock({
                      id: row.id as number,
                      currentTime: BigInt(((row.current_time as {microseconds?: number})?.microseconds) || Date.now() * 1000),
                      speedMultiplier: row.speed_multiplier as number,
                      isPlaying: row.is_playing as boolean,
                      realTimeAnchor: BigInt(((row.real_time_anchor as {microseconds?: number})?.microseconds) || Date.now() * 1000),
                      simTimeAnchor: BigInt(((row.sim_time_anchor as {microseconds?: number})?.microseconds) || Date.now() * 1000),
                    });
                  }
                  break;

                case 'kpi':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setKpi({
                      id: row.id as string,
                      billedThisMonthCents: BigInt((row.billed_this_month_cents as number) || 0),
                      revenueAtRiskCents: BigInt((row.revenue_at_risk_cents as number) || 0),
                      creditsPaidCents: BigInt((row.credits_paid_cents as number) || 0),
                      recoveredCents: BigInt((row.recovered_cents as number) || 0),
                    });
                  }
                  break;

                case 'claim':
                  setClaims(prev => {
                    const deleteIds = new Set(deletes.map((d: {id: number}) => BigInt(d.id)));
                    const filtered = prev.filter(c => !deleteIds.has(c.id));
                    const newClaims = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt((row.id as number) || 0),
                      customerName: row.customer_name as string,
                      amountClaimedCents: BigInt((row.amount_claimed_cents as number) || 0),
                      proposedAmountCents: BigInt((row.proposed_amount_cents as number) || 0),
                      confidencePct: row.confidence_pct as number,
                      escalationReason: row.escalation_reason as string,
                      status: mapClaimStatus(row.status as string),
                      policyVersion: row.policy_version as string,
                      modelVersion: row.model_version as string,
                      createdAt: BigInt(((row.created_at as {microseconds?: number})?.microseconds) || Date.now() * 1000),
                    }));
                    return [...filtered, ...newClaims];
                  });
                  break;
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from SpacetimeDB');
        setConnected(false);
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Failed to connect:', error);
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const callReducer = useCallback((reducerName: string, args: unknown[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        call: {
          reducer: reducerName,
          args,
        },
      }));
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

  const approveClaim = useCallback((claimId: bigint, policyVersion: string, modelVersion: string) => {
    callReducer('approve_claim', [Number(claimId), policyVersion, modelVersion]);
  }, [callReducer]);

  const denyClaim = useCallback((claimId: bigint, policyVersion: string, modelVersion: string) => {
    callReducer('deny_claim', [Number(claimId), policyVersion, modelVersion]);
  }, [callReducer]);

  const editClaim = useCallback((claimId: bigint, newAmountCents: bigint, policyVersion: string, modelVersion: string) => {
    callReducer('edit_claim', [Number(claimId), Number(newAmountCents), policyVersion, modelVersion]);
  }, [callReducer]);

  return {
    connected,
    stations,
    satellites,
    passes,
    spaceWeather,
    simClock,
    kpi,
    claims,
    setPlaybackPlaying,
    setPlaybackSpeedDb,
    seekToTime,
    goLive,
    approveClaim,
    denyClaim,
    editClaim,
  };
}
