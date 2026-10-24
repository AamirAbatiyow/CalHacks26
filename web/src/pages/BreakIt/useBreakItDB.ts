import { useState, useEffect, useCallback, useRef } from 'react';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../../config';
import type { AttackRun, AttackRunSession, AttackFixture, AttackType } from './types';
import { AttackResult, ATTACK_TYPE_CODES } from './types';
import type { Kpi } from '../../types';

function mapAttackResult(result: string): AttackResult {
  switch (result) {
    case 'Caught': return AttackResult.Caught;
    case 'Missed': return AttackResult.Missed;
    default: return AttackResult.Pending;
  }
}

function mapAttackType(type: string): AttackType {
  return type as AttackType;
}

interface WebSocketMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export function useBreakItDB() {
  const [connected, setConnected] = useState(false);
  const [attackRuns, setAttackRuns] = useState<AttackRun[]>([]);
  const [sessions, setSessions] = useState<AttackRunSession[]>([]);
  const [fixtures, setFixtures] = useState<AttackFixture[]>([]);
  const [kpi, setKpi] = useState<Kpi | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    const wsUrl = SPACETIMEDB_HOST.replace('http', 'ws') + '/database/subscribe/' + SPACETIMEDB_MODULE;
    
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('BreakIt: Connected to SpacetimeDB');
        setConnected(true);
        
        ws.send(JSON.stringify({
          subscribe: {
            query_strings: [
              'SELECT * FROM attack_run',
              'SELECT * FROM attack_run_session',
              'SELECT * FROM attack_fixture',
              'SELECT * FROM kpi',
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
                case 'attack_run':
                  setAttackRuns(prev => {
                    const deleteIds = new Set(deletes.map((d: { id: number }) => BigInt(d.id)));
                    const filtered = prev.filter(r => !deleteIds.has(r.id));
                    const newRuns = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt((row.id as number) || 0),
                      runId: BigInt((row.run_id as number) || 0),
                      attackType: mapAttackType(row.attack_type as string),
                      result: mapAttackResult(row.result as string),
                      amountCents: BigInt((row.amount_cents as number) || 0),
                      timestamp: BigInt(((row.timestamp as { microseconds?: number })?.microseconds) || 0),
                      logMessage: row.log_message as string,
                      attackerIdentity: (row.attacker_identity as string) || null,
                    }));
                    return [...filtered, ...newRuns];
                  });
                  break;

                case 'attack_run_session':
                  setSessions(prev => {
                    const deleteIds = new Set(deletes.map((d: { id: number }) => BigInt(d.id)));
                    const filtered = prev.filter(s => !deleteIds.has(s.id));
                    const newSessions = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt((row.id as number) || 0),
                      startedAt: BigInt(((row.started_at as { microseconds?: number })?.microseconds) || 0),
                      completedAt: row.completed_at 
                        ? BigInt(((row.completed_at as { microseconds?: number })?.microseconds) || 0)
                        : null,
                      totalAttacks: row.total_attacks as number,
                      caught: row.caught as number,
                      missed: row.missed as number,
                      dollarsProtectedCents: BigInt((row.dollars_protected_cents as number) || 0),
                      badPayoutsCents: BigInt((row.bad_payouts_cents as number) || 0),
                    }));
                    return [...filtered, ...newSessions];
                  });
                  break;

                case 'attack_fixture':
                  setFixtures(prev => {
                    const deleteIds = new Set(deletes.map((d: { id: number }) => BigInt(d.id)));
                    const filtered = prev.filter(f => !deleteIds.has(f.id));
                    const newFixtures = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt((row.id as number) || 0),
                      attackType: mapAttackType(row.attack_type as string),
                      amountCents: BigInt((row.amount_cents as number) || 0),
                      description: row.description as string,
                      attackParams: (row.attack_params as string) || '',
                    }));
                    return [...filtered, ...newFixtures];
                  });
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
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse message:', e);
        }
      };

      ws.onclose = () => {
        console.log('BreakIt: Disconnected from SpacetimeDB');
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

  const seedFixtures = useCallback(() => {
    callReducer('seed_attack_fixtures', []);
  }, [callReducer]);

  const runAttackType = useCallback((attackType: AttackType) => {
    callReducer('run_attack_type', [ATTACK_TYPE_CODES[attackType]]);
  }, [callReducer]);

  const runAllAttacks = useCallback(() => {
    callReducer('run_all_attacks', []);
  }, [callReducer]);

  const clearRuns = useCallback(() => {
    callReducer('clear_attack_runs', []);
  }, [callReducer]);

  return {
    connected,
    attackRuns,
    sessions,
    fixtures,
    kpi,
    seedFixtures,
    runAttackType,
    runAllAttacks,
    clearRuns,
  };
}
