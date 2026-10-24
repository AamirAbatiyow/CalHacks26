import type {
  DecidedBy,
  DecisionRow,
  DecisionTrace,
  Headline,
  PipelineStepRow,
  ReverifyCheck,
  StageKind,
  StageTone,
  TraceStage,
} from './types';
import type { ClaimDecision, Claim, DecisionRecord, EscalatedClaim } from '../types';

export const AUTO_CONFIDENCE_PCT = 95;

const DECISION_LABELS: Record<string, string> = {
  DisputeCreated: 'Dispute created',
  DisputeResolved: 'Dispute resolved',
  CreditIssued: 'Credit issued',
  PassDropped: 'Pass dropped',
  PassRecovered: 'Pass recovered',
};

export function fromAuditRecord(record: DecisionRecord): DecisionRow {
  const outcome = (() => {
    switch (record.outcome) {
      case 'AutoApproved': return 'auto' as const;
      case 'Approved': return 'approved' as const;
      case 'Denied': return 'denied' as const;
      case 'Escalated': return 'escalated' as const;
      default: return 'pending' as const;
    }
  })();
  const ref = record.passId != null ? `Pass #${record.passId}` : record.stationId ?? `Decision #${record.id}`;
  const amount = Math.abs(Number(record.amountCents));
  return {
    key: `audit:${record.id}`,
    title: `${ref} · ${DECISION_LABELS[record.decisionType] ?? record.decisionType}`,
    subject: record.stationId ?? ref,
    claimedCents: amount,
    creditCents: outcome === 'denied' || record.decisionType === 'PassRecovered' || outcome === 'pending' ? 0 : amount,
    confidencePct: null,
    outcome,
    reason: record.reason,
    policyVersion: record.policyVersion,
    modelVersion: record.modelVersion,
  };
}

export function fromClaimDecision(claim: Claim, decision: ClaimDecision, topFeature?: string): DecisionRow {
  return {
    key: `claim:${claim.id}`,
    title: `${claim.id} · Claim decision`,
    subject: claim.customerName,
    claimedCents: Number(claim.amountClaimedCents),
    creditCents: Number(decision.creditAmountCents),
    confidencePct: decision.confidencePercent,
    outcome: decision.gate === 'Auto' ? 'auto' : 'escalated',
    reason: decision.rule,
    policyVersion: decision.policyVersion,
    modelVersion: decision.modelVersion,
    topFeature,
  };
}

export function fromEscalatedClaim(claim: EscalatedClaim): DecisionRow {
  const outcome = claim.status === 'Pending' ? 'pending' : claim.status === 'Denied' ? 'denied' : 'approved';
  return {
    key: `approval:${claim.id}`,
    title: `${claim.customerName} · Escalated claim`,
    subject: claim.customerName,
    claimedCents: Number(claim.amountClaimedCents),
    creditCents: outcome === 'denied' ? 0 : Number(claim.proposedAmountCents),
    confidencePct: claim.confidencePct,
    outcome,
    reason: claim.escalationReason,
    policyVersion: claim.policyVersion,
    modelVersion: claim.modelVersion,
  };
}

/** The decision's real path from the pipeline audit when it has one, else a seeded example path. */
export function buildTrace(row: DecisionRow, steps: PipelineStepRow[] = []): DecisionTrace {
  const own = steps.filter(s => s.decisionKey === row.key).sort((a, b) => a.seq - b.seq);
  return own.length > 0 ? traceFromPipeline(row, own) : seededTrace(row);
}

function toneOf(verdict: string): StageTone {
  const v = verdict.toLowerCase();
  if (/(deny|denied|flag|block|reject)/.test(v)) return 'block';
  if (/(escalat|disagree|fail|pending|await)/.test(v)) return 'warn';
  if (/(allow|pass|clean|agree|approv|decided|promot)/.test(v)) return 'pass';
  return 'neutral';
}

function traceFromPipeline(row: DecisionRow, steps: PipelineStepRow[]): DecisionTrace {
  const retrainAt = steps.findIndex(s => s.stage === 'retrain');
  const stages = steps.map<TraceStage>((s) => {
    const headline: Headline =
      s.confidencePct != null && (s.stage === 'system1' || s.stage === 'retrain')
        ? { kind: 'pct', value: s.confidencePct, digits: 1 }
        : s.amountCents != null
          ? { kind: 'usd', cents: s.amountCents }
          : { kind: 'text', text: s.verdict };
    return {
      kind: s.stage,
      system: s.system,
      version: s.version,
      headline,
      caption: s.note,
      note: s.stage === 'system2' ? s.note : undefined,
      tone: toneOf(s.verdict),
      parent: s.stage === 'proposal' && retrainAt >= 0 ? retrainAt : undefined,
      href: s.stage === 'proposal' ? '#/policies' : undefined,
    };
  });
  const last = steps[steps.length - 1];
  const decidedBy: DecidedBy = steps.some(s => s.stage === 'human')
    ? (toneOf(steps.find(s => s.stage === 'human')!.verdict) === 'warn' ? 'pending' : 'human')
    : steps.some(s => s.stage === 'system2') ? 'system2' : 'system1';
  return {
    key: row.key,
    title: row.title,
    subject: row.subject,
    claimedCents: row.claimedCents,
    amountCents: last?.amountCents ?? row.creditCents,
    decidedBy,
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
    source: 'pipeline',
    stages,
  };
}

// ---------------------------------------------------------------------------
// Seeded example paths. Deterministic per decision key so a replay is stable.

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(h: number, salt: number, min: number, max: number, digits = 1): number {
  const unit = ((h >>> (salt % 24)) ^ (h * (salt + 1))) % 1000 / 1000;
  const f = 10 ** digits;
  return Math.round((min + Math.abs(unit) * (max - min)) * f) / f;
}

function usd(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}

function bumpVersion(version: string): string {
  const m = version.match(/^(v?)(\d+)(?:\.(\d+))?/);
  if (!m) return `${version}.1`;
  return `${m[1]}${m[2]}.${(Number(m[3] ?? 0)) + 1}`;
}

function nextPolicy(version: string): string {
  const m = version.match(/^(v?)(\d+)/);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${version}+1`;
}

function seededRoute(row: DecisionRow): DecidedBy {
  if (row.outcome === 'auto') return 'system1';
  if (row.outcome === 'pending' || row.outcome === 'escalated') return 'pending';
  if (/review|escalat|edited/i.test(row.reason)) return 'human';
  return 'system2';
}

function rationaleFor(row: DecisionRow, h: number, credit: number): string {
  const gap = Math.round(pick(h, 3, 3, 11, 0));
  if (/recover|backup/i.test(row.reason) || /recovered/i.test(row.title)) {
    return 'Backup station captured the full pass; revenue is recoverable and no SLA credit is owed.';
  }
  if (/degrad|partial|link quality/i.test(row.reason)) {
    return `Customer packet-loss report matches the station SNR trace. Degradation was partial, so credit is pro-rated to ${usd(credit)}.`;
  }
  if (/incomplete|transfer/i.test(row.reason)) {
    return 'Transfer log ends early but the checksum manifest is missing; the loss cannot be sized from evidence alone.';
  }
  if (/threshold|exceeds/i.test(row.reason)) {
    return `Claim exceeds the verified loss: telemetry covers ${gap} min of outage, not the full contact claimed.`;
  }
  return `Downlink lost ${gap} min into contact and ground logs show no frames after loss of signal. Verified loss supports ${usd(credit)}.`;
}

function seededTrace(row: DecisionRow): DecisionTrace {
  const h = hash(row.key);
  const route = seededRoute(row);
  const model = row.modelVersion;
  const policy = row.policyVersion;
  const stages: TraceStage[] = [];
  const push = (stage: TraceStage) => stages.push(stage) - 1;

  push({
    kind: 'claim',
    system: 'Intake',
    version: null,
    headline: { kind: 'usd', cents: row.claimedCents },
    caption: `${row.subject} · claimed`,
    tone: 'neutral',
  });

  const s1Confidence = row.confidencePct
    ?? (route === 'system1' ? pick(h, 1, 95.4, 99.2)
      : route === 'system2' ? pick(h, 1, 81, 93.8)
        : pick(h, 1, 58, 79));
  const toCedar = s1Confidence >= AUTO_CONFIDENCE_PCT;
  push({
    kind: 'system1',
    system: 'System 1',
    version: model,
    headline: { kind: 'pct', value: s1Confidence, digits: Number.isInteger(s1Confidence) ? 0 : 1 },
    caption: row.topFeature ? `confidence · ${row.topFeature}` : 'confidence · features only',
    tone: toCedar ? 'pass' : 'neutral',
    untaken: toCedar ? '< 95% → injection screen' : '≥ 95% → Cedar',
  });

  if (toCedar) {
    const allow = route === 'system1';
    const [ruleName, ruleWhy] = row.reason.includes(':') ? row.reason.split(/:\s*/, 2) : ['credit::issue', ''];
    push({
      kind: 'cedar',
      system: 'Cedar',
      version: policy,
      headline: { kind: 'text', text: allow ? 'ALLOW' : 'DENY' },
      caption: allow ? `credit::issue · ${usd(row.creditCents)}` : `${ruleName} · ${usd(row.creditCents)}`,
      note: allow ? undefined : ruleWhy || undefined,
      tone: allow ? 'pass' : 'block',
      untaken: allow ? 'deny → human' : 'allow → decided',
    });
    if (allow) {
      push({
        kind: 'decided',
        system: 'System 1',
        version: model,
        headline: { kind: 'usd', cents: row.creditCents },
        caption: row.creditCents >= row.claimedCents ? 'auto-decided · full credit' : 'auto-decided · partial credit',
        tone: 'pass',
      });
      return finish(row, 'system1', stages);
    }
  } else {
    const patterns = 23;
    push({
      kind: 'injection',
      system: 'Injection screen',
      version: 'v1.3',
      headline: { kind: 'text', text: 'Clean' },
      caption: `0 / ${patterns} patterns matched`,
      tone: 'pass',
      untaken: 'flagged → human',
    });

    const proposed = route === 'system2' || row.creditCents > 0 ? row.creditCents : row.claimedCents;
    const s2Confidence = pick(h, 5, route === 'system2' ? 90 : 71, route === 'system2' ? 97 : 88);
    push({
      kind: 'system2',
      system: 'System 2',
      version: 'analyst-p7',
      headline: { kind: 'usd', cents: proposed },
      caption: `proposed credit · ${s2Confidence}% sure`,
      note: rationaleFor(row, h, proposed),
      tone: 'neutral',
    });

    const humanBound = route !== 'system2';
    const failing: number = humanBound ? (h % 2 === 0 ? 2 : 0) : -1;
    const checks: ReverifyCheck[] = [
      { label: 'Evidence exists', ok: failing !== 0 },
      { label: `Cedar allows · ${policy}`, ok: failing !== 1 },
      { label: failing === 2 ? `System 1 disagrees · ${s1Confidence}%` : 'System 1 agrees', ok: failing !== 2 },
    ];
    const passed = checks.filter(c => c.ok).length;
    push({
      kind: 'reverify',
      system: 'Re-verify',
      version: policy,
      headline: { kind: 'text', text: `${passed}/${checks.length} checks` },
      caption: humanBound ? 'check failed · escalate' : 'all checks pass',
      checks,
      tone: humanBound ? 'warn' : 'pass',
      untaken: humanBound ? 'pass → decided' : 'fail → human',
    });

    if (!humanBound) {
      push({
        kind: 'decided',
        system: 'System 2',
        version: 'analyst-p7',
        headline: { kind: 'usd', cents: row.creditCents },
        caption: row.creditCents === 0 ? 'decided · no credit' : row.creditCents >= row.claimedCents ? 'decided · full credit' : 'decided · partial credit',
        tone: 'pass',
      });
      return finish(row, 'system2', stages);
    }
  }

  if (route === 'pending') {
    push({
      kind: 'human',
      system: 'Ops Reviewer',
      version: null,
      headline: { kind: 'text', text: 'Awaiting review' },
      caption: `${usd(row.claimedCents)} in review`,
      note: toCedar ? undefined : row.reason,
      tone: 'warn',
    });
    return finish(row, 'pending', stages);
  }

  const approved = row.outcome !== 'denied';
  const share = row.claimedCents > 0 ? Math.round((row.creditCents / row.claimedCents) * 100) : 0;
  push({
    kind: 'human',
    system: 'Ops Reviewer',
    version: null,
    headline: { kind: 'usd', cents: row.creditCents },
    caption: approved ? `approved · ${share}% credited` : 'denied · no credit',
    tone: 'warn',
  });

  const labels = Math.round(pick(h, 7, 3400, 3600, 0));
  push({
    kind: 'label',
    system: 'Label store',
    version: null,
    headline: { kind: 'text', text: approved ? 'Loss confirmed' : 'No loss' },
    caption: `+1 label · ${(labels + 1).toLocaleString('en-US')} total`,
    tone: 'neutral',
  });

  const before = pick(h, 9, 91.2, 94.0);
  const after = Math.round((before + pick(h, 11, 0.2, 0.9)) * 10) / 10;
  const replayed = Math.round(pick(h, 13, 1100, 1400, 0));
  const retrainAt = push({
    kind: 'retrain',
    system: 'System 1 trainer',
    version: model,
    headline: { kind: 'pct', value: after, digits: 1 },
    caption: `precision · was ${before}%`,
    detail: `${replayed.toLocaleString('en-US')} past claims replayed`,
    tone: 'pass',
  });

  push({
    kind: 'model',
    system: 'Model registry',
    version: null,
    headline: { kind: 'text', text: bumpVersion(model) },
    caption: `new System 1 · was ${model}`,
    tone: 'pass',
  });

  if (h % 3 !== 0) {
    const similar = Math.round(pick(h, 15, 3, 9, 0));
    push({
      kind: 'proposal',
      system: 'Policy learner',
      version: nextPolicy(policy),
      headline: { kind: 'text', text: `Policy ${nextPolicy(policy)}` },
      caption: `${similar} similar overrides · proposed`,
      tone: 'neutral',
      parent: retrainAt,
      href: '#/policies',
    });
  }

  return finish(row, 'human', stages);
}

function finish(row: DecisionRow, decidedBy: DecidedBy, stages: TraceStage[]): DecisionTrace {
  return {
    key: row.key,
    title: row.title,
    subject: row.subject,
    claimedCents: row.claimedCents,
    amountCents: row.creditCents,
    decidedBy,
    policyVersion: row.policyVersion,
    modelVersion: row.modelVersion,
    source: 'seeded',
    stages,
  };
}

export const STAGE_TITLES: Record<StageKind, string> = {
  claim: 'Claim',
  system1: 'System 1',
  cedar: 'Cedar check',
  injection: 'Injection screen',
  system2: 'System 2',
  reverify: 'Re-verify',
  decided: 'Decided',
  human: 'Human',
  label: 'Labeled',
  retrain: 'Retrain + replay',
  model: 'New model',
  proposal: 'Policy proposal',
};
