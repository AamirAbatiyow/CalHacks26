import { useState, type ReactNode } from 'react';
import { ShieldCheck, ShieldAlert, UserCheck } from 'lucide-react';
import { Chip } from '../../ui/Chip';
import { tag, useTable } from '../../hooks/useTable';
import { ATTACK_TYPE_LABELS } from './types';
import type { AttackRun } from './types';
import { outcomeTone, parseJson, usd, type AttackEvalRow } from './useAttackEvals';

const OUTCOME_LABEL: Record<string, string> = { caught: 'Caught', escalated: 'Held for review', missed: 'Missed' };
const DECIDED_BY: Record<string, string> = {
  screen: 'Fraud screen',
  role_check: 'Role check',
  policy: 'System 1 and Cedar policy',
  human: 'Human approver',
};

interface Flag { check: string; detail: string; on_target: boolean }
interface Fired { policy: string; action: string; outcome: string }
interface Rules { policy_version?: string; fired?: Fired[]; precedent?: string | null; auto?: boolean; confidence?: number; note?: string }
interface Term { feature: string; x: number | string; contribution: number }
interface S1 { model_version?: string; p_approve?: number; proxy?: boolean; terms?: Term[] }
interface Evidence {
  pass?: { id: number; station_id: string; status: string; max_elevation_deg: number; revenue_cents: number };
  telemetry?: { loss_pct: number; received_mb: number; expected_mb: number; source: string };
  weather?: { kp: number; flare?: string | null };
  maintenance?: { state: string; notice_hours: number; log?: string | null };
  contract?: { name: string; tier: string; kp_exclusion: number; full_credit_lost_pct: number; min_elevation_deg: number; credit_cents: number };
  features?: { key: string; value: string }[];
  not_owed?: string[];
}

export function PolicyLink({ version }: { version: string }) {
  return /^v\d+$/.test(version) ? <a className="breakit-link" href={`#/policies/${encodeURIComponent(version)}`}>{version}</a> : <>{version}</>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="breakit-detail-section">
      <div className="ui-section-title">{title}</div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="breakit-facts">
      {rows.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

function Expander({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="breakit-expander">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/** Customer text as data: control and invisible characters are shown escaped, never rendered. */
function visible(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function Reason({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const shown = visible(text);
  if (shown.length <= 90) return <code className="breakit-reason">{shown || '(empty)'}</code>;
  return (
    <code className="breakit-reason">
      {open ? shown : `${shown.slice(0, 90)}…`}{' '}
      <button className="breakit-more" onClick={() => setOpen(!open)}>{open ? 'less' : 'more'}</button>
    </code>
  );
}

function Decision({ row }: { row: AttackEvalRow }) {
  const icon = row.outcome === 'caught' ? ShieldCheck : row.outcome === 'escalated' ? UserCheck : ShieldAlert;
  return (
    <div className="ui-chips">
      <Chip tone={outcomeTone(row.outcome)} icon={icon}>{OUTCOME_LABEL[row.outcome] ?? row.outcome}</Chip>
      <Chip>{DECIDED_BY[row.decidedBy] ?? row.decidedBy}</Chip>
      {row.review === 'cleared' && <Chip tone="accent">Cleared by {row.reviewRef}</Chip>}
      {row.review === 'human' && <Chip tone="accent">Labeled as {row.reviewRef}</Chip>}
    </div>
  );
}

function Money({ row }: { row: AttackEvalRow }) {
  return (
    <Facts rows={[
      ['Decision', row.decision === 'held' ? 'held, nothing paid' : row.decision],
      ['Claimed', usd(row.claimedCents)],
      ['Paid', usd(row.paidCents)],
      ['Evidence supports', usd(row.supportedCents)],
      row.badCents > 0n ? ['Bad payout', <span key="bad" className="tone-bad">{usd(row.badCents)}</span>] : ['Protected', usd(row.protectedCents)],
      ...(row.decidedBy === 'policy' || row.decidedBy === 'human' ? [['Confidence', `${row.confidence}%`] as [string, ReactNode]] : []),
    ]} />
  );
}

export function AttackDetail({ row, before, review }: { row: AttackEvalRow; before?: AttackEvalRow; review?: ReactNode }) {
  const flags = parseJson<Flag[]>(row.screenJson, []);
  const rules = parseJson<Rules>(row.rulesJson, {});
  const s1 = parseJson<S1>(row.s1Json, {});
  const ev = parseJson<Evidence>(row.evidenceJson, {});
  const policyRan = row.decidedBy === 'policy' || row.decidedBy === 'human';

  return (
    <div className="breakit-detail">
      <Decision row={row} />
      <p>{row.why}</p>
      {review}

      <Section title="What it tried">
        <p>{row.tried}. {row.description}.</p>
      </Section>

      <Section title="Claim">
        <Facts rows={[
          ...(row.passId > 0n ? [['Pass', `#${row.passId}${ev.pass ? ` · ${ev.pass.status} · ${ev.pass.max_elevation_deg.toFixed(1)}° max` : ''}`] as [string, ReactNode]] : []),
          ...(row.stationId ? [['Station claimed', row.stationId] as [string, ReactNode]] : []),
          [row.decidedBy === 'role_check' ? 'Role' : 'Customer', row.customer || '—'],
          ['Amount', usd(row.claimedCents)],
          ...(row.decidedBy !== 'role_check' ? [['Reason', <Reason key="reason" text={row.reason} />] as [string, ReactNode]] : []),
        ]} />
      </Section>

      <Section title="Decision">
        <Money row={row} />
      </Section>

      <Section title="Screen checks">
        {flags.length === 0 ? <p>No check flagged it.</p> : (
          <ul className="breakit-list">
            {flags.map((f, i) => (
              <li key={i} className={f.on_target ? 'hit' : ''}><b>{f.check}</b> {f.detail}{!f.on_target && <span className="breakit-muted"> (not this attack's target)</span>}</li>
            ))}
          </ul>
        )}
      </Section>

      {policyRan && (
        <Section title="Rules and policies">
          <Facts rows={[
            ['Policy', <PolicyLink key="policy" version={row.policyVersion} />],
            ['Precedent applied', rules.precedent ? <code key="precedent">{rules.precedent}</code> : 'none'],
            ['Auto-decided', rules.auto ? `yes, at ${rules.confidence}%` : `no, ${rules.confidence ?? row.confidence}% is below 95%`],
          ]} />
          {(rules.fired ?? []).length > 0 ? (
            <ul className="breakit-list">
              {rules.fired!.map((r, i) => (
                <li key={i}><code>{r.policy}</code> {r.action.replace('_', ' ')} → {r.outcome} <span className="breakit-muted">in <PolicyLink version={rules.policy_version ?? row.policyVersion} /></span></li>
              ))}
            </ul>
          ) : <p>No rule permitted an automatic decision.</p>}
          {rules.note && <p className="breakit-muted">{rules.note}</p>}
        </Section>
      )}

      {policyRan && s1.p_approve !== undefined && (
        <Section title="System 1">
          <Facts rows={[
            ['Model', s1.proxy ? `${row.modelVersion} (fixed stand-in, no trained model yet)` : row.modelVersion],
            ['P(human credits it)', `${(s1.p_approve * 100).toFixed(1)}%`],
          ]} />
          {(s1.terms ?? []).length > 0 && (
            <Expander summary={`${s1.terms!.length} largest terms`}>
              <table className="breakit-table">
                <tbody>
                  {s1.terms!.map(t => (
                    <tr key={t.feature}><td>{t.feature}</td><td className="num">{typeof t.x === 'number' ? t.x.toFixed(2) : t.x}</td><td className={`num ${t.contribution >= 0 ? '' : 'neg'}`}>{t.contribution >= 0 ? '+' : '−'}{Math.abs(t.contribution).toFixed(2)}</td></tr>
                  ))}
                </tbody>
              </table>
            </Expander>
          )}
        </Section>
      )}

      {policyRan && (
        <Section title="System 2">
          <p>Not invoked. Claims without customer free text are decided by System 1 and the Cedar policy; only prompt-injection attacks reach System 2.</p>
        </Section>
      )}

      {ev.features && (
        <Section title="Evidence used">
          <Facts rows={[
            ...(ev.telemetry ? [['Telemetry', `${ev.telemetry.loss_pct}% lost (${ev.telemetry.received_mb} of ${ev.telemetry.expected_mb} MB)`] as [string, ReactNode]] : []),
            ...(ev.weather ? [['Space weather', `Kp ${ev.weather.kp.toFixed(1)}${ev.contract ? ` vs exclusion ${ev.contract.kp_exclusion.toFixed(1)}` : ''}`] as [string, ReactNode]] : []),
            ...(ev.maintenance ? [['Maintenance', ev.maintenance.state === 'none' ? 'none logged' : `${ev.maintenance.state}${ev.maintenance.log ? ` · ${ev.maintenance.log}` : ''}`] as [string, ReactNode]] : []),
            ...(ev.contract ? [['Contract', `${ev.contract.name} (${ev.contract.tier}) · formula credit ${usd(ev.contract.credit_cents)}`] as [string, ReactNode]] : []),
            ...((ev.not_owed ?? []).length > 0 ? [['Not owed because', ev.not_owed!.join('; ')] as [string, ReactNode]] : []),
          ]} />
          <Expander summary="Deciding features">
            <table className="breakit-table">
              <tbody>
                {ev.features.map(f => <tr key={f.key}><td>{f.key.replace(/_/g, ' ')}</td><td>{f.value.replace(/_/g, ' ')}</td></tr>)}
              </tbody>
            </table>
          </Expander>
        </Section>
      )}

      {before && (
        <Section title="Earlier policy and model">
          <div className="ui-chips">
            <Chip tone={outcomeTone(before.outcome)}>{OUTCOME_LABEL[before.outcome]}</Chip>
            <Chip><PolicyLink version={before.policyVersion} /> · {before.modelVersion}</Chip>
          </div>
          <p>{before.why}</p>
        </Section>
      )}
    </div>
  );
}

/** Prompt-injection attacks are filed as real claims and decided by the worker, so their detail is the case record. */
export function InjectionDetail({ run }: { run: AttackRun }) {
  const cases = useTable('decisionCase');
  const decisions = useTable('caseDecision');
  const messages = useTable('disputeMessage');
  const c = cases.find(k => k.attackSessionId === run.runId && k.attackName && run.logMessage.includes(k.attackName));
  if (!c) return <p>{run.logMessage}</p>;
  const steps = decisions.filter(d => d.caseId === c.id).sort((a, b) => Number(a.id - b.id));
  const message = messages.find(m => m.id === c.messageId);
  const screen = parseJson<{ flagged?: boolean; reasons?: string[] }>(c.screenJson, {});
  return (
    <div className="breakit-detail">
      <div className="ui-chips">
        <Chip tone={run.result === 'Caught' ? 'pass' : run.result === 'Missed' ? 'block' : 'warn'}>{run.result === 'Pending' ? 'Undecided' : run.result}</Chip>
        <Chip>{c.decidedBy ? tag(c.decidedBy) : 'not decided'}</Chip>
      </div>
      <p>{run.logMessage.replace(/^Prompt injection: /, '')}</p>
      <Section title="What it tried">
        <p>{ATTACK_TYPE_LABELS.PromptInjection}: {c.attackName}.</p>
        {message && <Reason text={message.body} />}
      </Section>
      <Section title="Decision">
        <Facts rows={[
          ['Claim', `${c.claimRef} · pass #${c.passId} · ${c.stationId}`],
          ['Claimed', usd(c.amountClaimedCents)],
          ['Entitled', usd(c.entitledCreditCents)],
          ['Final', c.finalVerdict ? `${tag(c.finalVerdict)} · ${usd(c.finalCreditCents)}` : 'pending'],
          ['Policy', <PolicyLink key="policy" version={c.policyVersion} />],
          ['Model', c.modelVersion],
        ]} />
      </Section>
      <Section title="Injection screen">
        <p>{screen.flagged ? `Flagged: ${(screen.reasons ?? []).join('; ')}` : 'Passed'}</p>
      </Section>
      {steps.map(s => (
        <Section key={String(s.id)} title={tag(s.system)}>
          <Facts rows={[
            ['Verdict', `${tag(s.verdict)} at ${s.confidencePct.toFixed(0)}%`],
            ['Credit', usd(s.creditCents)],
            ...(s.citedEvidence.length > 0 ? [['Cited', s.citedEvidence.join(', ')] as [string, ReactNode]] : []),
          ]} />
          {s.rationale && (s.rationale.length > 160
            ? <Expander summary={`${s.rationale.slice(0, 120)}…`}><p>{s.rationale}</p></Expander>
            : <p>{s.rationale}</p>)}
        </Section>
      ))}
    </div>
  );
}
