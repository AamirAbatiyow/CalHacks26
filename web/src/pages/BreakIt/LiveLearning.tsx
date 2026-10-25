import { useState } from 'react';
import { GraduationCap, Sparkles } from 'lucide-react';
import { reducers } from '../../hooks/useTable';
import { KEY_LABELS, promoteVersion, useMiningResults, useProposals } from '../../hooks/useCases';
import { Chip } from '../../ui/Chip';
import { compactUsd } from '../../ui/CountUp';
import { PolicyLink } from './AttackDetail';
import { parseJson, usd, type AttackClearance, type AttackEvalRow } from './useAttackEvals';

const DECISIVE_KEYS = ['weather_band', 'lost_band', 'claim_vs_contract', 'msg_cites_weather', 'maintenance', 'elevation_band', 'integrity'];
const DEFAULT_DECISIVE = ['weather_band', 'lost_band'];

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** A reviewer's decision on one held attack; it becomes a labeled decision the miner reads. */
export function ReviewForm({ row }: { row: AttackEvalRow }) {
  const [outcome, setOutcome] = useState<'partial' | 'approve' | 'deny'>('partial');
  const [decisive, setDecisive] = useState<string[]>(DEFAULT_DECISIVE);
  const [reviewer, setReviewer] = useState('S. Chen');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const features = parseJson<{ features?: { key: string; value: string }[] }>(row.evidenceJson, {}).features ?? [];
  const value = (k: string) => features.find(f => f.key === k)?.value.replace(/_/g, ' ') ?? '';
  const credit = outcome === 'deny' ? 0n : outcome === 'approve' ? row.claimedCents : row.supportedCents;

  const submit = async () => {
    const r = reducers();
    if (!r) return setError('Not connected');
    setBusy(true);
    setError(null);
    try {
      await r.decideAttack({
        evalId: row.id,
        outcome,
        creditCents: credit,
        reasonText: outcome === 'partial' ? 'Storm under the exclusion; paid the measured loss only.' : '',
        decisive,
        reviewer,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ll-form">
      <div className="ui-section-title">Your decision</div>
      <div className="ll-options">
        {([
          ['partial', `Pay the measured loss (${usd(row.supportedCents)})`],
          ['approve', `Pay the full claim (${usd(row.claimedCents)})`],
          ['deny', 'Deny'],
        ] as const).map(([k, label]) => (
          <label key={k} className={outcome === k ? 'on' : ''}>
            <input type="radio" name="ll-outcome" checked={outcome === k} onChange={() => setOutcome(k)} /> {label}
          </label>
        ))}
      </div>
      <div className="ll-decisive">
        <span className="breakit-muted">Evidence that decided it</span>
        {DECISIVE_KEYS.map(k => (
          <label key={k}>
            <input type="checkbox" checked={decisive.includes(k)} onChange={e => setDecisive(e.target.checked ? [...decisive, k] : decisive.filter(d => d !== k))} />
            {KEY_LABELS[k] ?? k}{value(k) && <span className="breakit-muted"> · {value(k)}</span>}
          </label>
        ))}
      </div>
      <div className="ll-actions">
        <input className="ll-reviewer" value={reviewer} onChange={e => setReviewer(e.target.value)} aria-label="Reviewer" />
        <button className="breakit-run-all-btn" disabled={busy || !reviewer} onClick={submit}>Decide as human approver</button>
      </div>
      {error && <div className="ll-error">{error}</div>}
    </div>
  );
}

interface Props {
  after: AttackEvalRow[];
  clusterIds: Set<bigint>;
  clearances: AttackClearance[];
  onOpen: (row: AttackEvalRow) => void;
}

/** One human decision on a held attack, the rule it proposes, and how many held attacks the promotion clears. */
export function LiveLearning({ after, clusterIds, clearances, onOpen }: Props) {
  const mining = useMiningResults();
  const proposals = useProposals();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const held = after.filter(r => r.outcome === 'escalated' && !r.review);
  const heldCluster = held.filter(r => clusterIds.has(r.fixtureId));
  const decided = after.filter(r => r.review === 'human').sort((a, b) => Number(b.id - a.id));
  const latest = decided[0];
  const result = latest ? mining.find(m => m.caseId === latest.reviewRef) : undefined;
  const proposal = result?.proposalVersion ? proposals.find(p => p.versionId === result.proposalVersion) : undefined;
  const clearance = clearances[clearances.length - 1];
  const clusterTotal = after.filter(r => clusterIds.has(r.fixtureId)).length;
  if (held.length === 0 && !latest && !clearance) return null;

  const promote = async (versionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await promoteVersion(versionId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const next = heldCluster[0] ?? held[0];

  return (
    <section className="ll">
      <div className="ll-head">
        <GraduationCap size={14} aria-hidden />
        <span className="ui-section-title">Learn from one decision</span>
      </div>

      {clearance ? (
        <div className="ll-cleared">
          <b className="ll-big">{clearance.cleared}</b>
          <div>
            <div className="ll-cleared-title">
              held attack{clearance.cleared === 1 ? '' : 's'} cleared by {proposals.find(p => p.versionId === clearance.versionId)?.origin === 'history_mining' ? `promoting ${clearance.versionId}` : 'one human decision'}
            </div>
            <div className="breakit-muted">
              Promoting <PolicyLink version={clearance.versionId} /> (learned from {clearance.triggerCaseId || 'a human decision'}) re-decided the {clearance.heldBefore} attacks waiting for a human:
              {' '}{clearance.cleared} now decide automatically, paying {usd(clearance.paidCents)} instead of the claims and protecting {compactUsd(Number(clearance.protectedCents))}
              {clearance.badCents > 0n && <>; {usd(clearance.badCents)} went to duplicates the rule cannot see</>}. {clearance.stillHeld} still need{clearance.stillHeld === 1 ? 's' : ''} a human.
            </div>
          </div>
        </div>
      ) : proposal ? (
        <div className="ll-step">
          <Chip tone={proposal.status === 'blocked' ? 'block' : 'accent'} icon={Sparkles}>{proposal.versionId} {proposal.status}</Chip>
          <p>
            {result?.detail}. Replayed over {proposal.replayCases.toLocaleString()} labeled decisions: escalations {proposal.escalationsBefore.toLocaleString()} → {proposal.escalationsAfter.toLocaleString()},
            precision {proposal.precisionBefore.toFixed(2)}% → {proposal.precisionAfter.toFixed(2)}%, {proposal.regressions} regressions.
            {proposal.blockReason && <> Blocked: {proposal.blockReason}.</>}
          </p>
          {proposal.status === 'proposed' && (
            <button className="breakit-run-all-btn" disabled={busy} onClick={() => promote(proposal.versionId)}>
              Promote {proposal.versionId} and re-decide the {held.length} held attacks
            </button>
          )}
          <a className="breakit-link" href={`#/policies/${proposal.versionId}`}>Review {proposal.versionId} on Policies</a>
        </div>
      ) : latest && result ? (
        <div className="ll-step">
          <Chip>No rule proposed</Chip>
          <p>{latest.reviewRef}: {result.detail}. Decide another held attack with the same evidence, or mark different decisive evidence.</p>
        </div>
      ) : (
        <div className="ll-step">
          <p>
            <b>{held.length}</b> attacks are waiting for a human{heldCluster.length > 0 && <>, {heldCluster.length} of them from one storm-overclaim pattern ({clusterTotal} claims: full fee claimed, a storm just under the contract's exclusion, 10–24% of the contact lost)</>}.
            Nothing has been paid on them. Decide one: the decision is stored as a labeled audit decision, and if at least three decisions agree and none contradict, the miner proposes a Cedar rule.
          </p>
          {next && <button className="breakit-run-all-btn" onClick={() => onOpen(next)}>Review {next.description.split(',')[0].replace('Full fee claimed for a', 'the')}</button>}
        </div>
      )}
      {error && <div className="ll-error">{error}</div>}
    </section>
  );
}
