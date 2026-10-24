import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePoliciesDB } from '../../hooks/usePoliciesDB';
import { PolicyStatus, ReplayStatus } from '../../types';
import type { PolicyVersion, CedarRule, PolicyReplay } from '../../types';
import './Policies.css';

function formatDate(micros: bigint): string {
  const date = new Date(Number(micros) / 1000);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDollars(cents: bigint): string {
  const dollars = Math.abs(Number(cents)) / 100;
  const sign = Number(cents) >= 0 ? '+' : '-';
  if (dollars >= 1000000) {
    return `${sign}$${(dollars / 1000000).toFixed(1)}M`;
  }
  if (dollars >= 1000) {
    return `${sign}$${(dollars / 1000).toFixed(1)}K`;
  }
  return `${sign}$${dollars.toFixed(0)}`;
}

function getStatusLabel(status: PolicyStatus, author: string): string {
  switch (status) {
    case PolicyStatus.Proposed:
      return `Proposed by ${author}`;
    case PolicyStatus.Current:
      return 'Current';
    case PolicyStatus.Retired:
      return 'Retired';
  }
}

interface VersionItemProps {
  version: PolicyVersion;
  isSelected: boolean;
  onClick: () => void;
}

function VersionItem({ version, isSelected, onClick }: VersionItemProps) {
  return (
    <button
      className={`version-item ${isSelected ? 'selected' : ''} ${version.status.toLowerCase()}`}
      onClick={onClick}
    >
      <div className="version-header">
        <span className="version-number">v{version.version}</span>
      </div>
      <div className="version-meta">
        <span className="version-status">{getStatusLabel(version.status, version.author)}</span>
        {version.status !== PolicyStatus.Proposed && (
          <span className="version-date"> · {formatDate(version.createdAt)}</span>
        )}
      </div>
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

  const eventTicks = useMemo(() => {
    const ticks = [];
    const seed = Number(replay.id);
    for (let i = 0; i < 20; i++) {
      const pos = ((seed * 17 + i * 73) % 100);
      ticks.push({
        position: pos,
        isDispute: i % 4 === 0,
      });
    }
    return ticks;
  }, [replay.id]);

  return (
    <div className="replay-bar">
      <div className="replay-controls">
        <button className="control-btn" onClick={() => onSeek(0)} title="Skip to start">
          ⏮
        </button>
        <button className="control-btn play-btn" onClick={onPlayPause} title={playing ? 'Pause' : 'Play'}>
          {playing ? '⏸' : '▶'}
        </button>
        <button className="control-btn" onClick={() => onSeek(replay.totalClaims)} title="Skip to end">
          ⏭
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
            {eventTicks.map((tick, i) => (
              <div
                key={i}
                className={`scrubber-tick ${tick.isDispute ? 'dispute' : ''}`}
                style={{ left: `${tick.position}%` }}
              />
            ))}
            <div className="scrubber-handle" style={{ left: `${progress}%` }} />
          </div>
        </div>
        <span className="scrubber-label">Replaying {replay.totalClaims.toLocaleString()} past claims</span>
      </div>

      <div className="replay-timestamp">
        <span className="timestamp-value">Claim {replay.currentClaim.toLocaleString()} of {replay.totalClaims.toLocaleString()}</span>
        <button className="live-btn">
          Live
        </button>
      </div>
    </div>
  );
}

interface ReplayResultsProps {
  replay: PolicyReplay;
  proposedVersion: PolicyVersion;
  currentVersion: PolicyVersion;
  onPromote: () => void;
}

function ReplayResults({ replay, proposedVersion, currentVersion, onPromote }: ReplayResultsProps) {
  const precisionRegressed = replay.precisionAfter < replay.precisionBefore;
  const isBlocked = replay.status === ReplayStatus.Blocked;
  const isCompleted = replay.status === ReplayStatus.Completed;

  return (
    <div className="replay-results">
      <h2 className="replay-title">
        Replay v{proposedVersion.version} vs v{currentVersion.version} on {replay.totalClaims.toLocaleString()} past claims
      </h2>

      <div className="replay-metrics">
        <div className="replay-metric">
          <span className="metric-label">Precision</span>
          <span className={`metric-value precision ${precisionRegressed ? 'regressed' : 'improved'}`}>
            {replay.precisionBefore.toFixed(1)}% to {replay.precisionAfter.toFixed(1)}%
          </span>
        </div>

        <div className="replay-metric">
          <span className="metric-label">Decisions changed</span>
          <span className="metric-value">{replay.decisionsChanged}</span>
        </div>

        <div className="replay-metric">
          <span className="metric-label">Dollar impact</span>
          <span className={`metric-value ${Number(replay.dollarImpactCents) > 0 ? 'negative' : 'positive'}`}>
            {formatDollars(replay.dollarImpactCents)} {Number(replay.dollarImpactCents) > 0 ? 'overpaid' : 'saved'}
          </span>
        </div>
      </div>

      {isBlocked && replay.blockReason && (
        <div className="replay-blocked">
          <span className="blocked-badge">Blocked: {replay.blockReason}</span>
        </div>
      )}

      {isCompleted && !isBlocked && (
        <div className="replay-actions">
          <button className="promote-btn" onClick={onPromote}>Promote to Current</button>
        </div>
      )}
    </div>
  );
}

interface RuleEditorProps {
  rules: CedarRule[];
  onToggleRule: (ruleId: string) => void;
  onCreateVersion: () => void;
  canEdit: boolean;
}

function RuleEditor({ rules, onToggleRule, onCreateVersion, canEdit }: RuleEditorProps) {
  const [expandedRule, setExpandedRule] = useState<string | null>(null);

  return (
    <div className="rule-editor">
      <div className="rule-editor-header">
        <h3>Cedar Rules</h3>
        {canEdit && (
          <button className="add-rule-btn">+ Add Rule</button>
        )}
      </div>
      <div className="rules-list">
        {rules.map(rule => (
          <div key={rule.id} className={`rule-item ${!rule.enabled ? 'disabled' : ''}`}>
            <div className="rule-header" onClick={() => setExpandedRule(expandedRule === rule.id ? null : rule.id)}>
              <div className="rule-info">
                <span className="rule-name">{rule.name}</span>
                <span className="rule-description">{rule.description}</span>
              </div>
              <div className="rule-actions">
                {canEdit && (
                  <button
                    className={`toggle-btn ${rule.enabled ? 'enabled' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleRule(rule.id);
                    }}
                  >
                    {rule.enabled ? 'ON' : 'OFF'}
                  </button>
                )}
                <span className="expand-icon">{expandedRule === rule.id ? '▼' : '▶'}</span>
              </div>
            </div>
            {expandedRule === rule.id && (
              <div className="rule-code">
                <pre>{rule.cedarCode}</pre>
              </div>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="rule-editor-footer">
          <button className="create-version-btn" onClick={onCreateVersion}>
            Create New Version
          </button>
        </div>
      )}
    </div>
  );
}

export default function Policies() {
  const {
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

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  useEffect(() => {
    if (policyVersions.length > 0 && !selectedVersionId) {
      const proposed = policyVersions.find(v => v.status === PolicyStatus.Proposed);
      setSelectedVersionId(proposed?.id ?? policyVersions[0].id);
    }
  }, [policyVersions, selectedVersionId]);

  const selectedVersion = policyVersions.find(v => v.id === selectedVersionId);
  const currentVersion = policyVersions.find(v => v.status === PolicyStatus.Current);
  const selectedRules = cedarRules.filter(r => r.policyVersionId === selectedVersionId);

  const activeReplay = replays.find(
    r => r.proposedVersionId === selectedVersionId &&
      (r.status === ReplayStatus.Running || r.status === ReplayStatus.Blocked || r.status === ReplayStatus.Completed)
  );

  const showReplay = selectedVersion?.status === PolicyStatus.Proposed && currentVersion && activeReplay;

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

  return (
    <div className="policies-page">
      <div className="policies-main">
        <div className="versions-panel">
          <div className="versions-list">
            {policyVersions.map(version => (
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
          {showReplay && selectedVersion && currentVersion && activeReplay && (
            <ReplayResults
              replay={activeReplay}
              proposedVersion={selectedVersion}
              currentVersion={currentVersion}
              onPromote={handlePromote}
            />
          )}

          {selectedVersion && (
            <RuleEditor
              rules={selectedRules}
              onToggleRule={handleToggleRule}
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
    </div>
  );
}
