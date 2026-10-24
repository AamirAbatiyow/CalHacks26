import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  Claim,
  ClaimPass,
  ClaimEvidence,
  ClaimDecision,
  ClaimOutcome,
  ClaimWeather,
  Kpi,
  SimClock,
} from '../types';
import { ClaimGate, DataIntegrityStatus } from '../types';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../config';

function mapClaimGate(gate: string): ClaimGate {
  switch (gate) {
    case 'Approval': return ClaimGate.Approval;
    case 'Escalated': return ClaimGate.Escalated;
    default: return ClaimGate.Auto;
  }
}

function mapDataIntegrityStatus(status: string): DataIntegrityStatus {
  switch (status) {
    case 'Fail': return DataIntegrityStatus.Fail;
    case 'Pending': return DataIntegrityStatus.Pending;
    default: return DataIntegrityStatus.Pass;
  }
}

interface WebSocketMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export interface ClaimData {
  claim: Claim | null;
  pass: ClaimPass | null;
  evidence: ClaimEvidence | null;
  decision: ClaimDecision | null;
  outcome: ClaimOutcome | null;
  weather: ClaimWeather | null;
}

export function useClaimData(claimId: string) {
  const [connected, setConnected] = useState(false);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [pass, setPass] = useState<ClaimPass | null>(null);
  const [evidence, setEvidence] = useState<ClaimEvidence | null>(null);
  const [decision, setDecision] = useState<ClaimDecision | null>(null);
  const [outcome, setOutcome] = useState<ClaimOutcome | null>(null);
  const [weather, setWeather] = useState<ClaimWeather | null>(null);
  const [kpi, setKpi] = useState<Kpi | null>(null);
  const [simClock, setSimClock] = useState<SimClock | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    const wsUrl = SPACETIMEDB_HOST.replace('http', 'ws') + '/database/subscribe/' + SPACETIMEDB_MODULE;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Connected to SpacetimeDB for claim data');
        setConnected(true);

        ws.send(JSON.stringify({
          subscribe: {
            query_strings: [
              `SELECT * FROM claim WHERE id = '${claimId}'`,
              `SELECT * FROM claim_pass WHERE claim_id = '${claimId}'`,
              `SELECT * FROM claim_evidence WHERE claim_id = '${claimId}'`,
              `SELECT * FROM claim_decision WHERE claim_id = '${claimId}'`,
              `SELECT * FROM claim_outcome WHERE claim_id = '${claimId}'`,
              `SELECT * FROM claim_weather WHERE claim_id = '${claimId}'`,
              'SELECT * FROM kpi',
              'SELECT * FROM sim_clock',
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

              switch (tableName) {
                case 'claim':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setClaim({
                      id: row.id as string,
                      customerName: row.customer_name as string,
                      amountClaimedCents: BigInt((row.amount_claimed_cents as number) || 0),
                      passId: BigInt((row.pass_id as number) || 0),
                      createdAt: BigInt(((row.created_at as { microseconds?: number })?.microseconds) || 0),
                    });
                  }
                  break;

                case 'claim_pass':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setPass({
                      id: BigInt((row.id as number) || 0),
                      claimId: row.claim_id as string,
                      stationLat: row.station_lat as number,
                      stationLon: row.station_lon as number,
                      stationName: row.station_name as string,
                      satelliteNoradId: row.satellite_norad_id as number,
                      satelliteTle1: row.satellite_tle1 as string,
                      satelliteTle2: row.satellite_tle2 as string,
                      contactStartTime: BigInt(((row.contact_start_time as { microseconds?: number })?.microseconds) || 0),
                      signalLostTime: BigInt(((row.signal_lost_time as { microseconds?: number })?.microseconds) || 0),
                      contactEndTime: BigInt(((row.contact_end_time as { microseconds?: number })?.microseconds) || 0),
                      maxElevationDeg: row.max_elevation_deg as number,
                    });
                  }
                  break;

                case 'claim_evidence':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setEvidence({
                      claimId: row.claim_id as string,
                      dataIntegrityStatus: mapDataIntegrityStatus(row.data_integrity_status as string),
                      estimatedLossCents: BigInt((row.estimated_loss_cents as number) || 0),
                      missingEvidenceCents: BigInt((row.missing_evidence_cents as number) || 0),
                    });
                  }
                  break;

                case 'claim_decision':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setDecision({
                      claimId: row.claim_id as string,
                      creditAmountCents: BigInt((row.credit_amount_cents as number) || 0),
                      confidencePercent: row.confidence_percent as number,
                      gate: mapClaimGate(row.gate as string),
                      rule: row.rule as string,
                      policyVersion: row.policy_version as string,
                      modelVersion: row.model_version as string,
                      decidedAt: BigInt(((row.decided_at as { microseconds?: number })?.microseconds) || 0),
                    });
                  }
                  break;

                case 'claim_outcome':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    const completedAt = row.completed_at as { microseconds?: number } | null;
                    setOutcome({
                      claimId: row.claim_id as string,
                      creditMemoSent: row.credit_memo_sent as boolean,
                      ledgerPosted: row.ledger_posted as boolean,
                      completedAt: completedAt?.microseconds ? BigInt(completedAt.microseconds) : null,
                    });
                  }
                  break;

                case 'claim_weather':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setWeather({
                      claimId: row.claim_id as string,
                      kpIndex: row.kp_index as number,
                      stormActive: row.storm_active as boolean,
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

                case 'sim_clock':
                  if (inserts.length > 0) {
                    const row = inserts[0] as Record<string, unknown>;
                    setSimClock({
                      id: row.id as number,
                      currentTime: BigInt(((row.current_time as { microseconds?: number })?.microseconds) || Date.now() * 1000),
                      speedMultiplier: row.speed_multiplier as number,
                      isPlaying: row.is_playing as boolean,
                      realTimeAnchor: BigInt(((row.real_time_anchor as { microseconds?: number })?.microseconds) || Date.now() * 1000),
                      simTimeAnchor: BigInt(((row.sim_time_anchor as { microseconds?: number })?.microseconds) || Date.now() * 1000),
                    });
                  }
                  break;
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse claim message:', e);
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from SpacetimeDB (claim)');
        setConnected(false);
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error (claim):', error);
      };
    } catch (error) {
      console.error('Failed to connect (claim):', error);
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    }
  }, [claimId]);

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

  const seedDemoClaim = useCallback(() => {
    callReducer('seed_demo_claim', []);
  }, [callReducer]);

  const approveClaim = useCallback((id: string) => {
    callReducer('approve_claim', [id]);
  }, [callReducer]);

  const escalateClaim = useCallback((id: string, reason: string) => {
    callReducer('escalate_claim', [id, reason]);
  }, [callReducer]);

  const updateOutcome = useCallback((id: string, memoSent: boolean, posted: boolean) => {
    callReducer('update_claim_outcome', [id, memoSent, posted]);
  }, [callReducer]);

  return {
    connected,
    claim,
    pass,
    evidence,
    decision,
    outcome,
    weather,
    kpi,
    simClock,
    seedDemoClaim,
    approveClaim,
    escalateClaim,
    updateOutcome,
  };
}
