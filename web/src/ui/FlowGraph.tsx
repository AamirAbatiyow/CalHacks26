import { memo, useEffect, useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import {
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { motion, useReducedMotion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import '@xyflow/react/dist/base.css';
import type { Tone } from './Chip';

export interface GraphNode {
  id: string;
  title: string;
  /** The one number (or short word) the node is about. */
  value: string;
  /** Optional short qualifier under the value, kept to a few words. */
  sub?: string;
  tone?: Tone;
  icon?: LucideIcon;
  /** Outcome nodes get a soft glow so the eye lands on them first. */
  emphasis?: boolean;
  /** Hover text; full detail lives in the drawer opened on click. */
  hint?: string;
  /** Faint node for a step that did not run. */
  ghost?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  tone?: Tone;
  dashed?: boolean;
}

const NODE_W = 150;
export const COMPACT_NODE_W = 118;
const NODE_H = 60;
const NODE_H_SUB = 74;

interface GNodeData extends Record<string, unknown> {
  node: GraphNode;
  width: number;
  rank: number;
  selected: boolean;
  clickable: boolean;
}

type GNode = Node<GNodeData, 'g'>;
type GEdge = Edge<{ tone?: Tone; dashed?: boolean; rank: number }, 'g'>;

function GraphNodeView({ data }: NodeProps<GNode>) {
  const { node, rank, selected, clickable, width } = data;
  const reduce = useReducedMotion();
  const Icon = node.icon;
  return (
    <motion.div
      className={`gnode tone-${node.tone ?? 'neutral'} ${node.emphasis ? 'emphasis' : ''} ${selected ? 'selected' : ''} ${clickable ? 'clickable' : ''} ${node.ghost ? 'ghost' : ''}`}
      style={{ width, height: node.sub ? NODE_H_SUB : NODE_H }}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: node.ghost ? 0.45 : 1, y: 0 }}
      transition={{ duration: 0.32, delay: rank * 0.09, ease: [0.2, 0, 0, 1] }}
      whileHover={clickable ? { y: -1 } : undefined}
      title={node.hint}
    >
      <Handle type="target" position={Position.Left} className="stage-handle" isConnectable={false} />
      <div className="gnode-head">
        {Icon ? <Icon size={11} strokeWidth={2} aria-hidden className="gnode-icon" /> : <span className="stage-dot" />}
        <span className="gnode-title">{node.title}</span>
      </div>
      <div className="gnode-value">{node.value}</div>
      {node.sub && <div className="gnode-sub">{node.sub}</div>}
      <Handle type="source" position={Position.Right} className="stage-handle" isConnectable={false} />
    </motion.div>
  );
}

function GraphEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<GEdge>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8, offset: 12 });
  const reduce = useReducedMotion();
  const dashed = data?.dashed ?? false;
  return (
    <motion.path
      id={id}
      d={path}
      className={`gedge tone-${data?.tone ?? 'neutral'} ${dashed ? 'dashed' : ''}`}
      fill="none"
      initial={reduce || dashed ? false : { pathLength: 0 }}
      animate={dashed ? undefined : { pathLength: 1 }}
      transition={{ duration: 0.6, delay: (data?.rank ?? 0) * 0.09 + 0.1, ease: [0.2, 0, 0, 1] }}
    />
  );
}

const nodeTypes = { g: memo(GraphNodeView) };
const edgeTypes = { g: memo(GraphEdgeView) };

function layout(nodes: GraphNode[], edges: GraphEdge[], selectedId: string | null, clickable: boolean, rankSep: number, nodeW: number) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: rankSep, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: nodeW, height: n.sub ? NODE_H_SUB : NODE_H });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const xs = [...new Set(nodes.map(n => Math.round(g.node(n.id).x)))].sort((a, b) => a - b);
  const rankOf = (id: string) => xs.indexOf(Math.round(g.node(id).x));
  // Keep each column in the order the caller listed it; dagre may flip it to reduce crossings.
  const ys = new Map<string, number>();
  for (const x of xs) {
    const col = nodes.filter(n => Math.round(g.node(n.id).x) === x);
    const sorted = col.map(n => g.node(n.id).y).sort((a, b) => a - b);
    col.forEach((n, i) => ys.set(n.id, sorted[i]));
  }
  const rfNodes: GNode[] = nodes.map(n => {
    const p = { x: g.node(n.id).x, y: ys.get(n.id) ?? g.node(n.id).y };
    const h = n.sub ? NODE_H_SUB : NODE_H;
    return {
      id: n.id,
      type: 'g',
      position: { x: p.x - nodeW / 2, y: p.y - h / 2 },
      width: nodeW,
      height: h,
      data: { node: n, width: nodeW, rank: rankOf(n.id), selected: n.id === selectedId, clickable },
      draggable: false,
      selectable: false,
      connectable: false,
    };
  });
  const rfEdges: GEdge[] = edges.map(e => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    type: 'g',
    data: { tone: e.tone, dashed: e.dashed, rank: rankOf(e.from) },
  }));
  return { rfNodes, rfEdges };
}

interface FlowGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  height: number;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  label: string;
  rankSep?: number;
  nodeWidth?: number;
}

function Canvas({ nodes, edges, selectedId = null, onSelect, rankSep = 40, nodeWidth = NODE_W }: Omit<FlowGraphProps, 'height' | 'label'>) {
  // Callers rebuild node arrays on every live update; keying the layout on content keeps React Flow
  // from re-measuring and remounting edges each time.
  const signature = JSON.stringify([nodes.map(({ icon, ...n }) => [n, icon?.displayName]), edges, selectedId, rankSep, nodeWidth, !!onSelect]);
  const { rfNodes, rfEdges } = useMemo(
    () => layout(nodes, edges, selectedId, !!onSelect, rankSep, nodeWidth),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );
  const flow = useReactFlow();
  const width = useStore(s => s.width);
  const height = useStore(s => s.height);
  const shape = rfNodes.map(n => n.id).join('|');

  useEffect(() => {
    if (!width || !height) return;
    const frame = requestAnimationFrame(() => { flow.fitView({ padding: 0.08, maxZoom: 1, duration: 0 }); });
    return () => cancelAnimationFrame(frame);
  }, [width, height, shape, flow]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="dark"
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      proOptions={{ hideAttribution: true }}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      onNodeClick={onSelect ? (_, n) => onSelect(n.id) : undefined}
    />
  );
}

/** Small static left-to-right graph: evidence and stages as nodes, details on click. */
export function FlowGraph({ height, label, ...props }: FlowGraphProps) {
  return (
    <div className="ui-flow" style={{ height }} role="group" aria-label={label}>
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
