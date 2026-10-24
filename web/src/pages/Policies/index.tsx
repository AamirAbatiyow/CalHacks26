import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  Ban, CheckCircle2, CircleDot, FilePlus2, GitBranch, History, Pause, Play, ScrollText, SkipBack, SkipForward, Sparkles, Users,
} from 'lucide-react';
import { usePoliciesDB } from '../../hooks/usePoliciesDB';
import { useHashParam } from '../../hooks/useHashPage';
import { useTable, tag } from '../../hooks/useTable';
import { parseJson, type LearnedRuleRow } from '../../hooks/useDecisions';
import { PolicyStatus, ReplayStatus } from '../../types';
import type { PolicyVersion, CedarRule, PolicyReplay } from '../../types';
import { FlowGraph, type GraphEdge, type GraphNode } from '../../ui/FlowGraph';
import { Drawer, Fact } from '../../ui/Drawer';
import { Chip } from '../../ui/Chip';
import { Meter } from '../../ui/charts';
import { CountUp, compactUsd } from '../../ui/CountUp';
import { EmptyState } from '../../ui/EmptyState';
import { DataTable, type Column } from '../../ui/DataTable';
import { useTechMode } from '../../hooks/useTechMode';
import { SkeletonGraph, SkeletonRows } from '../../ui/Skeleton';
import { useLabeledDecisions, useProposals } from '../../hooks/useCases';
import { HistoryView, ProposalPanel } from './Learning';
import './Policies.css';

const HISTORY = 'history';

function formatDate(micros: bigint): string {
  const date = new Date(Number(micros) / 1000);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function claimTypeLabel(raw: string): string {
  const s = raw.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Condition { feature: string; op: string; value: unknown }
const OPS: Record<string, string> = { eq: '=', gte: '≥', gt: '>', lt: '<', lte: '≤', ne: '≠' };

function conditionText(c: Condition): string {
  return `${c.feature.replace(/_/g, ' ')} ${OPS[c.op] ?? c.op} ${String(c.value).replace(/_/g, ' ')}`;
}

function pts(before: number, after: number): string {
  const d = after - before;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} pts`;
}

const STATUS_ICON = { [PolicyStatus.Proposed]: Sparkles, [PolicyStatus.Current]: CheckCircle2, [PolicyStatus.Retired]: CircleDot };

function VersionItem({ version, isSelected, onClick }: { version: PolicyVersion; isSelected: boolean; onClick: () => void }) {
  const Icon = STATUS_ICON[version.status];
  return (
    <button className={`version-item ${isSelected ? 'selected' : ''} ${version.status.toLowerCase()}`} onClick={onClick}>
      {isSelected && <motion.span layoutId="policy-version-active" className="version-active-bg" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
      <span className="version-number">v{version.version}</span>
      <span className="version-meta">
        <Icon size={11} aria-hidden />
        <span className="version-status">
          {version.status === PolicyStatus.Proposed ? version.author
            : version.status === PolicyStatus.Current ? `${version.status} · ${version.author}` : version.status}
        </span>
        {version.status !== PolicyStatus.Proposed && <span className="version-date">{formatDate(version.createdAt)}</span>}
      </span>
    </button>
  );
}

interface ReplayBarProps {
  replay: PolicyReplay;
  onPlayPause: () => void;
  onSpeedChange: (speed: number) => void;
  onSeek: (claim: number) => void;
}

function ReplayBar({ replay, onPlayPause, onSpeedChange, onSeek }: ReplayBarProps) {
  const progress = replay.totalClaims > 0 ? (replay.currentClaim / replay.totalClaims) * 100 : 0;
  const speeds = [1, 4, 16];
  const playing = replay.isPlaying && replay.status === ReplayStatus.Running;

  return (
    <div className="replay-bar">
      <div className="replay-controls">
        <button className="control-btn" onClick={() => onSeek(0)} title="Skip to start" aria-label="Skip to start">
          <SkipBack size={13} />
        </button>
        <button className="control-btn play-btn" onClick={onPlayPause} title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className="control-btn" onClick={() => onSeek(replay.totalClaims)} title="Skip to end" aria-label="Skip to end">
          <SkipForward size={13} />
        </button>
        <div className="speed-controls">
          {speeds.map(s => (
            <button
              key={s}
              className={`speed-btn ${Math.round(replay.speedMultiplier) === s ? 'active' : ''}`}
              onClick={() => onSpeedChange(s)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="scrubber-container">
        <div className="scrubber">
          <div className="scrubber-track">
            <div className="scrubber-progress" style={{ width: `${progress}%` }} />
            <div className="scrubber-handle" style={{ left: `${progress}%` }} />
          </div>
        </div>
        <span className="scrubber-label">Replaying {replay.totalClaims.toLocaleString()} past claims</span>
      </div>

      <div className="replay-timestamp">
        <span className="timestamp-value">Claim {replay.currentClaim.toLocaleString()} of {replay.totalClaims.toLocaleString()}</span>
        <button className="live-btn">Live</button>
      </div>
    </div>
  );
}

function ReplayTiles({ replay, onPromote, tech }: { replay: PolicyReplay; onPromote: () => void; tech: boolean }) {
  const regressed = replay.precisionAfter < replay.precisionBefore;
  const impact = Number(replay.dollarImpactCents);
  const blocked = replay.status === ReplayStatus.Blocked;
  return (
    <motion.div className="ui-tiles" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
      {tech && (
        <div className="ui-tile">
          <span className="ui-stat-label">Precision</span>
          <span className={`ui-stat-value ${regressed ? 'tone-warn' : ''}`}>
            {replay.precisionBefore.toFixed(1)}% <span className="policy-arrow">→</span> {replay.precisionAfter.toFixed(1)}%
          </span>
          <span className="ui-stat-sub">{pts(replay.precisionBefore, replay.precisionAfter)}</span>
        </div>
      )}
      <div className="ui-tile">
        <span className="ui-stat-label">Decisions changed</span>
        <span className="ui-stat-value"><CountUp value={replay.decisionsChanged} format={n => Math.round(n).toLocaleString()} /></span>
        <span className="ui-stat-sub">of {replay.totalClaims.toLocaleString()} claims</span>
      </div>
      <div className="ui-tile">
        <span className="ui-stat-label">Dollar impact</span>
        <span className={`ui-stat-value ${impact > 0 ? 'tone-warn' : ''}`}>
          <CountUp value={Math.abs(impact)} format={compactUsd} />
        </span>
        <span className="ui-stat-sub">{impact > 0 ? 'overpaid' : 'saved'}</span>
      </div>
      <div className="ui-tile policy-tile-action">
        {blocked ? (
          <Chip tone="block" icon={Ban} title={tech ? replay.blockReason : undefined}>{tech ? `Blocked: ${replay.blockReason}` : 'Blocked by replay'}</Chip>
        ) : replay.status === ReplayStatus.Completed ? (
          <button className="promote-btn" onClick={onPromote}><CheckCircle2 size={13} /> Promote to current</button>
        ) : (
          <Chip tone="accent" icon={History}>Replaying</Chip>
        )}
      </div>
    </motion.div>
  );
}

interface RuleListProps {
  rules: CedarRule[];
  changed: Set<string>;
  onToggleRule: (ruleId: string) => void;
  onOpen: (ruleId: string) => void;
  onCreateVersion: () => void;
  canEdit: boolean;
}

function RuleList({ rules, changed, onToggleRule, onOpen, onCreateVersion, canEdit }: RuleListProps) {
  const columns = useMemo<Column<CedarRule>[]>(() => [
    {
      key: 'name', label: 'Rule', width: 'minmax(0, 1fr)', sort: r => r.name,
      render: r => (
        <span className={`rule-cell ${r.enabled ? '' : 'disabled'}`}>
          <ScrollText size={13} className="rule-icon" aria-hidden />
          <span className="rule-name">{r.name}</span>
          {changed.has(r.id) && <Chip tone="warn" icon={GitBranch}>Changed</Chip>}
        </span>
      ),
    },
    { key: 'description', label: 'What it does', width: 'minmax(0, 1.4fr)', sort: r => r.description, render: r => <span className="ui-table-muted">{r.description}</span> },
    {
      key: 'enabled', label: 'Status', width: '70px', align: 'right', sort: r => (r.enabled ? 1 : 0),
      render: r => canEdit ? (
        <button
          className={`toggle-btn ${r.enabled ? 'enabled' : ''}`}
          role="switch"
          aria-checked={r.enabled}
          aria-label={`${r.name} ${r.enabled ? 'on' : 'off'}`}
          onClick={(e) => { e.stopPropagation(); onToggleRule(r.id); }}
        >
          <motion.span className="toggle-knob" layout transition={{ type: 'spring', stiffness: 600, damping: 35 }} />
        </button>
      ) : <Chip>{r.enabled ? 'On' : 'Off'}</Chip>,
    },
  ], [changed, canEdit, onToggleRule]);

  return (
    <section className="policy-section">
      <div className="policy-section-head">
        <span className="ui-section-title">Rules</span>
        {canEdit && (
          <button className="create-version-btn" onClick={onCreateVersion}><FilePlus2 size={13} /> New version</button>
        )}
      </div>
      <DataTable
        rows={rules}
        columns={columns}
        rowKey={r => r.id}
        onRowClick={r => onOpen(r.id)}
        label="Policy rules"
        className="rules-table"
      />
    </section>
  );
}

type Open = { kind: 'labels' } | { kind: 'pattern' | 'rule' | 'replay'; rule: LearnedRuleRow } | { kind: 'decisions' | 'proposal' | 'prule' | 'preplay' } | { kind: 'cedar'; id: string };

export default function Policies() {
  const {
    connected,
    policyVersions,
    cedarRules,
    replays,
    advanceReplay,
    seekReplay,
    setReplayPlaying,
    setReplaySpeed,
    toggleRule,
    createPolicyVersion,
    promotePolicyVersion,
  } = usePoliciesDB();
  const learnedRows = useTable('learnedRule');
  const labelRows = useTable('labeledDecision');
  const decisions = useLabeledDecisions();
  const proposals = useProposals();

  const linkedVersionId = useHashParam();
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [appliedLinkId, setAppliedLinkId] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const tech = useTechMode();

  useEffect(() => {
    if (policyVersions.length === 0) return;
    if (linkedVersionId && linkedVersionId !== appliedLinkId && (linkedVersionId === HISTORY || policyVersions.some(v => v.id === linkedVersionId))) {
      setSelectedVersionId(linkedVersionId);
      setAppliedLinkId(linkedVersionId);
    } else if (!selectedVersionId) {
      const proposed = policyVersions.find(v => v.status === PolicyStatus.Proposed);
      setSelectedVersionId(proposed?.id ?? policyVersions[0].id);
    }
  }, [policyVersions, selectedVersionId, linkedVersionId, appliedLinkId]);

  const selectedVersion = policyVersions.find(v => v.id === selectedVersionId);
  const selectedProposal = proposals.find(p => p.versionId === selectedVersionId);
  const currentVersion = policyVersions.find(v => v.status === PolicyStatus.Current);
  const selectedRules = cedarRules.filter(r => r.policyVersionId === selectedVersionId);

  const activeReplay = replays.find(
    r => r.proposedVersionId === selectedVersionId &&
      (r.status === ReplayStatus.Running || r.status === ReplayStatus.Blocked || r.status === ReplayStatus.Completed)
  );

  const showReplay = selectedVersion?.status === PolicyStatus.Proposed && currentVersion && activeReplay && !selectedProposal;

  const changedRules = useMemo(() => {
    if (!currentVersion || selectedVersionId === currentVersion.id) return [];
    const base = new Set(cedarRules.filter(r => r.policyVersionId === currentVersion.id).map(r => `${r.name}\n${r.cedarCode}`));
    return cedarRules.filter(r => r.policyVersionId === selectedVersionId && !base.has(`${r.name}\n${r.cedarCode}`));
  }, [cedarRules, currentVersion, selectedVersionId]);
  const changedIds = useMemo(() => new Set(changedRules.map(r => r.id)), [changedRules]);

  const learned = useMemo(() => [...learnedRows].sort((a, b) => Number(a.id - b.id)), [learnedRows]);
  const labelStats = useMemo(() => ({
    total: labelRows.length,
    history: labelRows.filter(l => l.source === 'history').length,
    reviewers: new Set(labelRows.map(l => l.reviewer)).size,
  }), [labelRows]);

  const { nodes, edges } = useMemo(() => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    if (learned.length > 0) {
      nodes.push({ id: 'labels', title: 'Labels', icon: Users, value: labelStats.total.toLocaleString(), sub: 'human decisions' });
    }
    for (const r of learned) {
      const promoted = tag(r.status) === 'Promoted';
      const approve = tag(r.verdict) === 'Approve';
      nodes.push({
        id: `p${r.id}`, title: 'Pattern', icon: Sparkles, value: `${r.support} agree`,
        sub: `${r.distinctReviewers} reviewers`, tone: r.contradictions > 0 ? 'warn' : 'neutral', hint: r.description,
      });
      nodes.push({
        id: `r${r.id}`, title: `Rule L${r.id}`, icon: ScrollText, value: approve ? 'Approve' : 'Deny',
        sub: claimTypeLabel(r.claimType), tone: promoted ? 'neutral' : 'block',
      });
      nodes.push({
        id: `x${r.id}`, title: promoted ? 'Promoted' : 'Rejected', icon: promoted ? CheckCircle2 : Ban,
        value: `${r.precisionAfter.toFixed(2)}%`, sub: pts(r.precisionBefore, r.precisionAfter),
        tone: promoted ? 'pass' : 'block', emphasis: true, hint: r.reason,
      });
      edges.push({ from: 'labels', to: `p${r.id}` });
      edges.push({ from: `p${r.id}`, to: `r${r.id}`, tone: r.contradictions > 0 ? 'warn' : undefined });
      edges.push({ from: `r${r.id}`, to: `x${r.id}`, tone: promoted ? 'pass' : 'block' });
    }
    if (showReplay && selectedVersion && currentVersion && activeReplay) {
      const blocked = activeReplay.status === ReplayStatus.Blocked;
      const regressed = activeReplay.precisionAfter < activeReplay.precisionBefore;
      nodes.push({ id: 'decisions', title: `v${currentVersion.version} decisions`, icon: History, value: currentVersion.decisionCount.toLocaleString() });
      nodes.push({ id: 'proposal', title: 'Proposal', icon: Sparkles, value: `${changedRules.length} rule${changedRules.length === 1 ? '' : 's'}`, sub: `by ${selectedVersion.author}` });
      nodes.push({ id: 'prule', title: `Cedar v${selectedVersion.version}`, icon: GitBranch, value: `${selectedRules.length} rules`, sub: changedRules[0]?.name, tone: 'warn' });
      nodes.push({
        id: 'preplay', title: blocked ? 'Blocked' : 'Replay', icon: blocked ? Ban : History,
        value: `${activeReplay.precisionAfter.toFixed(1)}%`, sub: pts(activeReplay.precisionBefore, activeReplay.precisionAfter),
        tone: blocked ? 'block' : regressed ? 'warn' : 'pass', emphasis: true, hint: activeReplay.blockReason || undefined,
      });
      edges.push({ from: 'decisions', to: 'proposal' }, { from: 'proposal', to: 'prule' }, { from: 'prule', to: 'preplay', tone: blocked ? 'block' : 'pass' });
    }
    return { nodes, edges };
  }, [learned, labelStats.total, showReplay, selectedVersion, currentVersion, activeReplay, changedRules, selectedRules.length]);

  useEffect(() => {
    if (!activeReplay || !activeReplay.isPlaying || activeReplay.status !== ReplayStatus.Running) return;

    const interval = setInterval(() => {
      const claimsToAdvance = Math.round(activeReplay.speedMultiplier * 2);
      advanceReplay(activeReplay.id, claimsToAdvance);
    }, 50);

    return () => clearInterval(interval);
  }, [activeReplay, advanceReplay]);

  const handlePlayPause = useCallback(() => {
    if (activeReplay) {
      setReplayPlaying(activeReplay.id, !activeReplay.isPlaying);
    }
  }, [activeReplay, setReplayPlaying]);

  const handleSeek = useCallback((claim: number) => {
    if (activeReplay) {
      seekReplay(activeReplay.id, claim);
    }
  }, [activeReplay, seekReplay]);

  const handleSpeedChange = useCallback((speed: number) => {
    if (activeReplay) {
      setReplaySpeed(activeReplay.id, speed);
    }
  }, [activeReplay, setReplaySpeed]);

  const handleToggleRule = useCallback((ruleId: string) => {
    toggleRule(ruleId);
  }, [toggleRule]);

  const handleCreateVersion = useCallback(() => {
    if (!currentVersion) return;
    const maxVersion = Math.max(...policyVersions.map(v => v.version), 0);
    const newId = `v${maxVersion + 1}`;
    createPolicyVersion(newId, maxVersion + 1, 'User', currentVersion.id);
  }, [currentVersion, policyVersions, createPolicyVersion]);

  const handlePromote = useCallback(() => {
    if (selectedVersionId) {
      promotePolicyVersion(selectedVersionId);
    }
  }, [selectedVersionId, promotePolicyVersion]);

  const handleSelectNode = useCallback((id: string) => {
    const rule = learned.find(r => id.slice(1) === String(r.id));
    if (id === 'labels') setOpen({ kind: 'labels' });
    else if (id === 'decisions' || id === 'proposal' || id === 'prule' || id === 'preplay') setOpen({ kind: id });
    else if (rule) setOpen({ kind: id[0] === 'p' ? 'pattern' : id[0] === 'r' ? 'rule' : 'replay', rule });
  }, [learned]);

  const selectedNodeId = open === null ? null
    : 'rule' in open ? `${open.kind === 'pattern' ? 'p' : open.kind === 'rule' ? 'r' : 'x'}${open.rule.id}`
    : open.kind === 'cedar' ? null : open.kind;

  const loading = !connected && policyVersions.length === 0;

  return (
    <div className="policies-page">
      <div className="policies-main">
        <div className="versions-panel">
          <div className="ui-eyebrow versions-eyebrow">Versions</div>
          <div className="versions-list">
            {!loading && (
              <button
                className={`version-item history-item ${selectedVersionId === HISTORY ? 'selected' : ''}`}
                onClick={() => setSelectedVersionId(HISTORY)}
              >
                {selectedVersionId === HISTORY && <motion.span layoutId="policy-version-active" className="version-active-bg" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <span className="version-number">History</span>
                <span className="version-meta">
                  <History size={11} aria-hidden />
                  <span className="version-status">{decisions.length.toLocaleString()} labeled decisions</span>
                </span>
              </button>
            )}
            {loading ? <SkeletonRows rows={5} /> : policyVersions.map(version => (
              <VersionItem
                key={version.id}
                version={version}
                isSelected={selectedVersionId === version.id}
                onClick={() => setSelectedVersionId(version.id)}
              />
            ))}
          </div>
        </div>

        <div className="policies-content">
          {selectedVersionId === HISTORY && <HistoryView decisions={decisions} />}

          {selectedProposal && <ProposalPanel proposal={selectedProposal} decisions={decisions} />}

          {tech && selectedVersionId !== HISTORY && <section className="policy-section">
            <div className="policy-section-head">
              <span className="ui-section-title">Rule lineage</span>
              <span className="ui-legend">
                <span>Decisions</span><span className="policy-arrow">→</span><span>Pattern</span><span className="policy-arrow">→</span>
                <span>Rule</span><span className="policy-arrow">→</span><span>Replay</span>
              </span>
            </div>
            {loading ? <SkeletonGraph /> : nodes.length === 0 ? (
              <EmptyState art="graph" compact title="No learned rules yet" hint="Rules appear once reviewers agree on a pattern." />
            ) : (
              <FlowGraph
                nodes={nodes}
                edges={edges}
                height={Math.max(200, (learned.length + (showReplay ? 1 : 0)) * 86 + 24)}
                rankSep={56}
                selectedId={selectedNodeId}
                onSelect={handleSelectNode}
                label="Rule lineage: human decisions feed patterns, patterns become Cedar rules, rules are replayed on history"
              />
            )}
          </section>}

          {showReplay && activeReplay && (
            <section className="policy-section">
              <div className="policy-section-head">
                <span className="ui-section-title">Replay v{selectedVersion?.version} vs v{currentVersion?.version}</span>
              </div>
              <ReplayTiles replay={activeReplay} onPromote={handlePromote} tech={tech} />
            </section>
          )}

          {selectedVersion && (
            <RuleList
              rules={selectedRules}
              changed={changedIds}
              onToggleRule={handleToggleRule}
              onOpen={id => setOpen({ kind: 'cedar', id })}
              onCreateVersion={handleCreateVersion}
              canEdit={selectedVersion.status === PolicyStatus.Current}
            />
          )}
        </div>
      </div>

      {showReplay && activeReplay && (
        <ReplayBar
          replay={activeReplay}
          onPlayPause={handlePlayPause}
          onSpeedChange={handleSpeedChange}
          onSeek={handleSeek}
        />
      )}

      <PolicyDrawer
        open={open}
        onClose={() => setOpen(null)}
        labelStats={labelStats}
        cedarRules={cedarRules}
        changedRules={changedRules}
        selectedVersion={selectedVersion}
        currentVersion={currentVersion}
        replay={activeReplay}
        tech={tech}
      />
    </div>
  );
}

interface PolicyDrawerProps {
  open: Open | null;
  onClose: () => void;
  labelStats: { total: number; history: number; reviewers: number };
  cedarRules: CedarRule[];
  changedRules: CedarRule[];
  selectedVersion?: PolicyVersion;
  currentVersion?: PolicyVersion;
  replay?: PolicyReplay;
  tech: boolean;
}

function PolicyDrawer({ open, onClose, labelStats, cedarRules, changedRules, selectedVersion, currentVersion, replay, tech }: PolicyDrawerProps) {
  let eyebrow = '';
  let title = '';
  let body: React.ReactNode = null;

  if (open?.kind === 'labels') {
    eyebrow = 'Decisions';
    title = 'Human labels';
    body = (
      <>
        <Fact label="Labeled decisions" value={labelStats.total.toLocaleString()} />
        <Fact label="From history" value={labelStats.history.toLocaleString()} />
        <Fact label="Live reviews" value={(labelStats.total - labelStats.history).toLocaleString()} />
        <Fact label="Reviewers" value={labelStats.reviewers} />
      </>
    );
  } else if (open && 'rule' in open) {
    const r = open.rule;
    const conditions = parseJson<Condition[]>(r.conditionsJson) ?? [];
    const promoted = tag(r.status) === 'Promoted';
    eyebrow = `Learned rule L${r.id}`;
    if (open.kind === 'pattern') {
      title = 'Pattern';
      body = (
        <>
          <p className="ui-quote">{r.description}</p>
          <div className="ui-chips">{conditions.map((c, i) => <Chip key={i}>{conditionText(c)}</Chip>)}</div>
          <Fact label="Consistent decisions" value={r.support} />
          <Fact label="Reviewers" value={r.distinctReviewers} />
          <Fact label="Contradictions" value={r.contradictions} tone={r.contradictions > 0 ? 'warn' : undefined} />
        </>
      );
    } else if (open.kind === 'rule') {
      title = `${tag(r.verdict) === 'Approve' ? 'Approve' : 'Deny'} · ${claimTypeLabel(r.claimType)}`;
      body = (
        <>
          <div className="ui-chips">
            <Chip tone={promoted ? 'pass' : 'block'} icon={promoted ? CheckCircle2 : Ban}>{promoted ? 'Promoted' : 'Rejected'}</Chip>
          </div>
          <pre className="policy-code">{r.cedarText}</pre>
        </>
      );
    } else {
      title = promoted ? 'Replay passed' : 'Replay rejected';
      body = (
        <>
          <Fact label="Precision" value={`${r.precisionBefore.toFixed(2)}% → ${r.precisionAfter.toFixed(2)}%`} tone={r.precisionAfter < r.precisionBefore ? 'warn' : 'pass'} />
          <Fact label="Auto-decided coverage" value={`${r.coverageBefore.toFixed(2)}% → ${r.coverageAfter.toFixed(2)}%`} />
          <Meter value={r.coverageAfter} max={100} threshold={r.coverageBefore} label="Coverage after; tick is before" />
          <p className="ui-quote">{r.reason}</p>
        </>
      );
    }
  } else if (open?.kind === 'decisions' && currentVersion) {
    eyebrow = 'Decisions';
    title = `Under v${currentVersion.version}`;
    body = <Fact label="Decisions made" value={currentVersion.decisionCount.toLocaleString()} />;
  } else if ((open?.kind === 'proposal' || open?.kind === 'prule') && selectedVersion) {
    eyebrow = `v${selectedVersion.version} proposal`;
    title = open.kind === 'proposal' ? `Proposed by ${selectedVersion.author}` : 'Changed rules';
    body = (
      <>
        {changedRules.map(r => (
          <div key={r.id} className="policy-drawer-rule">
            <div className="policy-drawer-rule-name">{r.name}</div>
            <p className="ui-quote">{r.description}</p>
            {tech && <pre className="policy-code">{r.cedarCode}</pre>}
          </div>
        ))}
      </>
    );
  } else if (open?.kind === 'preplay' && replay) {
    eyebrow = 'Replay';
    title = `${replay.totalClaims.toLocaleString()} past claims`;
    body = (
      <>
        <Fact label="Precision" value={`${replay.precisionBefore.toFixed(1)}% → ${replay.precisionAfter.toFixed(1)}%`} tone={replay.precisionAfter < replay.precisionBefore ? 'warn' : 'pass'} />
        <Fact label="Decisions changed" value={replay.decisionsChanged} />
        <Fact label="Dollar impact" value={`${compactUsd(Math.abs(Number(replay.dollarImpactCents)))} ${Number(replay.dollarImpactCents) > 0 ? 'overpaid' : 'saved'}`} tone={Number(replay.dollarImpactCents) > 0 ? 'warn' : 'pass'} />
        <Fact label="Progress" value={`${replay.currentClaim.toLocaleString()} of ${replay.totalClaims.toLocaleString()}`} />
        {replay.blockReason && <Fact label="Blocked" value={replay.blockReason} tone="block" />}
      </>
    );
  } else if (open?.kind === 'cedar') {
    const r = cedarRules.find(x => x.id === open.id);
    if (r) {
      eyebrow = tech ? 'Cedar rule' : 'Rule';
      title = r.name;
      body = (
        <>
          <p className="ui-quote">{r.description}</p>
          {tech && <pre className="policy-code">{r.cedarCode}</pre>}
        </>
      );
    }
  }

  return (
    <Drawer open={open !== null && body !== null} onClose={onClose} eyebrow={eyebrow} title={title}>
      {body}
    </Drawer>
  );
}
