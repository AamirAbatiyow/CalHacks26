import { useMemo } from 'react';
import { motion } from 'motion/react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { C } from '../../ui/charts';
import type { PolicyProposal } from '../../hooks/useCases';

interface Point {
  x: string;
  status: string;
  cases: number;
  esc?: number;
  prec?: number;
  blockedEsc?: number;
  blockedPrec?: number;
  reason?: string;
}

const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/** One point per policy version, each measured by replaying the labeled decisions. Blocked versions sit off the line. */
export function versionPoints(proposals: PolicyProposal[]): Point[] {
  const sorted = [...proposals].sort((a, b) => num(a.versionId) - num(b.versionId));
  if (sorted.length === 0) return [];
  const first = sorted[0];
  const points: Point[] = [{ x: first.baseVersionId, status: 'base', cases: first.replayCases, esc: first.escalationsBefore, prec: first.precisionBefore }];
  for (const p of sorted) {
    const base = { x: p.versionId, status: p.status, cases: p.replayCases };
    points.push(p.status === 'blocked'
      ? { ...base, blockedEsc: p.escalationsAfter, blockedPrec: p.precisionAfter, reason: p.blockReason }
      : { ...base, esc: p.escalationsAfter, prec: p.precisionAfter });
  }
  return points;
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Point }> }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const esc = p.esc ?? p.blockedEsc;
  const prec = p.prec ?? p.blockedPrec;
  return (
    <div className="ui-tooltip">
      <div className="ui-tooltip-label">{p.x} · {p.status}</div>
      <div className="ui-tooltip-row"><span className="ui-tooltip-swatch" style={{ background: C.accent }} /><span className="ui-tooltip-name">Escalations</span><span className="ui-tooltip-value">{esc?.toLocaleString()}</span></div>
      <div className="ui-tooltip-row"><span className="ui-tooltip-swatch" style={{ background: C.green }} /><span className="ui-tooltip-name">Precision</span><span className="ui-tooltip-value">{prec?.toFixed(2)}%</span></div>
      <div className="ui-tooltip-row"><span className="ui-tooltip-name">Replayed {p.cases.toLocaleString()} decisions</span></div>
      {p.reason && <div className="ui-tooltip-row"><span className="ui-tooltip-name" style={{ color: C.red }}>Blocked: {p.reason}</span></div>}
    </div>
  );
}

export function VersionTrend({ proposals, onSelect }: { proposals: PolicyProposal[]; onSelect: (versionId: string) => void }) {
  const data = useMemo(() => versionPoints(proposals), [proposals]);
  if (data.length < 2) return null;
  const line = data.filter(d => d.esc !== undefined);
  const first = line[0];
  const last = line[line.length - 1];
  const precFloor = Math.min(80, Math.floor(Math.min(...data.map(d => d.prec ?? d.blockedPrec ?? 100)) - 2));
  const drop = first.esc! > 0 ? ((first.esc! - last.esc!) * 100) / first.esc! : 0;
  const select = (state: { activeLabel?: string | number } | null) => {
    if (state?.activeLabel !== undefined && String(state.activeLabel) !== first.x) onSelect(String(state.activeLabel));
  };

  return (
    <section className="policy-section version-trend">
      <div className="policy-section-head">
        <span className="ui-section-title">Escalations by policy version</span>
        <span className="ui-legend version-trend-legend">
          <span><i style={{ background: C.accent }} />Escalations</span>
          <span><i style={{ background: C.green }} />Precision</span>
          <span><i className="hollow" />Blocked</span>
        </span>
      </div>
      <div className="version-trend-summary">
        <b>{first.esc!.toLocaleString()} → {last.esc!.toLocaleString()}</b> escalations from {first.x} to {last.x} ({drop.toFixed(0)}% fewer),
        precision {first.prec!.toFixed(2)}% → {last.prec!.toFixed(2)}%. Each point replays the labeled human decisions under that version's Cedar policy.
      </div>
      <motion.div style={{ height: 200 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }} onClick={select} style={{ cursor: 'pointer' }}>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="x" tick={{ fill: C.secondary, fontSize: 11 }} axisLine={{ stroke: C.grid }} tickLine={false} />
            <YAxis yAxisId="esc" domain={[0, 'auto']} tick={{ fill: C.secondary, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
            <YAxis yAxisId="prec" orientation="right" domain={[precFloor, 100]} tick={{ fill: C.secondary, fontSize: 10 }} axisLine={false} tickLine={false} width={40} tickFormatter={v => `${v}%`} />
            <Tooltip cursor={{ stroke: C.muted, strokeWidth: 1 }} content={<TrendTooltip />} />
            <Line yAxisId="esc" dataKey="esc" name="Escalations" stroke={C.accent} strokeWidth={2} connectNulls dot={{ r: 3.5, fill: C.accent, strokeWidth: 0 }} isAnimationActive={false} />
            <Line yAxisId="prec" dataKey="prec" name="Precision" stroke={C.green} strokeWidth={2} connectNulls dot={{ r: 3, fill: C.green, strokeWidth: 0 }} isAnimationActive={false} />
            <Line yAxisId="esc" dataKey="blockedEsc" stroke="none" dot={{ r: 4, fill: '#000', stroke: C.red, strokeWidth: 1.5 }} isAnimationActive={false} legendType="none" />
            <Line yAxisId="prec" dataKey="blockedPrec" stroke="none" dot={{ r: 4, fill: '#000', stroke: C.red, strokeWidth: 1.5 }} isAnimationActive={false} legendType="none" />
          </ComposedChart>
        </ResponsiveContainer>
      </motion.div>
    </section>
  );
}
