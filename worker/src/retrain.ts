import { featurize, type Snapshot } from './features.ts';
import { evaluate, fit, type Metrics } from './system1.ts';

export interface Label {
  id: number;
  snapshot: Snapshot;
  approve: boolean;
  source: 'history' | 'live';
  reviewer: string;
  decisiveEvidence: string[];
  claimType: string;
}

/**
 * Weight of a live human decision relative to one historical row. A recent
 * reviewer decision on a sparse kind of claim should move the model now rather
 * than be diluted by six months of unrelated history.
 */
export const LIVE_LABEL_WEIGHT = Number(process.env.LIVE_LABEL_WEIGHT ?? 20);

export interface RetrainResult {
  weights: number[];
  metrics: Metrics;
  previous: Metrics | null;
  promote: boolean;
  reason: string;
  trainedRows: number;
  liveLabels: number;
  fitMs: number;
  replayMs: number;
}

export function design(labels: Label[]) {
  return {
    X: labels.map(l => featurize(l.snapshot)),
    y: labels.map(l => (l.approve ? 1 : 0)),
    w: labels.map(l => (l.source === 'live' ? LIVE_LABEL_WEIGHT : 1)),
  };
}

/**
 * Refits System 1 on every human-labeled decision (never on automated or
 * rule-made ones), replays the candidate and the current model on the same labeled
 * history, and promotes only if auto-approve precision does not regress.
 */
export function retrain(labels: Label[], current: number[] | null): RetrainResult {
  const { X, y, w } = design(labels);
  const t0 = performance.now();
  const { weights } = fit(X, y, w, { init: current ?? undefined });
  const t1 = performance.now();
  const metrics = evaluate(weights, X, y);
  const previous = current ? evaluate(current, X, y) : null;
  const t2 = performance.now();
  const promote = previous === null || metrics.precisionPct >= previous.precisionPct;
  const reason = previous === null
    ? 'bootstrap fit on labeled history'
    : promote
      ? `precision ${previous.precisionPct}% -> ${metrics.precisionPct}%`
      : `rejected: precision would regress ${previous.precisionPct}% -> ${metrics.precisionPct}%`;
  return {
    weights,
    metrics,
    previous,
    promote,
    reason,
    trainedRows: labels.length,
    liveLabels: labels.filter(l => l.source === 'live').length,
    fitMs: Math.round((t1 - t0) * 100) / 100,
    replayMs: Math.round((t2 - t1) * 100) / 100,
  };
}
