import { useId, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';

/** Chart colours, taken from the app tokens so charts sit in Overview's palette. */
export const C = {
  primary: '#ffffff',
  secondary: '#888888',
  muted: '#444444',
  grid: '#1c1c1c',
  accent: '#4da3ff',
  amber: '#f59e0b',
  red: '#ef4444',
  green: '#22c55e',
} as const;

/** Recharts restarts its own entry animation whenever a live table re-renders the chart, so charts fade in once here instead. */
const fadeIn = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.4, ease: [0.2, 0, 0, 1] as const },
};

export function ChartTooltip({ active, payload, label, format }: Partial<TooltipContentProps<number, string>> & { format?: (v: number, name: string) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="ui-tooltip">
      {label !== undefined && label !== '' && <div className="ui-tooltip-label">{String(label)}</div>}
      {payload.map(p => (
        <div key={String(p.dataKey ?? p.name)} className="ui-tooltip-row">
          <span className="ui-tooltip-swatch" style={{ background: (p.color ?? p.fill ?? C.secondary) as string }} />
          <span className="ui-tooltip-name">{p.name}</span>
          <span className="ui-tooltip-value">{format ? format(Number(p.value), String(p.name)) : String(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

interface SparklineProps {
  data: { x: string; y: number }[];
  color?: string;
  height?: number;
  format?: (v: number) => string;
  label: string;
}

/** Trend with a faint gradient fill; the y domain starts at zero so area reads as magnitude. */
export function Sparkline({ data, color = C.accent, height = 36, format, label }: SparklineProps) {
  const id = useId().replace(/:/g, '');
  return (
    <motion.div className="ui-spark" role="img" aria-label={label} style={{ height }} {...fadeIn}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, 'auto']} />
          <XAxis dataKey="x" hide />
          <Tooltip
            cursor={{ stroke: C.muted, strokeWidth: 1 }}
            content={<ChartTooltip format={v => (format ? format(v) : String(v))} />}
          />
          <Area type="monotone" dataKey="y" name={label} stroke={color} strokeWidth={1.5} fill={`url(#spark-${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </motion.div>
  );
}

interface GaugeProps {
  value: number;
  threshold?: number;
  size?: number;
  label?: string;
  children?: ReactNode;
}

/** Half-circle confidence gauge with the auto-decide threshold marked on the arc. */
export function Gauge({ value, threshold = 95, size = 132, label = 'Confidence', children }: GaugeProps) {
  const pass = value >= threshold;
  const color = pass ? C.accent : C.amber;
  const clamped = Math.max(0, Math.min(100, value));
  const r = size / 2;
  const angle = Math.PI * (1 - threshold / 100);
  const inner = r * 0.78;
  const outer = r + 3;
  const tick = {
    x1: r + inner * Math.cos(angle), y1: r - inner * Math.sin(angle),
    x2: r + outer * Math.cos(angle), y2: r - outer * Math.sin(angle),
  };
  return (
    <div className="ui-gauge" style={{ width: size, height: r + 6 }} role="img" aria-label={`${label} ${value.toFixed(1)}%, auto-decide threshold ${threshold}%`}>
      <PieChart width={size} height={r + 6}>
        <Pie
          data={[{ v: clamped }, { v: 100 - clamped }]}
          dataKey="v"
          cx={r}
          cy={r}
          startAngle={180}
          endAngle={0}
          innerRadius={r * 0.82}
          outerRadius={r}
          stroke="none"
          isAnimationActive={false}
        >
          <Cell fill={color} style={{ filter: `drop-shadow(0 0 6px ${color}55)` }} />
          <Cell fill="#1a1a1a" />
        </Pie>
      </PieChart>
      <svg className="ui-gauge-tick" width={size} height={r + 6} aria-hidden>
        <line {...tick} stroke={C.secondary} strokeWidth={1.5} />
      </svg>
      <div className="ui-gauge-center">{children}</div>
    </div>
  );
}

interface MeterProps {
  value: number;
  max?: number;
  threshold?: number;
  tone?: 'accent' | 'amber';
  label: string;
}

/** Thin bar for list rows; a tick marks the threshold. */
export function Meter({ value, max = 100, threshold, tone, label }: MeterProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const t = tone ?? (threshold !== undefined && value < threshold ? 'amber' : 'accent');
  return (
    <span className="ui-meter" role="img" aria-label={label}>
      <span className={`ui-meter-fill tone-${t}`} style={{ width: `${pct}%` }} />
      {threshold !== undefined && <span className="ui-meter-tick" style={{ left: `${(threshold / max) * 100}%` }} />}
    </span>
  );
}

interface DivergingBarsProps {
  data: { name: string; value: number; detail?: string }[];
  height?: number;
  label: string;
}

function shortLabel(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** SHAP contributions: bars grow from a zero line, positive right in accent, negative left in amber. */
export function DivergingBars({ data, height, label }: DivergingBarsProps) {
  const lo = Math.min(0, ...data.map(d => d.value));
  const hi = Math.max(0.01, ...data.map(d => d.value));
  return (
    <motion.div role="img" aria-label={label} style={{ height: height ?? data.length * 24 + 8 }} {...fadeIn}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 2, right: 40, bottom: 2, left: 0 }} barCategoryGap={7}>
          <XAxis type="number" hide domain={[lo * 1.1, hi * 1.05]} />
          <YAxis type="category" dataKey="name" width={156} tickLine={false} axisLine={false} interval={0}
            tick={({ x, y, payload }) => (
              <text x={Number(x) - 4} y={y} dy={4} textAnchor="end" fill={C.secondary} fontSize={11}>
                <title>{String(payload.value)}</title>
                {shortLabel(String(payload.value))}
              </text>
            )} />
          <ReferenceLine x={0} stroke={C.muted} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as { name: string; value: number; detail?: string } | undefined;
              if (!active || !p) return null;
              return (
                <div className="ui-tooltip">
                  <div className="ui-tooltip-label">{p.name}</div>
                  {p.detail && <div className="ui-tooltip-row"><span className="ui-tooltip-name">{p.detail}</span></div>}
                  <div className="ui-tooltip-row"><span className="ui-tooltip-name">SHAP</span><span className="ui-tooltip-value">{p.value >= 0 ? '+' : '−'}{Math.abs(p.value).toFixed(2)}</span></div>
                </div>
              );
            }}
          />
          <Bar dataKey="value" radius={[2, 2, 2, 2]} isAnimationActive={false} maxBarSize={10}
            label={({ x, y, width, height: h, value }) => {
              const v = Number(value);
              const right = Math.max(Number(x), Number(x) + Number(width));
              return (
                <text x={right + 4} y={Number(y) + Number(h) / 2} dy={3} fill={C.secondary} fontSize={10}>
                  {`${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`}
                </text>
              );
            }}>
            {data.map(d => <Cell key={d.name} fill={d.value >= 0 ? C.accent : C.amber} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </motion.div>
  );
}

interface StackedBarsProps<K extends string> {
  data: Array<{ x: string } & Record<K, number>>;
  series: { key: K; label: string; color: string }[];
  height?: number;
  format: (v: number) => string;
  label: string;
}

/** Category or day columns stacked from a zero baseline, with a 2px gap between segments. */
export function StackedBars<K extends string>({ data, series, height = 120, format, label }: StackedBarsProps<K>) {
  return (
    <motion.div role="img" aria-label={label} style={{ height }} {...fadeIn}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="22%">
          <XAxis dataKey="x" tickLine={false} axisLine={{ stroke: C.muted }} tick={{ fill: C.secondary, fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis hide domain={[0, 'auto']} />
          <Tooltip cursor={{ fill: 'rgba(255,255,255,0.03)' }} content={<ChartTooltip format={v => format(v)} />} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color}
              stroke="#000" strokeWidth={i < series.length - 1 ? 0 : 0}
              radius={i === series.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
              isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </motion.div>
  );
}

/** One horizontal 100% bar split into labelled parts (e.g. verified vs unverified dollars). */
export function SplitBar({ parts, label }: { parts: { label: string; value: number; color: string; pattern?: boolean }[]; label: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  return (
    <div className="ui-split" role="img" aria-label={label}>
      {parts.map(p => (
        <span
          key={p.label}
          className={`ui-split-part ${p.pattern ? 'hatched' : ''}`}
          title={p.label}
          style={{ flexGrow: Math.max(0, p.value) / total, background: p.pattern ? undefined : p.color, color: p.color }}
        />
      ))}
    </div>
  );
}

/** Metric across versions (e.g. precision per model). Lines carry no area, so the y axis hugs the data; a reference line marks the threshold. */
export function TrendLine({ data, threshold, height = 90, format, label }: { data: { x: string; y: number }[]; threshold?: number; height?: number; format: (v: number) => string; label: string }) {
  const ys = data.map(d => d.y).concat(threshold ?? []);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = Math.max(0.2, (hi - lo) * 0.25);
  return (
    <motion.div className="ui-trend" role="img" aria-label={label} style={{ height }} {...fadeIn}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="x" tick={{ fill: C.secondary, fontSize: 10 }} axisLine={{ stroke: C.grid }} tickLine={false} />
          <YAxis domain={[lo - pad, hi + pad]} tick={{ fill: C.secondary, fontSize: 10 }} axisLine={false} tickLine={false} width={44} tickFormatter={v => format(Number(v))} />
          {threshold !== undefined && <ReferenceLine y={threshold} stroke={C.amber} strokeDasharray="3 3" strokeOpacity={0.6} />}
          <Tooltip cursor={{ stroke: C.muted, strokeWidth: 1 }} content={<ChartTooltip format={v => format(v)} />} />
          <Line type="monotone" dataKey="y" name={label} stroke={C.accent} strokeWidth={1.5} dot={{ r: 2.5, fill: C.accent, strokeWidth: 0 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </motion.div>
  );
}
