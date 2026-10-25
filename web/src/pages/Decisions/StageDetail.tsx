import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Database, FileText, Play, RefreshCw, Shuffle, Zap } from 'lucide-react';
import { tag } from '../../hooks/useTable';
import { CLAIM_TYPE_LABELS, parseJson, type CaseSnapshot, type LabeledDecisionRow, type LearnedRuleRow } from '../../hooks/useDecisions';
import { openReplay } from '../../replay/useDecisionTrace';
import { Chip } from '../../ui/Chip';
import { Fact } from '../../ui/Drawer';
import { SplitBar } from '../../ui/charts';
import { usd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { AUTO_DECIDE_PCT, confidencePct, drivers, featurize, FEATURE_LABELS, laneOf, type Lane } from './system1';
import type { StageCard } from './PipelineMap';
import { STAGE_ORDER, type StageId } from './stages';
import type { PipelineData } from './usePipeline';

/** Mirrors `HUMAN_REVIEW_COST_CENTS` and `AI_REVIEW_COST_CENTS` in `kpis.rs`. */
const HUMAN_REVIEW_CENTS = 30000;
const AI_REVIEW_CENTS = 1500;

const LANE_LABEL: Record<StageCard['lane'], string> = {
  intake: 'Every claim',
  fast: 'Fast lane',
  deep: 'Deep review',
  outcome: 'Outcome',
  human: 'Human in the loop',
};

const pct = (v: number, digits = 1) => `${v.toFixed(digits)}%`;
const count = (n: number) => n.toLocaleString('en-US');
const yesNo = (v: boolean) => (v ? 'yes' : 'no');

function claimTypeLabel(key: string): string {
  const camel = key.split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join('');
  return CLAIM_TYPE_LABELS[camel] ?? key.replace(/_/g, ' ');
}

function Card({ title, children, wide, className = '' }: { title: string; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className={`sd-card ${wide ? 'wide' : ''} ${className}`}>
      <span className="sd-card-title">{title}</span>
      {children}
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'pass' | 'warn' | 'block' | 'accent' }) {
  return (
    <div className={`sd-tile ${tone ? `tone-${tone}` : ''}`}>
      <span className="sd-tile-label">{label}</span>
      <span className="sd-tile-value">{value}</span>
      {hint && <span className="sd-tile-hint">{hint}</span>}
    </div>
  );
}

function Tech({ items }: { items: Record<string, ReactNode> }) {
  return (
    <div className="sd-facts">
      {Object.entries(items).map(([k, v]) => <Fact key={k} label={k} value={v} />)}
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="sd-code">{children}</code>;
}

function Bullets({ items }: { items: ReactNode[] }) {
  return <ul className="sd-bullets">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>;
}

/** The facts from a case snapshot that System 1 reads, in plain words. */
function EvidenceFacts({ s }: { s: CaseSnapshot }) {
  const rows: [string, string][] = [
    ['Claim', `${claimTypeLabel(s.claim.claim_type)} · ${s.claim.customer}`],
    ['Data lost (telemetry)', `${s.telemetry.loss_pct}%`],
    ['Space weather', `Kp ${s.weather.kp_index.toFixed(1)} · ${s.weather.storm ? 'storm' : 'no storm'}`],
    ['Contract excludes space weather', yesNo(s.contract.weather_exclusion)],
    ['Filed', `${s.contract.days_since_pass} days after the pass (window ${s.contract.claim_window_days})`],
    ['Claimed vs. contract entitlement', `${usd(s.claim.amount_claimed_cents)} vs. ${usd(s.contract.entitled_credit_cents)}`],
    ['Station drop rate, 30 days', `${s.station_history.drop_rate_pct}%`],
    ['Maintenance overlapped the pass', yesNo(s.station_history.maintenance_overlap)],
  ];
  return <div className="sd-facts">{rows.map(([k, v]) => <Fact key={k} label={k} value={v} />)}</div>;
}

function laneChip(lane: Lane) {
  if (lane === 'deep') return <Chip tone="accent">Deep review</Chip>;
  return <Chip tone="pass" icon={Zap}>Fast lane · {lane === 'fast-approve' ? 'auto-approve' : 'auto-deny'}</Chip>;
}

function verdictWord(l: LabeledDecisionRow) {
  return tag(l.verdict) === 'Approve' ? `Approved ${usd(l.creditCents)}` : 'Denied';
}

/** One real labeled human ruling, shown as a training row: inputs, label, and what the live model says now. */
function TrainingRow({ d, label, tech }: { d: PipelineData; label: LabeledDecisionRow; tech: boolean }) {
  const s = parseJson<CaseSnapshot>(label.snapshotJson);
  if (!s || !d.model) return null;
  const x = featurize(s, d.model.names);
  const scored = d.history?.byId.get(Number(label.id));
  const p = scored?.pApprove ?? 0.5;
  const top = drivers(d.model.weights, x, d.model.names, 3);
  return (
    <div className="sd-train">
      <div className="sd-train-head">
        <span className="sd-mono">{label.claimRef}</span>
        <span className="ui-muted">{label.source === 'live' ? 'live ruling' : 'historical ruling'} · row #{String(label.id)} of <Code>labeled_decision</Code></span>
      </div>
      <div className="sd-train-grid">
        <div>
          <span className="sd-sub">What the model reads (numbers only)</span>
          <EvidenceFacts s={s} />
        </div>
        <div className="sd-train-right">
          <span className="sd-sub">The answer it learns from</span>
          <div className="sd-label">
            <Chip tone={tag(label.verdict) === 'Approve' ? 'pass' : 'block'}>{verdictWord(label)}</Chip>
            <span className="ui-muted">by reviewer {label.reviewer}</span>
          </div>
          {label.reasonText && <p className="ui-quote">{label.reasonText}</p>}
          {label.decisiveEvidence.length > 0 && (
            <div className="ui-chips">{label.decisiveEvidence.map(e => <Chip key={e} icon={FileText}>decisive: {e.replace(/_/g, ' ')}</Chip>)}</div>
          )}
          <span className="sd-sub">What {d.active ? `s1-v${d.active.version}` : 'System 1'} says about it today</span>
          <div className="sd-label">
            <b className="sd-big">{pct(confidencePct(p))}</b>
            <span className="ui-muted">sure it should be {p >= 0.5 ? 'approved' : 'denied'}</span>
            {laneChip(laneOf(p))}
          </div>
          {top.length > 0 && (
            <div className="sd-drivers">
              {top.map(t => (
                <span key={t.name} className={`sd-driver ${t.contribution > 0 ? 'up' : 'down'}`}>
                  {t.contribution > 0 ? '▲' : '▼'} {t.label}{tech ? ` ${t.contribution > 0 ? '+' : ''}${t.contribution.toFixed(2)}` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {tech && (
        <details className="sd-raw">
          <summary>Feature vector ({d.model.names.length} numbers)</summary>
          <div className="ui-chips">
            {d.model.names.map((n, i) => <Chip key={n}>{n} = {Math.round(x[i] * 1000) / 1000}</Chip>)}
          </div>
        </details>
      )}
    </div>
  );
}

function System1Detail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const [mode, setMode] = useState<'fast' | 'deep'>('fast');
  const [index, setIndex] = useState(0);
  const m = d.active;
  const split = d.history?.split;

  const examples = useMemo(() => {
    if (!d.history) return { fast: [] as number[], deep: [] as number[] };
    const fastApprove = d.history.rows.filter(r => r.lane === 'fast-approve' && r.agrees).map(r => r.id);
    const fastDeny = d.history.rows.filter(r => r.lane === 'fast-deny' && r.agrees).map(r => r.id);
    const fast: number[] = [];
    for (let i = 0; i < Math.max(fastApprove.length, fastDeny.length); i++) {
      if (i < fastApprove.length) fast.push(fastApprove[i]);
      if (i < fastDeny.length) fast.push(fastDeny[i]);
    }
    return { fast, deep: d.history.rows.filter(r => r.lane === 'deep').map(r => r.id) };
  }, [d.history]);

  const list = examples[mode];
  const exampleId = list.length ? list[index % list.length] : null;
  const example = exampleId !== null ? d.labelById.get(BigInt(exampleId)) ?? null : null;

  const weights = useMemo(() => {
    if (!d.model) return [];
    const rows = d.model.names.map((n, i) => ({ n, w: d.model!.weights[i] })).filter(r => r.n !== 'bias');
    const top = rows.sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 7);
    const max = Math.max(...top.map(r => Math.abs(r.w)), 1e-9);
    return top.map(r => ({ ...r, share: Math.abs(r.w) / max }));
  }, [d.model]);

  return (
    <>
      <div className="sd-callout">
        <div className="sd-callout-icon"><Zap size={18} aria-hidden /></div>
        <div className="sd-callout-body">
          <span className="sd-callout-title">Fast pass: a confident System 1 decides the claim without the LLM</span>
          <p>
            If System 1 is at least {AUTO_DECIDE_PCT}% sure, the claim skips System 2 entirely. It goes straight to Cedar for permission and is paid
            or denied in the same database transaction. Only claims System 1 is unsure about pay for the slower, costlier LLM review.
          </p>
          {split && split.total > 0 && (
            <>
              <div className="sd-callout-stats">
                <Tile tone="pass" label="Fast lane on past claims" value={pct(split.fastPct)} hint={`${count(split.fastApprove + split.fastDeny)} of ${count(split.total)} human rulings`} />
                <Tile tone="pass" label="Fast lane matches the human" value={pct(split.fastAgreePct)} hint={`${count(split.fastApproveAgree + split.fastDenyAgree)} of ${count(split.fastApprove + split.fastDeny)}`} />
                <Tile tone="accent" label="Sent to deep review" value={pct(100 - split.fastPct)} hint={`${count(split.deep)} rulings under ${AUTO_DECIDE_PCT}% sure`} />
              </div>
              <SplitBar
                label="How System 1 splits past human rulings"
                parts={[
                  { label: `Fast lane, auto-approve (${count(split.fastApprove)})`, value: split.fastApprove, color: 'var(--color-green)' },
                  { label: `Fast lane, auto-deny (${count(split.fastDeny)})`, value: split.fastDeny, color: 'rgba(34, 197, 94, 0.55)' },
                  { label: `Deep review (${count(split.deep)})`, value: split.deep, color: 'var(--color-accent)', pattern: true },
                ]}
              />
              <div className="ui-legend">
                <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: 'var(--color-green)' }} />Fast, approve <b>{count(split.fastApprove)}</b></span>
                <span className="ui-legend-item"><span className="ui-legend-swatch" style={{ background: 'rgba(34, 197, 94, 0.55)' }} />Fast, deny <b>{count(split.fastDeny)}</b></span>
                <span className="ui-legend-item"><span className="ui-legend-swatch hatched" style={{ color: 'var(--color-accent)' }} />Deep review <b>{count(split.deep)}</b></span>
                <span className="ui-legend-item">Scored in your browser: {m ? `s1-v${m.version}` : 'System 1'} applied to every row of <Code>labeled_decision</Code></span>
              </div>
            </>
          )}
          <p className="sd-fine">
            Two exceptions always take deep review, even when System 1 is sure: a denial when the customer wrote a message, and any late-delivery
            claim with a message. Someone has to read the customer's side first.
          </p>
        </div>
      </div>

      <div className="sd-grid">
        <Card title="The model">
          {m ? (
            <Tech items={{
              'Name': <span className="sd-mono sd-amber">s1-v{m.version} · {tag(m.status)}</span>,
              'Kind': 'Logistic regression, L2-regularised',
              'Reads': `${d.model?.names.length ?? 19} numbers from the evidence, never the customer's text`,
              'Trained on': `${count(m.trainedRows)} human rulings${m.liveLabels ? ` (${m.liveLabels} live)` : ''}`,
              'Retrains': 'on every new human ruling; promoted only if precision does not drop',
              'Fit time': `${m.fitMs.toFixed(0)} ms (Newton steps)`,
              'Runs in': <>TypeScript worker; weights in SpacetimeDB <Code>model_version</Code></>,
              'Writes back via': <Code>submit_system1</Code>,
            }} />
          ) : <EmptyState art="graph" compact title="No model yet" hint="Start the worker: cd worker && npm start" />}
        </Card>

        <Card title="How good it is">
          {m ? (
            <>
              <div className="sd-tiles">
                <Tile tone="pass" label="Precision when it auto-approves" value={pct(m.precisionPct, 2)} hint="share a human also approved" />
                <Tile label="Auto-approve coverage" value={pct(m.coveragePct)} hint="past claims it would approve alone" />
                <Tile label="Accuracy, all claims" value={pct(m.accuracyPct, 2)} hint="leaning verdict vs. the human" />
                <Tile label="Calibration error (ECE)" value={m.ece.toFixed(3)} hint={`Brier ${m.brier.toFixed(3)} · 0 is perfect`} />
              </div>
              <p className="sd-fine">
                Calibration means its confidence can be taken at face value: when it says 97%, it is right about 97% of the time. That is what makes a
                fixed {AUTO_DECIDE_PCT}% gate safe.
              </p>
            </>
          ) : <span className="ui-muted">Waiting for the first model.</span>}
        </Card>

        <Card title="What moves it most">
          <div className="sd-weights">
            {weights.map(r => (
              <div key={r.n} className="sd-weight">
                <span className="sd-weight-label">{FEATURE_LABELS[r.n] ?? r.n}</span>
                <span className="sd-weight-bar"><span className={r.w > 0 ? 'up' : 'down'} style={{ width: `${Math.max(6, r.share * 100)}%` }} /></span>
                <span className={`sd-weight-dir ${r.w > 0 ? 'up' : 'down'}`}>{r.w > 0 ? 'toward approve' : 'toward deny'}{tech ? ` ${r.w > 0 ? '+' : ''}${r.w.toFixed(2)}` : ''}</span>
              </div>
            ))}
          </div>
          <p className="sd-fine">Largest learned weights in {m ? `s1-v${m.version}` : 'the active model'}. The pass-failure score comes from a fixed stand-in model (<Code>ml-proxy-0</Code>).</p>
        </Card>

        <Card title="Training data: a real labeled ruling" wide>
          <div className="sd-toolbar">
            <div className="sd-seg" role="tablist" aria-label="Example type">
              <button role="tab" aria-selected={mode === 'fast'} className={mode === 'fast' ? 'on' : ''} onClick={() => { setMode('fast'); setIndex(0); }}>
                <Zap size={11} /> Fast-lane example
              </button>
              <button role="tab" aria-selected={mode === 'deep'} className={mode === 'deep' ? 'on' : ''} onClick={() => { setMode('deep'); setIndex(0); }}>
                Deep-review example
              </button>
            </div>
            <button className="dz-btn" onClick={() => setIndex(i => i + 1)} disabled={list.length < 2}><Shuffle size={12} /> Another ruling</button>
            <span className="ui-muted">{list.length ? `${(index % list.length) + 1} of ${count(list.length)}` : ''}</span>
          </div>
          {example ? <TrainingRow d={d} label={example} tech={tech} /> : <span className="ui-muted">No labeled rulings loaded yet.</span>}
        </Card>

        {tech && d.models.length > 0 && (
          <Card title="Versions" wide>
            <div className="dz-table">
              <div className="dz-tr dz-th"><span>Version</span><span>Status</span><span>Precision</span><span>Coverage</span><span>Labels · note</span></div>
              {d.models.slice(0, 8).map(v => (
                <div key={v.version} className={`dz-tr ${tag(v.status) === 'Active' ? 'active' : ''}`}>
                  <span className="dz-mono">s1-v{v.version}</span>
                  <span><Chip tone={tag(v.status) === 'Active' ? 'pass' : 'neutral'}>{tag(v.status)}</Chip></span>
                  <span className="dz-num">{v.precisionPct.toFixed(2)}%</span>
                  <span className="dz-num">{v.coveragePct.toFixed(1)}%</span>
                  <span className="dz-num">{v.trainedRows.toLocaleString()} · {v.triggeredByLabel !== undefined ? `live in ${v.latencyMs.toFixed(0)} ms after label #${v.triggeredByLabel}` : v.note}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function ClaimsDetail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const latest = d.cases[0] ?? null;
  const s = latest ? parseJson<CaseSnapshot>(latest.snapshotJson) : null;
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Runs in': 'SpacetimeDB module (Rust compiled to WebAssembly)',
          'Reducer': <Code>file_case</Code>,
          'Reads': <><Code>pass</Code> <Code>pass_telemetry</Code> <Code>space_weather</Code> <Code>station_maintenance</Code> <Code>contract_term</Code></>,
          'Writes': <><Code>decision_case</Code> with the evidence snapshot; customer text goes to <Code>dispute_message</Code></>,
          'Pass-failure score': <><Code>ml-proxy-0</Code>, a fixed logistic stand-in for the pass-failure classifier</>,
        }} />
      </Card>
      <Card title="What it guarantees">
        <Bullets items={[
          'The evidence comes from the operator\'s own records, not from the customer\'s description.',
          'The contract formula sets the entitlement before any model runs, so no model can pay more than the contract allows.',
          'The customer\'s message is stored apart from the numbers. System 1 never sees it.',
        ]} />
        <div className="sd-tiles">
          <Tile label="Claims filed" value={count(d.cases.length)} />
          <Tile label="Amount claimed" value={usd(d.live.claimed)} />
        </div>
      </Card>
      <Card title={latest ? `Real example: ${latest.claimRef}` : 'Real example'}>
        {s ? (
          <>
            <EvidenceFacts s={s} />
            <span className="ui-muted">Pass #{s.pass.id} at {s.pass.station_id} · {s.contract.contract_id} {s.contract.tier} · clause {s.contract.sla_clause.split(' ')[0]}</span>
            {tech && <details className="sd-raw"><summary>Raw snapshot JSON</summary><pre>{JSON.stringify(s, null, 2)}</pre></details>}
          </>
        ) : <span className="ui-muted">No claim filed yet. File one below the map.</span>}
      </Card>
    </div>
  );
}

function RulesDetail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const [sel, setSel] = useState<bigint | null>(null);
  const rule: LearnedRuleRow | null = d.rules.find(r => r.id === sel) ?? d.rules[d.rules.length - 1] ?? null;
  const promoted = d.rules.filter(r => tag(r.status) === 'Promoted').length;
  const sources = rule ? rule.sourceLabelIds.map(id => d.labelById.get(id)).filter((l): l is LabeledDecisionRow => !!l) : [];
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Mined by': <>the worker's rule miner (<Code>miner.ts</Code>) from <Code>labeled_decision</Code></>,
          'Stored as': <>Cedar policy text in <Code>learned_rule</Code></>,
          'Evaluated by': 'Cedar inside the SpacetimeDB module, next to the base policy',
          'Fires only when': 'System 1 leans the same way and every condition holds',
          'Never reads': 'customer text',
        }} />
      </Card>
      <Card title="When a rule is written">
        <Bullets items={[
          'At least 3 rulings on the same kind of claim, made the same way.',
          'At least 3 different reviewers, citing the same deciding evidence.',
          'Zero past rulings that went the other way.',
          'Replayed on all labeled history. It goes live only if precision does not drop.',
        ]} />
        <div className="sd-tiles">
          <Tile tone="pass" label="Live rules" value={`${promoted} of ${d.rules.length}`} />
          <Tile label="Decided by a rule" value={count(d.live.rule)} hint="live claims" />
        </div>
      </Card>
      <Card title="Rules on record">
        {d.rules.length === 0 ? <span className="ui-muted">No consistent pattern in the labeled rulings yet.</span> : (
          <div className="sd-rules">
            {d.rules.map(r => (
              <button key={String(r.id)} className={`sd-rule ${rule?.id === r.id ? 'on' : ''}`} onClick={() => setSel(r.id)}>
                <span className="sd-mono">L{String(r.id)}</span>
                <Chip tone={tag(r.status) === 'Promoted' ? 'pass' : 'block'}>{tag(r.status)}</Chip>
                <span className="sd-rule-desc">{r.description}</span>
                <span className="ui-muted">{r.support} rulings · {r.distinctReviewers} reviewers · precision {r.precisionBefore.toFixed(2)}% → {r.precisionAfter.toFixed(2)}%</span>
              </button>
            ))}
          </div>
        )}
      </Card>
      {rule && (
        <Card title={`Training data: the rulings L${String(rule.id)} was learned from`} wide>
          <p className="sd-fine">{rule.support} human rulings, {rule.contradictions} contradictions. {sources.length > 3 ? `First 3 of ${sources.length} shown.` : ''}</p>
          <div className="sd-sources">
            {sources.slice(0, 3).map(l => {
              const s = parseJson<CaseSnapshot>(l.snapshotJson);
              return (
                <div key={String(l.id)} className="sd-source">
                  <div className="sd-train-head">
                    <span className="sd-mono">{l.claimRef}</span>
                    <Chip tone={tag(l.verdict) === 'Approve' ? 'pass' : 'block'}>{verdictWord(l)}</Chip>
                  </div>
                  <span className="ui-muted">{claimTypeLabel(l.claimType)} · {l.customer} · reviewer {l.reviewer}</span>
                  {s && <span className="ui-muted">{s.telemetry.loss_pct}% lost · Kp {s.weather.kp_index.toFixed(1)} · filed day {s.contract.days_since_pass} of {s.contract.claim_window_days} · claimed {usd(s.claim.amount_claimed_cents)} vs. {usd(s.contract.entitled_credit_cents)} entitled</span>}
                  {l.reasonText && <p className="ui-quote">{l.reasonText}</p>}
                </div>
              );
            })}
          </div>
          {tech && <pre className="dz-cedar">{rule.cedarText}</pre>}
        </Card>
      )}
    </div>
  );
}

function ScreenDetail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const last = d.live.lastScreen;
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Runs in': <>the TypeScript worker (<Code>screen.ts</Code>), before System 2</>,
          'Writes back via': <Code>submit_screen</Code>,
          'If flagged': 'the claim goes to a person and System 2 is never called',
        }} />
      </Card>
      <Card title="What it looks for">
        <Bullets items={[
          'Hidden Unicode tag characters, zero-width and right-to-left control characters.',
          'Look-alike letters from other alphabets (homoglyphs), after NFKC normalisation.',
          'Base64-encoded text, decoded and screened again.',
          'Instruction patterns such as "ignore previous instructions" or a fake "system:" line.',
        ]} />
      </Card>
      <Card title="Live">
        <div className="sd-tiles">
          <Tile label="Messages screened" value={count(d.live.screenedCases)} />
          <Tile tone={d.live.flagged ? 'block' : undefined} label="Flagged" value={count(d.live.flagged)} />
        </div>
        {last ? (
          <>
            <span className="sd-sub">Most recent result</span>
            <div className="sd-label"><Chip tone={last.verdict === 'Flagged' ? 'block' : 'pass'}>{last.verdict}</Chip><span className="ui-muted">{last.note}</span></div>
            {tech && last.detail && <p className="ui-quote">{last.detail}</p>}
          </>
        ) : <span className="ui-muted">No message screened yet.</span>}
      </Card>
    </div>
  );
}

function latestSystem2(d: PipelineData) {
  for (const c of d.cases) {
    const s2 = [...(d.stepsByCase.get(c.id) ?? [])].reverse().find(s => tag(s.system) === 'System2');
    if (s2) return { c, s2 };
  }
  return null;
}

function System2Detail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const latest = latestSystem2(d);
  const llm = d.worker?.llmModel ?? 'not connected';
  return (
    <>
      <div className="sd-grid">
        <Card title="Technology">
          <Tech items={{
            'Model': <span className="sd-mono">{llm}{d.worker?.mode === 'mock' ? ' (deterministic stand-in)' : ''}</span>,
            'Called via': 'any OpenAI-compatible chat endpoint, temperature 0',
            'Output': 'strict JSON schema: decision, confidence, credit, cited evidence, rationale',
            'Citations': "restricted by the schema to this claim's own evidence IDs",
            'Customer text': 'JSON-escaped between markers, never placed in the instructions',
            'Writes back via': <Code>submit_system2</Code>,
          }} />
        </Card>
        <Card title="Thresholds and limits">
          <Bullets items={[
            `Runs only when System 1 is under ${AUTO_DECIDE_PCT}% sure, no learned rule fits, and the message screen is clean.`,
            'It only proposes. It cannot write a decision, a payment or a policy.',
            `The proposal is automated only at ${AUTO_DECIDE_PCT}% confidence or more, after the module re-verifies it and Cedar allows it.`,
          ]} />
          <div className="sd-tiles">
            <Tile label="Claims it reviewed" value={count(d.live.s2Ran)} />
            <Tile tone={d.workerOnline ? 'pass' : 'block'} label="Worker" value={d.workerOnline ? 'online' : 'offline'} hint={d.workerOnline ? undefined : 'new claims wait in the queue'} />
          </div>
        </Card>
        <Card title="Training data">
          <p className="sd-fine">
            System 2 is a general-purpose language model. It is not trained on this operator's data. It is handed one claim's evidence at decision
            time and must cite it. What it learns from is the human ruling: that becomes a labeled row for System 1 and for the rule miner.
          </p>
          <div className="sd-tiles">
            <Tile label="Labeled rulings on record" value={count(d.labelCount)} hint={`${count(d.historyLabels)} history · ${count(d.labelCount - d.historyLabels)} live`} />
          </div>
        </Card>
        <Card title={latest ? `Real System 2 proposal: ${latest.c.claimRef}` : 'Real System 2 proposal'} wide>
          {latest ? (
            <>
              <div className="sd-label">
                <Chip tone={tag(latest.s2.verdict) === 'Approve' ? 'pass' : tag(latest.s2.verdict) === 'Deny' ? 'block' : 'warn'}>{tag(latest.s2.verdict)}{tag(latest.s2.verdict) === 'Approve' ? ` ${usd(latest.s2.creditCents)}` : ''}</Chip>
                <span className="ui-muted">{latest.s2.confidencePct.toFixed(0)}% sure · {latest.s2.modelVersion}</span>
                <span className="ui-muted">{latest.c.customer} · {CLAIM_TYPE_LABELS[tag(latest.c.claimType)]}</span>
              </div>
              {latest.s2.rationale && <p className="ui-quote">{latest.s2.rationale}</p>}
              <div className="ui-chips">{latest.s2.citedEvidence.map(e => <Chip key={e} icon={FileText}>{tech ? e : e.split(':')[0].replace(/_/g, ' ')}</Chip>)}</div>
            </>
          ) : <span className="ui-muted">No claim has needed System 2 yet.</span>}
        </Card>
      </div>
    </>
  );
}

function ReverifyDetail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const last = d.live.lastReverify;
  const checks = last ? parseJson<{ label: string; ok: boolean }[]>(last.checksJson) ?? [] : [];
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Runs in': 'the SpacetimeDB module, in the same transaction as the decision',
          'Reducer': <Code>submit_system2</Code>,
          'On any failure': 'the claim goes to a person with the reason',
        }} />
      </Card>
      <Card title="What it checks">
        <Bullets items={[
          'Every evidence ID the LLM cited exists and belongs to this claim.',
          'The credit is no more than the contract entitlement or the amount claimed.',
          'System 1 does not strongly disagree (under 20% approve for an approval, over 80% for a denial).',
          'Telemetry does not show the pass completed.',
          `Confidence is ${AUTO_DECIDE_PCT}% or more.`,
        ]} />
        <p className="sd-fine">In testing, GPT-4.1 once cited the section name "contract" instead of an evidence ID. This check rejected it and sent the claim to a person instead of paying it.</p>
      </Card>
      <Card title="Live">
        <div className="sd-tiles">
          <Tile tone="pass" label="Passed" value={count(d.live.reverifyPassed)} />
          <Tile tone={d.live.reverifyFailed ? 'block' : undefined} label="Failed" value={count(d.live.reverifyFailed)} />
        </div>
        {last ? (
          <>
            <span className="sd-sub">Most recent: {last.verdict}</span>
            <div className="sd-checks">{checks.map(c => <Chip key={c.label} tone={c.ok ? 'pass' : 'block'}>{c.ok ? '✓' : '✗'} {c.label}</Chip>)}</div>
            {tech && last.detail && <p className="ui-quote">{last.detail}</p>}
          </>
        ) : <span className="ui-muted">Nothing re-verified yet.</span>}
      </Card>
    </div>
  );
}

function CedarDetail({ d, tech }: { d: PipelineData; tech: boolean }) {
  const active = d.policy.active;
  const allow = d.authzLog.filter(a => tag(a.decision) === 'Allow').length;
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Engine': <>AWS Cedar, the <Code>cedar-policy</Code> v4 Rust crate</>,
          'Runs in': 'the SpacetimeDB module, compiled to WebAssembly',
          'Why there': 'the permission check commits in the same transaction as the write it guards',
          'Policies': <>versioned in <Code>cedar_policy_store</Code>; every check logged to <Code>authorization_log</Code></>,
          'Active version': active ? <span className="sd-mono sd-amber">{active.version} · {active.description}</span> : '—',
        }} />
      </Card>
      <Card title="The rules that matter">
        <Bullets items={[
          <><b>The AI may decide alone only at {AUTO_DECIDE_PCT}% confidence or more.</b> <span className="ui-muted">(auto-decide-95)</span></>,
          <><b>The AI can never edit policy.</b> A forbid rule overrides every permit.</>,
          'Human approvers can approve, deny and escalate; they cannot edit policy either.',
          <>No one can approve their own authority change or raise their own limit. <span className="ui-muted">(sod-no-own-authority, sod-no-own-request)</span></>,
          'Learned rules are extra Cedar permits on top of this base policy.',
        ]} />
        <p className="sd-fine">There are no dollar caps to game. Confidence and permission are the only gates; anything else goes to a person.</p>
      </Card>
      <Card title="Live checks">
        <div className="sd-tiles">
          <Tile label="Checks logged" value={count(d.authzLog.length)} />
          <Tile tone="pass" label="Allowed" value={count(allow)} />
          <Tile tone={d.authzLog.length - allow ? 'block' : undefined} label="Denied" value={count(d.authzLog.length - allow)} />
        </div>
        <div className="sd-log">
          {d.authzLog.slice(0, 5).map(a => (
            <div key={String(a.id)} className="sd-log-row">
              <Chip tone={tag(a.decision) === 'Allow' ? 'pass' : 'block'}>{tag(a.decision)}</Chip>
              <span className="sd-mono">{a.actorId}</span>
              <span>{a.action.replace(/_/g, ' ')}</span>
              <span className="ui-muted">policy {a.policyVersion}</span>
            </div>
          ))}
          {d.authzLog.length === 0 && <span className="ui-muted">No checks logged yet.</span>}
        </div>
      </Card>
      <Card title="Policy versions" wide>
        <div className="sd-versions">
          {d.policy.versions.map(p => (
            <div key={p.version} className={`sd-version ${p.isActive ? 'on' : ''}`}>
              <span className="sd-mono">{p.version}</span>
              {p.isActive && <Chip tone="pass">Active</Chip>}
              <span className="ui-muted">{p.description}</span>
            </div>
          ))}
        </div>
        {tech && active && <details className="sd-raw"><summary>Cedar source for {active.version}</summary><pre className="dz-cedar">{active.policyText.trim()}</pre></details>}
      </Card>
    </div>
  );
}

function AutoDetail({ d }: { d: PipelineData }) {
  const latest = d.cases.find(c => tag(c.status) === 'AutoDecided') ?? null;
  const s2 = d.live.auto - d.live.fast - d.live.rule;
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Runs in': 'the deciding reducer, as one SpacetimeDB transaction',
          'Writes': <><Code>decision_case</Code> <Code>case_decision</Code> <Code>decision_record</Code> <Code>pipeline_step</Code></>,
          'On record': 'deciding system, model version, policy version, inputs and cited evidence',
          'Once only': 'a claim can be decided once, so nothing is paid twice',
        }} />
      </Card>
      <Card title="Why automate">
        <div className="sd-tiles">
          <Tile tone="pass" label="Automated decision" value={usd(AI_REVIEW_CENTS)} hint="modeled cost" />
          <Tile label="Human review" value={usd(HUMAN_REVIEW_CENTS)} hint="modeled cost" />
        </div>
        <p className="sd-fine">Many single-pass claims are worth less than a human review. Automation pays only the contract entitlement, and only what it can prove.</p>
      </Card>
      <Card title="Live">
        <div className="sd-tiles">
          <Tile tone="pass" label="Auto-decided" value={count(d.live.auto)} hint={usd(d.live.autoCents) + ' credited'} />
          <Tile label="By System 1 alone" value={count(d.live.fast)} hint="fast lane" />
          <Tile label="By a learned rule" value={count(d.live.rule)} />
          <Tile label="By System 2" value={count(Math.max(0, s2))} hint="deep review" />
        </div>
        {latest && (
          <button className="dz-btn dz-replay" onClick={() => openReplay(`case:${latest.claimRef}`)}>
            <Play size={12} /> Replay {latest.claimRef} step by step
          </button>
        )}
      </Card>
    </div>
  );
}

function HumanDetail({ d }: { d: PipelineData }) {
  const lastLive = d.models.find(m => m.triggeredByLabel !== undefined) ?? null;
  return (
    <div className="sd-grid">
      <Card title="Technology">
        <Tech items={{
          'Where': 'the Claims page review queue',
          'Reducer': <Code>human_decide_case</Code>,
          'Permission': <>Cedar checks the <Code>human_approver</Code> role</>,
          'Writes': <>a <Code>labeled_decision</Code> row with the full evidence package the reviewer saw</>,
        }} />
      </Card>
      <Card title="What the reviewer gets">
        <Bullets items={[
          'Telemetry, the space-weather curve against the contract exclusion, the contract clause and formula credit.',
          "The customer's history, every Cedar rule that matched or didn't, and similar past rulings.",
          'Why the claim is here: which stage was unsure or which check failed.',
        ]} />
      </Card>
      <Card title="It closes the loop">
        <div className="sd-tiles">
          <Tile tone="warn" label="Waiting for a person" value={count(d.live.waiting)} />
          <Tile label="Decided by a person" value={count(d.live.humanDecided)} />
          <Tile label="Ruling to new model" value={lastLive ? `${lastLive.latencyMs.toFixed(0)} ms` : '—'} hint={lastLive ? `s1-v${lastLive.version}` : 'measured on the next live ruling'} />
        </div>
        <p className="sd-fine"><RefreshCw size={11} aria-hidden /> Each ruling retrains System 1 and is mined for new rules, so the next similar claim can take the fast lane.</p>
        <a className="dz-btn dz-replay" href="#/claims"><Database size={12} /> Open the review queue</a>
      </Card>
    </div>
  );
}

const LEDE: Record<StageId, string> = {
  claims: "Takes a customer's credit claim and pulls the evidence from the operator's own records: the pass, its downlink telemetry, space weather at the time, the station's recent history and the contract.",
  s1: `Scores every claim from numbers alone and decides on its own when it is at least ${AUTO_DECIDE_PCT}% sure. It is the first thing every claim meets.`,
  rules: 'When reviewers keep ruling the same kind of claim the same way, the system writes that pattern down as a Cedar rule, so the next one is decided without the LLM.',
  screen: "Before any AI reads the customer's message, it is checked for hidden instructions. A flagged message goes to a person, and the LLM never sees it.",
  s2: "Reads every source, including the customer's message, and proposes a decision with the evidence it relied on. It cannot decide anything on its own.",
  reverify: "The database double-checks the AI's work before anything is paid.",
  cedar: 'The final say. A written policy decides whether the AI is allowed to act at all, however confident it is.',
  auto: 'The claim is closed: credited up to what the contract allows, or denied, with the deciding system and every version on record.',
  human: "Anything the system can't prove goes to a person with the full evidence. Their ruling is the label the system learns from.",
};

interface StageDetailProps {
  d: PipelineData;
  stage: StageCard;
  tech: boolean;
  onSelect: (id: StageId) => void;
}

/** Everything about one pipeline stage: plain-English job first, then technology, thresholds and real data. */
export function StageDetail({ d, stage, tech, onSelect }: StageDetailProps) {
  const i = STAGE_ORDER.indexOf(stage.id);
  const prev = STAGE_ORDER[(i + STAGE_ORDER.length - 1) % STAGE_ORDER.length];
  const next = STAGE_ORDER[(i + 1) % STAGE_ORDER.length];
  const Icon = stage.icon;
  return (
    <section className={`sd lane-${stage.lane}`} aria-live="polite">
      <header className="sd-head">
        <div className="sd-head-text">
          <span className="sd-kicker"><Icon size={12} aria-hidden /> {stage.kicker} · {LANE_LABEL[stage.lane]}</span>
          <h2 className="sd-title">{stage.name}</h2>
          <p className="sd-lede">{LEDE[stage.id]}</p>
        </div>
        <div className="sd-nav">
          <button className="ui-icon-btn" onClick={() => onSelect(prev)} aria-label="Previous stage" title="Previous stage"><ArrowLeft size={14} /></button>
          <span className="ui-muted">{i + 1} / {STAGE_ORDER.length}</span>
          <button className="ui-icon-btn" onClick={() => onSelect(next)} aria-label="Next stage" title="Next stage"><ArrowRight size={14} /></button>
        </div>
      </header>
      {stage.id === 's1' && <System1Detail d={d} tech={tech} />}
      {stage.id === 'claims' && <ClaimsDetail d={d} tech={tech} />}
      {stage.id === 'rules' && <RulesDetail d={d} tech={tech} />}
      {stage.id === 'screen' && <ScreenDetail d={d} tech={tech} />}
      {stage.id === 's2' && <System2Detail d={d} tech={tech} />}
      {stage.id === 'reverify' && <ReverifyDetail d={d} tech={tech} />}
      {stage.id === 'cedar' && <CedarDetail d={d} tech={tech} />}
      {stage.id === 'auto' && <AutoDetail d={d} />}
      {stage.id === 'human' && <HumanDetail d={d} />}
    </section>
  );
}
