import { memo, useRef } from 'react';
import { getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { motion, useTransform } from 'motion/react';
import { EDGE, useTimelineContext } from './timeline';
import type { PulseEdge } from './layout';

const TRAIL = 0.22;

function PulseEdgeView({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<PulseEdge>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8, offset: 14 });
  const { t } = useTimelineContext();
  const k = data?.target ?? 0;
  const measure = useRef<SVGPathElement>(null);

  const progress = useTransform(t, [k - EDGE, k], [0, 1]);
  const visible = useTransform(progress, [0, 0.001], [0, 1]);
  const pulse = useTransform(progress, [0, 0.06, 0.88, 1], [0, 1, 1, 0]);
  const trailLength = useTransform(progress, p => Math.min(p, TRAIL));
  const trailOffset = useTransform(progress, p => Math.max(0, p - TRAIL));
  const point = (p: number) => {
    const el = measure.current;
    if (!el) return { x: sourceX, y: sourceY };
    return el.getPointAtLength(el.getTotalLength() * p);
  };
  const cx = useTransform(progress, p => point(p).x);
  const cy = useTransform(progress, p => point(p).y);

  return (
    <g className="pulse-edge">
      <path ref={measure} d={path} fill="none" stroke="none" />
      <motion.path d={path} className="pulse-edge-track" style={{ pathLength: progress, opacity: visible }} />
      <motion.path
        d={path}
        className="pulse-edge-trail"
        style={{ pathLength: trailLength, pathOffset: trailOffset, opacity: pulse }}
      />
      <motion.circle className="pulse-edge-head" r={2.5} cx={cx} cy={cy} style={{ opacity: pulse }} />
    </g>
  );
}

export const PulseEdgeComponent = memo(PulseEdgeView);
