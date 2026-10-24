import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import { STAGE_TITLES } from './adapter';
import type { TraceStage } from './types';

export const NODE_WIDTH = 148;

/** The acting system is named where it matters: who decided, and which human. */
export function showsSystem(stage: TraceStage): boolean {
  return (stage.kind === 'decided' || stage.kind === 'human') && stage.system !== STAGE_TITLES[stage.kind];
}

/** Nodes show a title and one value; captions, rationale and checks open on hover. */
export function nodeHeight(stage: TraceStage): number {
  return stage.checks ? 70 : 60;
}

export interface StageNodeData extends Record<string, unknown> {
  stage: TraceStage;
  index: number;
  width: number;
  height: number;
  /** The stage the decision ended on; drawn with a soft glow. */
  final: boolean;
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
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 40, marginx: 0, marginy: 0 });
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

  const finalIndex = (() => {
    for (let i = stages.length - 1; i >= 0; i--) {
      if (stages[i].kind === 'decided' || stages[i].kind === 'human') return i;
    }
    return stages.length - 1;
  })();

  const nodes: StageNode[] = stages.map((stage, i) => {
    const { x, y } = g.node(String(i));
    const height = nodeHeight(stage);
    return {
      id: String(i),
      type: 'stage',
      position: { x: x - NODE_WIDTH / 2, y: y - height / 2 },
      width: NODE_WIDTH,
      height,
      data: { stage, index: i, width: NODE_WIDTH, height, final: i === finalIndex },
      draggable: false,
      selectable: false,
      connectable: false,
    };
  });
  return { nodes, edges };
}
