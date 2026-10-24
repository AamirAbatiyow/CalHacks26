/** One step of a decision's path through the pipeline. */
export type StageKind =
  | 'claim'
  | 'system1'
  | 'cedar'
  | 'injection'
  | 'system2'
  | 'reverify'
  | 'decided'
  | 'human'
  | 'label'
  | 'retrain'
  | 'model'
  | 'proposal';

/** Visual state of a stage: `warn` is an escalation, `block` a deny or flagged input. */
export type StageTone = 'neutral' | 'pass' | 'warn' | 'block';

/** Headline output of a stage; numeric values count up as the node draws in. */
export type Headline =
  | { kind: 'pct'; value: number; digits?: number }
  | { kind: 'usd'; cents: number }
  | { kind: 'text'; text: string };

export interface ReverifyCheck {
  label: string;
  ok: boolean;
}

export interface TraceStage {
  kind: StageKind;
  /** Which system acted at this stage, e.g. `System 1`, `Cedar`, `Ops Reviewer`. */
  system: string;
  /** Model, policy, screen or prompt version the system ran at. */
  version: string | null;
  headline: Headline;
  caption: string;
  /** Optional second caption line. */
  detail?: string;
  /** Quoted text: the System 2 rationale snippet, or the escalation reason a human sees. */
  note?: string;
  checks?: ReverifyCheck[];
  tone: StageTone;
  /** Index of the stage this one follows from; defaults to the previous stage. */
  parent?: number;
  /** Label of the branch this stage could have taken but did not. */
  untaken?: string;
  href?: string;
}

export type DecidedBy = 'system1' | 'rule' | 'system2' | 'human' | 'pending';

export interface DecisionTrace {
  /** Stable key used in the `?replay=` hash param, e.g. `audit:12`, `claim:CLM-10021`. */
  key: string;
  title: string;
  subject: string;
  claimedCents: number;
  amountCents: number;
  decidedBy: DecidedBy;
  policyVersion: string;
  modelVersion: string;
  /** `pipeline` when read from the decision pipeline's audit path, `seeded` for example paths. */
  source: 'pipeline' | 'seeded';
  stages: TraceStage[];
}

/** A decision row from any table, normalized so a trace can be built from it. */
export interface DecisionRow {
  key: string;
  title: string;
  subject: string;
  claimedCents: number;
  creditCents: number;
  /** System 1 confidence when the row records it (claim decisions, escalations). */
  confidencePct: number | null;
  outcome: 'auto' | 'approved' | 'denied' | 'escalated' | 'pending';
  reason: string;
  policyVersion: string;
  modelVersion: string;
  /** Strongest SHAP feature behind System 1's confidence, when known. */
  topFeature?: string;
  /** Key of the pipeline path this row's decision belongs to, when it differs from `key`. */
  pipelineKey?: string;
}

/**
 * One row of the decision pipeline's audit path: which system decided at which
 * stage, at which version, with what verdict. Mirrors the module's `pipeline_step`
 * table (`server/spacetimedb/src/pipeline.rs`); `traceFromPipeline` is the only
 * place that reads it.
 */
export interface PipelineStepRow {
  decisionKey: string;
  seq: number;
  stage: StageKind;
  system: string;
  version: string | null;
  verdict: string;
  confidencePct: number | null;
  amountCents: number | null;
  note: string;
  /** Quoted text: System 2's rationale, an escalation reason, a rule description. */
  detail?: string;
  checks?: ReverifyCheck[];
}
