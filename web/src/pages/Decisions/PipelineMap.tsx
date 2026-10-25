import { useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Zap } from 'lucide-react';

import { STAGE_ORDER, type StageId } from './stages';

export type StageLane = 'fast' | 'deep' | 'outcome' | 'human' | 'intake';

export interface StageCard {
  id: StageId;
  kicker: string;
  name: string;
  tech: string;
  metric: string;
  icon: LucideIcon;
  lane: StageLane;
  /** Live claims through this stage. */
  count?: string;
  countTitle?: string;
  warn?: string;
}

const W = 1650;
const H = 474;
const NW = 180;
const NH = 112;
const FAST_Y = 56;
const DEEP_Y = 244;

const POS: Record<StageId, { x: number; y: number }> = {
  claims: { x: 8, y: FAST_Y },
  s1: { x: 222, y: FAST_Y },
  rules: { x: 436, y: DEEP_Y },
  screen: { x: 664, y: DEEP_Y },
  s2: { x: 892, y: DEEP_Y },
  reverify: { x: 1120, y: DEEP_Y },
  cedar: { x: 1256, y: FAST_Y },
  auto: { x: 1462, y: FAST_Y },
  human: { x: 1462, y: DEEP_Y },
};

const midY = (id: StageId) => POS[id].y + NH / 2;
const midX = (id: StageId) => POS[id].x + NW / 2;
const left = (id: StageId) => POS[id].x;
const right = (id: StageId) => POS[id].x + NW;
const top = (id: StageId) => POS[id].y;
const bottom = (id: StageId) => POS[id].y + NH;
const gapMid = (a: StageId, b: StageId) => (right(a) + left(b)) / 2;

const RULE_CHANNEL_Y = 208;
const VERIFY_CHANNEL_Y = 226;
const FLAG_CHANNEL_Y = 396;
const LOOP_CHANNEL_Y = 436;

type Kind = 'fast' | 'deep' | 'rule' | 'human' | 'flagged' | 'loop' | 'plain';

interface EdgeDef {
  id: string;
  kind: Kind;
  points: [number, number][];
  label?: string;
  labelAt?: [number, number];
  labelAlign?: 'start' | 'middle' | 'end';
  labelBelow?: boolean;
  /** Stages this edge connects, so it lights up when either is selected. */
  ends: [StageId, StageId];
}

const EDGES: EdgeDef[] = [
  { id: 'intake', kind: 'plain', ends: ['claims', 's1'], points: [[right('claims'), midY('claims')], [left('s1'), midY('s1')]] },
  { id: 'fast', kind: 'fast', ends: ['s1', 'cedar'], points: [[right('s1'), midY('s1')], [left('cedar'), midY('cedar')]] },
  {
    id: 'unsure', kind: 'deep', ends: ['s1', 'rules'], label: 'under 95% sure', labelAt: [right('s1') - 52, bottom('s1') + 22], labelAlign: 'start',
    points: [[right('s1') - 60, bottom('s1')], [right('s1') - 60, midY('rules')], [left('rules'), midY('rules')]],
  },
  { id: 'norule', kind: 'deep', ends: ['rules', 'screen'], label: 'no rule', labelAt: [gapMid('rules', 'screen'), midY('rules') - 6], points: [[right('rules'), midY('rules')], [left('screen'), midY('screen')]] },
  { id: 'clean', kind: 'deep', ends: ['screen', 's2'], label: 'clean', labelAt: [gapMid('screen', 's2'), midY('screen') - 6], points: [[right('screen'), midY('screen')], [left('s2'), midY('s2')]] },
  { id: 'propose', kind: 'deep', ends: ['s2', 'reverify'], label: 'proposes', labelAt: [gapMid('s2', 'reverify'), midY('s2') - 6], points: [[right('s2'), midY('s2')], [left('reverify'), midY('reverify')]] },
  {
    id: 'rulefits', kind: 'rule', ends: ['rules', 'cedar'], label: 'a learned rule fits · still no LLM', labelAt: [midX('rules') + 10, RULE_CHANNEL_Y - 4], labelAlign: 'start',
    points: [[midX('rules'), top('rules')], [midX('rules'), RULE_CHANNEL_Y], [left('cedar') + 40, RULE_CHANNEL_Y], [left('cedar') + 40, bottom('cedar')]],
  },
  {
    id: 'verified', kind: 'deep', ends: ['reverify', 'cedar'], label: 'checks pass, ≥ 95%', labelAt: [right('cedar') - 24, VERIFY_CHANNEL_Y - 4], labelAlign: 'start',
    points: [[midX('reverify') + 30, top('reverify')], [midX('reverify') + 30, VERIFY_CHANNEL_Y], [right('cedar') - 32, VERIFY_CHANNEL_Y], [right('cedar') - 32, bottom('cedar')]],
  },
  { id: 'allow', kind: 'fast', ends: ['cedar', 'auto'], points: [[right('cedar'), midY('cedar')], [left('auto'), midY('auto')]] },
  {
    id: 'fails', kind: 'human', ends: ['reverify', 'human'], label: 'fails a check, or < 95%', labelAt: [gapMid('reverify', 'human'), midY('reverify') - 6],
    points: [[right('reverify'), midY('reverify')], [left('human'), midY('human')]],
  },
  {
    id: 'flagged', kind: 'flagged', ends: ['screen', 'human'], label: 'hidden instructions found · the LLM never sees the message', labelAt: [1110, FLAG_CHANNEL_Y], labelBelow: true,
    points: [[midX('screen'), bottom('screen')], [midX('screen'), FLAG_CHANNEL_Y], [midX('human') - 20, FLAG_CHANNEL_Y], [midX('human') - 20, bottom('human')]],
  },
  {
    id: 'loop', kind: 'loop', ends: ['human', 's1'], label: 'LEARNING LOOP · every human ruling becomes a labeled row · System 1 retrains · rules are re-mined', labelAt: [900, LOOP_CHANNEL_Y], labelBelow: true,
    points: [[right('human') - 30, bottom('human')], [right('human') - 30, LOOP_CHANNEL_Y], [left('s1') + 48, LOOP_CHANNEL_Y], [left('s1') + 48, bottom('s1')]],
  },
];

function roundedPath(points: [number, number][], r = 10): string {
  if (points.length < 2) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const ax = cx - ((cx - px) / inLen) * k;
    const ay = cy - ((cy - py) / inLen) * k;
    const bx = cx + ((nx - cx) / outLen) * k;
    const by = cy + ((ny - cy) / outLen) * k;
    d += ` L ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

interface PipelineMapProps {
  stages: StageCard[];
  selected: StageId;
  onSelect: (id: StageId) => void;
  /** e.g. "29% of past claims · 96% match the human" */
  fastStat?: string;
  deepStat?: string;
}

/** The decision pipeline on a fixed canvas: fast lane on top, deep review below, learning loop underneath. */
export function PipelineMap({ stages, selected, onSelect, fastStat, deepStat }: PipelineMapProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.8);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1.05, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = new Map(stages.map(s => [s.id, s]));
  const fastPath = selected === 's1' || selected === 'cedar' || selected === 'auto' || selected === 'claims';

  return (
    <div ref={wrap} className="pm-wrap" style={{ height: H * scale }} role="group" aria-label="Decision pipeline. Select a stage to see its technology, accuracy and real data.">
      <div className="pm-canvas" style={{ width: W, height: H, transform: `scale(${scale})` }}>
        <div className={`pm-band pm-band-fast ${fastPath ? 'lit' : ''}`} style={{ left: left('s1') - 16, top: 22, width: right('cedar') - left('s1') + 32, height: NH + 60 }}>
          <span className="pm-band-label" style={{ left: NW + 32, top: 10 }}>
            <Zap size={12} aria-hidden /> Fast lane <span className="pm-band-sub">System 1 decides alone, no LLM call</span>
          </span>
          {fastStat && <span className="pm-band-stat" style={{ right: NW + 32, top: 10 }}>{fastStat}</span>}
        </div>
        <div className="pm-band pm-band-deep" style={{ left: left('rules') - 16, top: DEEP_Y - 12, width: right('reverify') - left('rules') + 32, height: NH + 44 }}>
          <span className="pm-band-label" style={{ left: 14, bottom: 8 }}>
            Deep review <span className="pm-band-sub">only when System 1 is under 95% sure</span>
          </span>
          {deepStat && <span className="pm-band-stat" style={{ right: 14, bottom: 8 }}>{deepStat}</span>}
        </div>

        <svg className="pm-edges" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
          <defs>
            {(['fast', 'deep', 'rule', 'human', 'flagged', 'loop', 'plain'] as Kind[]).map(k => (
              <marker key={k} id={`pm-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" className={`pm-arrow pm-arrow-${k}`} />
              </marker>
            ))}
            <filter id="pm-glow" x="-20%" y="-200%" width="140%" height="500%">
              <feGaussianBlur stdDeviation="4" />
            </filter>
          </defs>
          {EDGES.map(e => {
            const d = roundedPath(e.points);
            const lit = e.ends.includes(selected);
            return (
              <g key={e.id} className={`pm-edge pm-edge-${e.kind} ${lit ? 'lit' : ''}`}>
                {e.kind === 'fast' && <path d={d} className="pm-edge-glow" filter="url(#pm-glow)" />}
                <path d={d} className="pm-edge-base" markerEnd={`url(#pm-arrow-${e.kind})`} />
                {(e.kind === 'fast' || e.kind === 'deep' || e.kind === 'rule' || e.kind === 'loop') && <path d={d} className="pm-edge-flow" />}
              </g>
            );
          })}
        </svg>

        {EDGES.filter(e => e.label && e.labelAt).map(e => (
          <span
            key={e.id}
            className={`pm-edge-label pm-edge-label-${e.kind} align-${e.labelAlign ?? 'middle'} ${e.labelBelow ? 'below' : ''}`}
            style={{ left: e.labelAt![0], top: e.labelAt![1] }}
          >
            {e.label}
          </span>
        ))}

        <button type="button" className={`pm-fastpass ${fastPath ? 'lit' : ''}`} style={{ left: gapMid('s1', 'cedar'), top: midY('s1') }} onClick={() => onSelect('s1')}>
          <Zap size={14} aria-hidden /> <b>Fast pass</b> <span>at least 95% sure · straight to Cedar</span>
        </button>

        {STAGE_ORDER.map(id => {
          const s = byId.get(id);
          if (!s) return null;
          const Icon = s.icon;
          return (
            <button
              key={id}
              type="button"
              className={`pm-node lane-${s.lane} ${selected === id ? 'selected' : ''}`}
              style={{ left: POS[id].x, top: POS[id].y, width: NW, height: NH }}
              onClick={() => onSelect(id)}
              aria-pressed={selected === id}
              aria-label={`${s.kicker}: ${s.name}`}
            >
              <span className="pm-node-head">
                <Icon size={12} strokeWidth={2} aria-hidden className="pm-node-icon" />
                <span className="pm-node-kicker">{s.kicker}</span>
                {s.count !== undefined && <span className="pm-node-count" title={s.countTitle}>{s.count}</span>}
              </span>
              <span className="pm-node-name">{s.name}</span>
              <span className="pm-node-tech">{s.tech}</span>
              <span className={`pm-node-metric ${s.warn ? 'warn' : ''}`}>{s.warn ?? s.metric}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
