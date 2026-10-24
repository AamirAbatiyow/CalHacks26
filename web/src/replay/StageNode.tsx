import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { motion, useTransform, type MotionValue } from 'motion/react';
import { useTechMode } from '../hooks/useTechMode';
import { CONTENT, DRAW, useTimelineContext } from './timeline';
import { STAGE_TITLES } from './adapter';
import { showsSystem, type StageNode } from './layout';
import type { Headline } from './types';

const easeOut = (p: number) => 1 - (1 - p) ** 3;

function PctValue({ value, digits, progress }: { value: number; digits: number; progress: MotionValue<number> }) {
  const text = useTransform(progress, p => `${(value * easeOut(p)).toFixed(digits)}%`);
  return <motion.span>{text}</motion.span>;
}

function UsdValue({ cents, progress }: { cents: number; progress: MotionValue<number> }) {
  const text = useTransform(progress, p => `$${Math.round((cents / 100) * easeOut(p)).toLocaleString('en-US')}`);
  return <motion.span>{text}</motion.span>;
}

/** Text headlines are cut to their first clause so every node carries one short value. */
function shortText(text: string): string {
  const head = text.split(/\s[·:—]\s|,\s/)[0];
  return head.replace(/ checks?( pass(ed)?)?$/i, '');
}

function HeadlineValue({ headline, progress }: { headline: Headline; progress: MotionValue<number> }) {
  switch (headline.kind) {
    case 'pct': return <PctValue value={headline.value} digits={headline.digits ?? 1} progress={progress} />;
    case 'usd': return <UsdValue cents={headline.cents} progress={progress} />;
    default: return <span>{shortText(headline.text)}</span>;
  }
}

function StageNodeView({ data }: NodeProps<StageNode>) {
  const { stage, index, width, height, final } = data;
  const { t, active } = useTimelineContext();
  const tech = useTechMode();
  const shown = useTransform(t, [index - 0.001, index], [0, 1]);
  const draw = useTransform(t, [index + DRAW[0], index + DRAW[1]], [0, 1]);
  const content = useTransform(t, [index + CONTENT[0], index + CONTENT[1]], [0, 1]);
  const lift = useTransform(content, [0, 1], [3, 0]);
  const count = useTransform(t, [index + CONTENT[0], index + CONTENT[1] + 0.1], [0, 1]);
  const stub = useTransform(t, [index + 0.38, index + 0.52], [0, 1]);

  const state = index === active ? 'is-active' : index < active ? 'is-past' : 'is-future';
  const hasDetail = tech && Boolean(stage.caption || stage.detail || stage.note || stage.checks || showsSystem(stage));

  return (
    <motion.div
      className={`stage-node tone-${stage.tone} ${state} ${final ? 'is-final' : ''}`}
      style={{ width, height, opacity: shown }}
    >
      <Handle type="target" position={Position.Left} className="stage-handle" isConnectable={false} />
      <svg className="stage-frame" width={width} height={height} aria-hidden>
        <motion.rect
          x={0.5}
          y={0.5}
          width={width - 1}
          height={height - 1}
          rx={5}
          style={{ pathLength: draw }}
        />
      </svg>
      <motion.div className="stage-body" style={{ opacity: content, y: lift }}>
        <div className="stage-head">
          <span className="stage-title">
            <span className="stage-dot" />
            {STAGE_TITLES[stage.kind]}
          </span>
          {tech && stage.version && <span className="stage-version" title={stage.version}>{stage.version}</span>}
        </div>
        <div className="stage-headline">
          {stage.href ? (
            <a className="stage-link nodrag nopan" href={stage.href}>
              <HeadlineValue headline={stage.headline} progress={count} />
            </a>
          ) : (
            <HeadlineValue headline={stage.headline} progress={count} />
          )}
        </div>
        {tech && stage.checks && (
          <div className="stage-check-dots" aria-label={`${stage.checks.filter(c => c.ok).length} of ${stage.checks.length} checks passed`}>
            {stage.checks.map(check => (
              <span key={check.label} className={`stage-check-dot ${check.ok ? 'ok' : 'fail'}`} />
            ))}
          </div>
        )}
      </motion.div>
      {hasDetail && (
        <div className="stage-hover" role="tooltip">
          {showsSystem(stage) && <div className="stage-hover-system">{stage.system}</div>}
          {stage.caption && <div className="stage-hover-caption">{stage.caption}</div>}
          {stage.detail && <div className="stage-hover-caption">{stage.detail}</div>}
          {stage.checks && (
            <ul className="stage-checks">
              {stage.checks.map(check => (
                <li key={check.label} className={check.ok ? 'ok' : 'fail'}>
                  <span className="check-mark">{check.ok ? '✓' : '✕'}</span>
                  {check.label}
                </li>
              ))}
            </ul>
          )}
          {stage.note && <p className="stage-note">{stage.note}</p>}
        </div>
      )}
      {stage.untaken && (
        <motion.div className="stage-stub" style={{ opacity: stub }} aria-hidden>
          <span className="stub-line" />
          <span className="stub-label">{stage.untaken}</span>
        </motion.div>
      )}
      <Handle type="source" position={Position.Right} className="stage-handle" isConnectable={false} />
    </motion.div>
  );
}

export const StageNodeComponent = memo(StageNodeView);
