import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import { AnimatePresence, motion, useTransform } from 'motion/react';
import '@xyflow/react/dist/base.css';
import { layoutTrace } from './layout';
import { StageNodeComponent } from './StageNode';
import { PulseEdgeComponent } from './PulseEdge';
import { SPEEDS, TimelineContext, endPoint, restPoint, useTimeline } from './timeline';
import { STAGE_TITLES } from './adapter';
import { useDecisionTrace, useReplayParam } from './useDecisionTrace';
import type { DecidedBy, DecisionTrace, TraceStage } from './types';
import './DecisionReplay.css';

const nodeTypes = { stage: StageNodeComponent };
const edgeTypes = { pulse: PulseEdgeComponent };

/** Stages kept in frame while the camera follows the active one. */
const FOLLOW_WINDOW = 5;
/** The finished path is framed whole only if it stays legible at this zoom. */
const MIN_OVERVIEW_ZOOM = 0.8;
const FOLLOW_PADDING = 0.28;
const OVERVIEW_PADDING = 0.12;

const ROUTE_LABELS: Record<DecidedBy, string> = {
  system1: 'Auto-decided',
  system2: 'System 2 decided',
  human: 'Human decided · retrained',
  pending: 'Escalated · awaiting human',
};

function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

type Timeline = ReturnType<typeof useTimeline>;

function ReplayCanvas({ trace, timeline }: { trace: DecisionTrace; timeline: Timeline }) {
  const signature = JSON.stringify(trace.stages);
  const { nodes, edges } = useMemo(() => layoutTrace(JSON.parse(signature) as TraceStage[]), [signature]);
  const flow = useReactFlow();
  const [initialized, setInitialized] = useState(false);
  const canvasWidth = useStore(s => s.width);
  const { active, done } = timeline;

  const overviewFits = useMemo(() => {
    const left = Math.min(...nodes.map(n => n.position.x));
    const right = Math.max(...nodes.map(n => n.position.x + (n.width ?? 0)));
    return canvasWidth / ((right - left) * (1 + OVERVIEW_PADDING)) >= MIN_OVERVIEW_ZOOM;
  }, [nodes, canvasWidth]);

  useEffect(() => {
    if (!initialized) return;
    const overview = done && overviewFits;
    const from = overview ? 0 : Math.max(0, active - FOLLOW_WINDOW + 1);
    const framed = nodes.slice(from, active + 1).map(n => ({ id: n.id }));
    flow.fitView({
      nodes: framed,
      padding: overview ? OVERVIEW_PADDING : FOLLOW_PADDING,
      maxZoom: 1.1,
      minZoom: 0.5,
      duration: overview ? 900 : 700,
    });
  }, [initialized, active, done, overviewFits, nodes, flow]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      zoomOnDoubleClick={false}
      minZoom={0.4}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onInit={() => setInitialized(true)}
      fitView
      fitViewOptions={{ nodes: [{ id: '0' }], maxZoom: 1.1 }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1c1c1c" />
    </ReactFlow>
  );
}

function ReplayBar({ trace, timeline }: { trace: DecisionTrace; timeline: Timeline }) {
  const { t, active, done, playing, speed, setSpeed, togglePlay, stepForward, stepBack, seekStage, replay } = timeline;
  const count = trace.stages.length;
  const end = endPoint(count);
  const width = useTransform(t, [0, end], ['0%', '100%']);
  const stage = trace.stages[active];
  const revealed = trace.stages.slice(0, active + 1).map(s => STAGE_TITLES[s.kind]).join('  →  ');

  return (
    <div className="playback-bar replay-bar-strip">
      <div className="playback-controls">
        <button className="control-btn" onClick={stepBack} title="Step back (←)">
          ⏮
        </button>
        <button className="control-btn play-btn" onClick={togglePlay} title={playing ? 'Pause (space)' : done ? 'Replay (space)' : 'Play (space)'}>
          {playing ? '⏸' : done ? '↻' : '▶'}
        </button>
        <button className="control-btn" onClick={stepForward} title="Step forward (→)" disabled={done}>
          ⏭
        </button>
        <div className="speed-controls">
          {SPEEDS.map(s => (
            <button key={s} className={`speed-btn ${speed === s ? 'active' : ''}`} onClick={() => setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="scrubber-container">
        <div className="scrubber">
          <div className="scrubber-track">
            <motion.div className="scrubber-progress replay-progress" style={{ width }} />
            {trace.stages.map((s, i) => (
              <button
                key={i}
                className={`replay-tick tone-${s.tone} ${i <= active ? 'reached' : ''}`}
                style={{ left: `${(restPoint(i) / end) * 100}%` }}
                onClick={() => seekStage(i)}
                title={i <= active ? STAGE_TITLES[s.kind] : `Stage ${i + 1}`}
              />
            ))}
            <motion.div className="scrubber-handle" style={{ left: width }} />
          </div>
        </div>
        <span className="scrubber-label replay-path-label">{revealed}</span>
      </div>

      <div className="playback-timestamp">
        <span className="timestamp-value">
          {String(active + 1).padStart(2, '0')} / {String(count).padStart(2, '0')} · {STAGE_TITLES[stage.kind]}
        </span>
        <button className="live-btn" onClick={replay}>Replay</button>
      </div>
    </div>
  );
}

function ReplayPanel({ trace, onClose }: { trace: DecisionTrace; onClose: () => void }) {
  const timeline = useTimeline(trace.stages.length);
  const { togglePlay, stepForward, stepBack, replay } = timeline;
  const contextValue = useMemo(() => ({ t: timeline.t, active: timeline.active }), [timeline.t, timeline.active]);
  const routeTone = trace.decidedBy === 'human' || trace.decidedBy === 'pending' ? 'warn' : 'neutral';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') stepForward();
      else if (e.key === 'ArrowLeft') stepBack();
      else if (e.key === 'r' || e.key === 'R') replay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, togglePlay, stepForward, stepBack, replay]);

  return (
    <TimelineContext.Provider value={contextValue}>
      <header className="replay-header">
        <div className="replay-heading">
          <span className="replay-eyebrow">Decision replay</span>
          <h2 className="replay-title">{trace.title}</h2>
          <div className="replay-meta">
            <span>{trace.subject}</span>
            <span className="replay-sep">·</span>
            <span className="replay-amount">
              {trace.decidedBy === 'pending' ? `${usd(trace.claimedCents)} claimed` : `${usd(trace.amountCents)} credit`}
            </span>
            <span className="replay-sep">·</span>
            <span>Policy {trace.policyVersion}</span>
            <span className="replay-sep">·</span>
            <span>Model {trace.modelVersion}</span>
          </div>
        </div>
        <div className="replay-header-right">
          <span className={`replay-route tone-${routeTone}`}>{ROUTE_LABELS[trace.decidedBy]}</span>
          {trace.source === 'seeded' && (
            <span className="replay-source" title="Example path seeded from this decision's row until the pipeline's audit path is available">
              seeded path
            </span>
          )}
          <button className="replay-close" onClick={onClose} title="Close (Esc)" aria-label="Close replay">✕</button>
        </div>
      </header>
      <div className="replay-canvas">
        <ReactFlowProvider>
          <ReplayCanvas trace={trace} timeline={timeline} />
        </ReactFlowProvider>
      </div>
      <ReplayBar trace={trace} timeline={timeline} />
    </TimelineContext.Provider>
  );
}

/** Mounted once per page area; opens whenever the hash carries `?replay=<decision key>`. */
export function DecisionReplayHost() {
  const [replayKey, setReplayKey] = useReplayParam();
  const trace = useDecisionTrace(replayKey);
  const close = useCallback(() => setReplayKey(null), [setReplayKey]);

  return (
    <AnimatePresence>
      {replayKey && (
        <motion.div
          key="replay"
          className="replay-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={e => { if (e.target === e.currentTarget) close(); }}
        >
          <motion.div
            className="replay-panel"
            role="dialog"
            aria-label="Decision replay"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            {trace ? (
              <ReplayPanel key={trace.key} trace={trace} onClose={close} />
            ) : (
              <div className="replay-loading">
                <span>Loading decision…</span>
                <button className="replay-close" onClick={close} aria-label="Close replay">✕</button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
