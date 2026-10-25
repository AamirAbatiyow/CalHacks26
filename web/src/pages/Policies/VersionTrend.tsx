import { useMemo } from 'react';
import { motion } from 'motion/react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { C } from '../../ui/charts';
import { CountUp } from '../../ui/CountUp';
import type { PolicyProposal } from '../../hooks/useCases';

interface Point {
  x: string;
  status: string;
  cases: number;
  esc?: number;
  prec?: number;
  pendEsc?: number;
  pendPrec?: number;
  blockedEsc?: number;
  blockedPrec?: number;
  reason?: string;
}

const num = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/**
 * One point per policy version, each measured by replaying the labeled decisions. The base and
 * promoted versions form the solid line; a proposed version hangs off it on a dashed line until
 * it is promoted. Blocked versions sit off both lines.
 */
export function versionPoints(proposals: PolicyProposal[]): Point[] {
  const sorted = [...proposals].sort((a, b) => num(a.versionId) - num(b.versionId));
  if (sorted.length === 0) return [];
  const first = sorted[0];
  const points: Point[] = [{ x: first.baseVersionId, status: 'base', cases: first.replayCases, esc: first.escalationsBefore, prec: first.precisionBefore }];
  for (const p of sorted) {
    const base = { x: p.versionId, status: p.status, cases: p.replayCases };
    if (p.status === 'blocked') {
      points.push({ ...base, blockedEsc: p.escalationsAfter, blockedPrec: p.precisionAfter, reason: p.blockReason });
    } else if (p.status === 'proposed') {
      const anchor = [...points].reverse().find(q => q.esc !== undefined);
      if (anchor && anchor.pendEsc === undefined && !points.some(q => q.status === 'proposed')) {
        anchor.pendEsc = anchor.esc;
        anchor.pendPrec = anchor.prec;
      }
      points.push({ ...base, pendEsc: p.escalationsAfter, pendPrec: p.precisionAfter });
    } else {
      points.push({ ...base, esc: p.escalationsAfter, prec: p.precisionAfter });
    }
  }
  return points;
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Point }> }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const pending = p.status === 'proposed';
  const esc = pending ? p.pendEsc : p.esc ?? p.blockedEsc;
  const prec = pending ? p.pendPrec : p.prec ?? p.blockedPrec;
  return (
    <div className="ui-tooltip">
      <div className="ui-tooltip-label">{p.x} · {p.status}</div>
      <div className="ui-tooltip-row"><span className="ui-tooltip-swatch" style={{ background: C.accent }} /><span className="ui-tooltip-name">Escalations</span><span className="ui-tooltip-value">{esc?.toLocaleString()}</span></div>
      <div className="ui-tooltip-row"><span className="ui-tooltip-swatch" style={{ background: C.green }} /><span className="ui-tooltip-name">Precision</span><span className="ui-tooltip-value">{prec?.toFixed(2)}%</span></div>
      <div className="ui-tooltip-row"><span className="ui-tooltip-name">Replayed {p.cases.toLocaleString()} decisions</span></div>
      {pending && <div className="ui-tooltip-row"><span className="ui-tooltip-name" style={{ color: C.amber }}>Proposed: not live until promoted</span></div>}
      {p.reason && <div className="ui-tooltip-row"><span className="ui-tooltip-name" style={{ color: C.red }}>Blocked: {p.reason}</span></div>}
    </div>
  );
}

const pct = (from: number, to: number) => (from > 0 ? ((from - to) * 100) / from : 0);

export function VersionTrend({ proposals, onSelect }: { proposals: PolicyProposal[]; onSelect: (versionId: string) => void }) {
  const data = useMemo(() => versionPoints(proposals), [proposals]);
  if (data.length < 2) return null;
  const line = data.filter(d => d.esc !== undefined);
  const first = line[0];
  const live = line[line.length - 1];
  const pending = data.filter(d => d.status === 'proposed').sort((a, b) => a.pendEsc! - b.pendEsc!)[0];
  const precFloor = Math.min(80, Math.floor(Math.min(...data.map(d => d.prec ?? d.pendPrec ?? d.blockedPrec ?? 100)) - 2));
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
          <span><i className="dashed" />Proposed</span>
          <span><i className="hollow" />Blocked</span>
        </span>
      </div>
      <div className="version-trend-live">
        <div className="version-trend-stat">
          <CountUp className="version-trend-number" value={live.esc!} format={n => Math.round(n).toLocaleString()} />
          <span>escalations under <b>{live.x}</b>, the active policy</span>
        </div>
        <div className="version-trend-summary">
          {pending ? (
            <>
              Proposed <b>{pending.x}</b> would cut that to <b>{pending.pendEsc!.toLocaleString()}</b> ({pct(live.esc!, pending.pendEsc!).toFixed(0)}% fewer),
              precision {live.prec!.toFixed(2)}% → {pending.pendPrec!.toFixed(2)}%. It is not live until a human promotes it.
            </>
          ) : (
            <>
              <b>{first.esc!.toLocaleString()} → {live.esc!.toLocaleString()}</b> from {first.x} to {live.x} ({pct(first.esc!, live.esc!).toFixed(0)}% fewer),
              precision {first.prec!.toFixed(2)}% → {live.prec!.toFixed(2)}%.
            </>
          )}
          {' '}Each point replays the labeled human decisions under that version's Cedar policy.
        </div>
      </div>
      <motion.div style={{ height: 200 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }} onClick={select} style={{ cursor: 'pointer' }}>
            <CartesianGrid stroke={C.grid} vertical={false} />
            <XAxis dataKey="x" tick={{ fill: C.secondary, fontSize: 11 }} axisLine={{ stroke: C.grid }} tickLine={false} />
            <YAxis yAxisId="esc" domain={[0, 'auto']} tick={{ fill: C.secondary, fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
            <YAxis yAxisId="prec" orientation="right" domain={[precFloor, 100]} tick={{ fill: C.secondary, fontSize: 10 }} axisLine={false} tickLine={false} width={40} tickFormatter={v => `${v}%`} />
            <Tooltip cursor={{ stroke: C.muted, strokeWidth: 1 }} content={<TrendTooltip />} />
            <Line yAxisId="esc" dataKey="pendEsc" stroke={C.accent} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.7} connectNulls dot={{ r: 4, fill: '#000', stroke: C.accent, strokeWidth: 1.5 }} isAnimationActive={false} legendType="none" />
            <Line yAxisId="prec" dataKey="pendPrec" stroke={C.green} strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.7} connectNulls dot={{ r: 3.5, fill: '#000', stroke: C.green, strokeWidth: 1.5 }} isAnimationActive={false} legendType="none" />
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
