import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import { STAGE_TITLES } from './adapter';
import type { TraceStage } from './types';

export const NODE_WIDTH = 184;

/** The acting system is named where it matters: who decided, and which human. */
export function showsSystem(stage: TraceStage): boolean {
  return (stage.kind === 'decided' || stage.kind === 'human') && stage.system !== STAGE_TITLES[stage.kind];
}

export function nodeHeight(stage: TraceStage): number {
  let h = 72;
  if (showsSystem(stage)) h += 15;
  if (stage.detail) h += 15;
  if (stage.note) h += 52;
  if (stage.checks) h += stage.checks.length * 16 + 6;
  return h;
}

export interface StageNodeData extends Record<string, unknown> {
  stage: TraceStage;
  index: number;
  width: number;
  height: number;
}

export interface PulseEdgeData extends Record<string, unknown> {
  /** Index of the stage the edge leads into; it animates just before that stage draws. */
  target: number;
}

export type StageNode = Node<StageNodeData, 'stage'>;
export type PulseEdge = Edge<PulseEdgeData, 'pulse'>;

/** Left-to-right dagre layout of only the stages this decision actually passed through. */
export function layoutTrace(stages: TraceStage[]): { nodes: StageNode[]; edges: PulseEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 44, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  stages.forEach((stage, i) => {
    g.setNode(String(i), { width: NODE_WIDTH, height: nodeHeight(stage) });
  });
  const edges: PulseEdge[] = [];
  for (let i = 1; i < stages.length; i++) {
    const from = stages[i].parent ?? i - 1;
    g.setEdge(String(from), String(i));
    edges.push({
      id: `e${from}-${i}`,
      source: String(from),
      target: String(i),
      type: 'pulse',
      data: { target: i },
    });
  }
  dagre.layout(g);

  const nodes: StageNode[] = stages.map((stage, i) => {
    const { x, y } = g.node(String(i));
    const height = nodeHeight(stage);
    return {
      id: String(i),
      type: 'stage',
      position: { x: x - NODE_WIDTH / 2, y: y - height / 2 },
      width: NODE_WIDTH,
      height,
      data: { stage, index: i, width: NODE_WIDTH, height },
      draggable: false,
      selectable: false,
      connectable: false,
    };
  });
  return { nodes, edges };
}
