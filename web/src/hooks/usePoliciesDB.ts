import { useState, useEffect, useCallback, useRef } from 'react';
import type { PolicyVersion, CedarRule, PolicyReplay, Kpi } from '../types';
import { PolicyStatus, ReplayStatus } from '../types';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../config';

const PREVIEW_MODE_TIMEOUT_MS = 3000;

function getPreviewData() {
  const now = BigInt(Date.now() * 1000);
  const day = BigInt(24 * 60 * 60 * 1000000);

  const previewVersions: PolicyVersion[] = [
    { id: 'v5', version: 5, status: PolicyStatus.Proposed, author: 'AI', createdAt: now, decisionCount: BigInt(0) },
    { id: 'v4', version: 4, status: PolicyStatus.Current, author: 'Sarah Chen', createdAt: now - BigInt(3) * day, decisionCount: BigInt(1847) },
    { id: 'v3', version: 3, status: PolicyStatus.Retired, author: 'System', createdAt: now - BigInt(4) * day, decisionCount: BigInt(12453) },
    { id: 'v2', version: 2, status: PolicyStatus.Retired, author: 'James Wilson', createdAt: now - BigInt(4) * day, decisionCount: BigInt(8921) },
    { id: 'v1', version: 1, status: PolicyStatus.Retired, author: 'Initial', createdAt: now - BigInt(5) * day, decisionCount: BigInt(45678) },
  ];

  const previewRules: CedarRule[] = [
    { id: 'v5-r1', policyVersionId: 'v5', name: 'Auto-approve under $500', description: 'Automatically approve credits under $500 for verified customers', cedarCode: 'permit(...) when { resource.amount_cents < 50000 };', enabled: true, orderIndex: 0 },
    { id: 'v5-r2', policyVersionId: 'v5', name: 'Block high-value during storms', description: 'Require manual review for high-value passes during geomagnetic storms', cedarCode: 'forbid(...) when { context.kp_index >= 7 };', enabled: true, orderIndex: 1 },
    { id: 'v5-r3', policyVersionId: 'v5', name: 'Escalate repeated disputes', description: 'Escalate if customer has 3+ disputes in 30 days', cedarCode: 'permit(...) when { principal.dispute_count_30d >= 3 };', enabled: true, orderIndex: 2 },
    { id: 'v5-r4', policyVersionId: 'v5', name: 'AI confidence threshold', description: 'Auto-approve when AI confidence exceeds 95%', cedarCode: 'permit(...) when { context.ai_confidence >= 0.95 };', enabled: true, orderIndex: 3 },
    { id: 'v5-r5', policyVersionId: 'v5', name: 'Lower AI threshold (proposed)', description: 'Auto-approve when AI confidence exceeds 90%', cedarCode: 'permit(...) when { context.ai_confidence >= 0.90 };', enabled: true, orderIndex: 4 },
    { id: 'v4-r1', policyVersionId: 'v4', name: 'Auto-approve under $500', description: 'Automatically approve credits under $500 for verified customers', cedarCode: 'permit(...) when { resource.amount_cents < 50000 };', enabled: true, orderIndex: 0 },
    { id: 'v4-r2', policyVersionId: 'v4', name: 'Block high-value during storms', description: 'Require manual review for high-value passes during geomagnetic storms', cedarCode: 'forbid(...) when { context.kp_index >= 7 };', enabled: true, orderIndex: 1 },
    { id: 'v4-r3', policyVersionId: 'v4', name: 'Escalate repeated disputes', description: 'Escalate if customer has 3+ disputes in 30 days', cedarCode: 'permit(...) when { principal.dispute_count_30d >= 3 };', enabled: true, orderIndex: 2 },
    { id: 'v4-r4', policyVersionId: 'v4', name: 'AI confidence threshold', description: 'Auto-approve when AI confidence exceeds 95%', cedarCode: 'permit(...) when { context.ai_confidence >= 0.95 };', enabled: true, orderIndex: 3 },
  ];

  const previewReplay: PolicyReplay = {
    id: BigInt(1),
    proposedVersionId: 'v5',
    currentVersionId: 'v4',
    status: ReplayStatus.Blocked,
    totalClaims: 1240,
    currentClaim: 812,
    precisionBefore: 98.1,
    precisionAfter: 96.4,
    decisionsChanged: 37,
    dollarImpactCents: BigInt(5420000),
    blockReason: 'precision regression',
    createdAt: now,
    isPlaying: true,
    speedMultiplier: 4,
  };

  const previewKpi: Kpi = {
    id: 'main',
    billedThisMonthCents: BigInt(1940000000),
    revenueAtRiskCents: BigInt(41200000),
    creditsPaidCents: BigInt(8600000),
    recoveredCents: BigInt(13100000),
  };

  return { previewVersions, previewRules, previewReplay, previewKpi };
}

function mapPolicyStatus(status: string): PolicyStatus {
  switch (status) {
    case 'Current': return PolicyStatus.Current;
    case 'Retired': return PolicyStatus.Retired;
    default: return PolicyStatus.Proposed;
  }
}

function mapReplayStatus(status: string): ReplayStatus {
  switch (status) {
    case 'Running': return ReplayStatus.Running;
    case 'Completed': return ReplayStatus.Completed;
    case 'Blocked': return ReplayStatus.Blocked;
    default: return ReplayStatus.Pending;
  }
}

interface WebSocketMessage {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export function usePoliciesDB() {
  const [connected, setConnected] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [policyVersions, setPolicyVersions] = useState<PolicyVersion[]>([]);
  const [cedarRules, setCedarRules] = useState<CedarRule[]>([]);
  const [replays, setReplays] = useState<PolicyReplay[]>([]);
  const [kpi, setKpi] = useState<Kpi | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const previewTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    const wsUrl = SPACETIMEDB_HOST.replace('http', 'ws') + '/database/subscribe/' + SPACETIMEDB_MODULE;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Policies: Connected to SpacetimeDB');
        setConnected(true);

        ws.send(JSON.stringify({
          subscribe: {
            query_strings: [
              'SELECT * FROM policy_version',
              'SELECT * FROM cedar_rule',
              'SELECT * FROM policy_replay',
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
                case 'policy_version':
                  setPolicyVersions(prev => {
                    const deleteIds = new Set(deletes.map((d: { id: string }) => d.id));
                    const filtered = prev.filter(v => !deleteIds.has(v.id));
                    const newVersions = inserts.map((row: Record<string, unknown>) => ({
                      id: row.id as string,
                      version: row.version as number,
                      status: mapPolicyStatus(row.status as string),
                      author: row.author as string,
                      createdAt: BigInt(((row.created_at as { microseconds?: number })?.microseconds) || Date.now() * 1000),
                      decisionCount: BigInt((row.decision_count as number) || 0),
                    }));
                    return [...filtered, ...newVersions].sort((a, b) => b.version - a.version);
                  });
                  break;

                case 'cedar_rule':
                  setCedarRules(prev => {
                    const deleteIds = new Set(deletes.map((d: { id: string }) => d.id));
                    const filtered = prev.filter(r => !deleteIds.has(r.id));
                    const newRules = inserts.map((row: Record<string, unknown>) => ({
                      id: row.id as string,
                      policyVersionId: row.policy_version_id as string,
                      name: row.name as string,
                      description: row.description as string,
                      cedarCode: row.cedar_code as string,
                      enabled: row.enabled as boolean,
                      orderIndex: row.order_index as number,
                    }));
                    return [...filtered, ...newRules].sort((a, b) => a.orderIndex - b.orderIndex);
                  });
                  break;

                case 'policy_replay':
                  setReplays(prev => {
                    const deleteIds = new Set(deletes.map((d: { id: number }) => BigInt(d.id)));
                    const filtered = prev.filter(r => !deleteIds.has(r.id));
                    const newReplays = inserts.map((row: Record<string, unknown>) => ({
                      id: BigInt((row.id as number) || 0),
                      proposedVersionId: row.proposed_version_id as string,
                      currentVersionId: row.current_version_id as string,
                      status: mapReplayStatus(row.status as string),
                      totalClaims: row.total_claims as number,
                      currentClaim: row.current_claim as number,
                      precisionBefore: row.precision_before as number,
                      precisionAfter: row.precision_after as number,
                      decisionsChanged: row.decisions_changed as number,
                      dollarImpactCents: BigInt((row.dollar_impact_cents as number) || 0),
                      blockReason: row.block_reason as string,
                      createdAt: BigInt(((row.created_at as { microseconds?: number })?.microseconds) || Date.now() * 1000),
                      isPlaying: row.is_playing as boolean,
                      speedMultiplier: row.speed_multiplier as number,
                    }));
                    return [...filtered, ...newReplays];
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
        console.log('Policies: Disconnected from SpacetimeDB');
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
    previewTimeoutRef.current = window.setTimeout(() => {
      if (!connected && policyVersions.length === 0) {
        const { previewVersions, previewRules, previewReplay, previewKpi } = getPreviewData();
        setPolicyVersions(previewVersions);
        setCedarRules(previewRules);
        setReplays([previewReplay]);
        setKpi(previewKpi);
        setIsPreviewMode(true);
        console.log('Policies: Preview mode activated (SpacetimeDB not connected)');
      }
    }, PREVIEW_MODE_TIMEOUT_MS);

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect, connected, policyVersions.length]);

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

  const startReplay = useCallback((proposedVersionId: string, currentVersionId: string, totalClaims: number) => {
    callReducer('start_replay', [proposedVersionId, currentVersionId, totalClaims]);
  }, [callReducer]);

  const advanceReplay = useCallback((replayId: bigint, claimsToAdvance: number) => {
    callReducer('advance_replay', [Number(replayId), claimsToAdvance]);
  }, [callReducer]);

  const setReplayPlaying = useCallback((replayId: bigint, playing: boolean) => {
    callReducer('set_replay_playing', [Number(replayId), playing]);
  }, [callReducer]);

  const setReplaySpeed = useCallback((replayId: bigint, speed: number) => {
    callReducer('set_replay_speed', [Number(replayId), speed]);
  }, [callReducer]);

  const toggleRule = useCallback((ruleId: string) => {
    callReducer('toggle_rule', [ruleId]);
  }, [callReducer]);

  const createPolicyVersion = useCallback((newId: string, newVersion: number, author: string, sourceVersionId: string) => {
    callReducer('create_policy_version', [newId, newVersion, author, sourceVersionId]);
  }, [callReducer]);

  const promotePolicyVersion = useCallback((versionId: string) => {
    callReducer('promote_policy_version', [versionId]);
  }, [callReducer]);

  return {
    connected,
    isPreviewMode,
    policyVersions,
    cedarRules,
    replays,
    kpi,
    startReplay,
    advanceReplay,
    setReplayPlaying,
    setReplaySpeed,
    toggleRule,
    createPolicyVersion,
    promotePolicyVersion,
  };
}
