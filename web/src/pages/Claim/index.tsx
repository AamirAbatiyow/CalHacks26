import { useState, useMemo, useCallback, useEffect } from 'react';
import { ClaimGlobe } from './ClaimGlobe';
import { ClaimPlaybackBar } from './ClaimPlaybackBar';
import { useClaimData } from '../../hooks/useClaimData';
import { useHashParam } from '../../hooks/useHashPage';
import { useTable } from '../../hooks/useTable';
import { ClaimGate, DataIntegrityStatus } from '../../types';
import './Claim.css';

function formatDollarsExact(cents: bigint | number): string {
  const dollars = Number(cents) / 100;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function getGateLabel(gate: ClaimGate): string {
  switch (gate) {
    case ClaimGate.Auto:
      return 'auto';
    case ClaimGate.Escalated:
      return 'escalated';
  }
}

function getCreditLabel(creditCents: bigint, claimedCents: bigint): string {
  if (creditCents <= 0n) return 'No credit';
  return creditCents >= claimedCents ? 'Full credit' : 'Partial credit';
}

function formatShap(value: number): string {
  return `${value >= 0 ? '+' : '\u2212'}${Math.abs(value).toFixed(2)}`;
}

function VersionLink({ label, version, policyVersion, known }: { label: string; version: string; policyVersion: string; known: boolean }) {
  if (!known) return <span>{label} {version}</span>;
  return (
    <a className="decision-link" href={`#/policies/${encodeURIComponent(policyVersion)}`} title={`Open policy ${policyVersion} in Policies`}>
      {label} {version}
    </a>
  );
}

export default function ClaimPage() {
  const requestedClaimId = useHashParam();
  const { claimId, claim, pass, evidence, decision, outcome, weather, reasons, stationRevenueCents, connected } =
    useClaimData(requestedClaimId);
  const policyVersions = useTable('policyVersion');

  const [currentTimeOverride, setCurrentTimeOverride] = useState<bigint | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 4>(4);

  const currentTime = currentTimeOverride ?? pass?.contactStartTime ?? BigInt(0);

  useEffect(() => {
    if (!isPlaying || !pass) return;

    const interval = setInterval(() => {
      setCurrentTimeOverride(prev => {
        const current = prev ?? pass.contactStartTime;
        const next = current + BigInt(100000 * playbackSpeed);
        if (next >= pass.contactEndTime) {
          setIsPlaying(false);
          return pass.contactEndTime;
        }
        return next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isPlaying, pass, playbackSpeed]);

  const playbackState = useMemo(() => {
    if (!pass) {
      return {
        phase: 'before' as const,
        contactStart: BigInt(0),
        signalLost: BigInt(0),
        contactEnd: BigInt(0),
      };
    }

    const { contactStartTime, signalLostTime, contactEndTime } = pass;

    let phase: 'before' | 'active' | 'lost' | 'after' = 'before';
    if (currentTime >= contactEndTime) {
      phase = 'after';
    } else if (currentTime >= signalLostTime) {
      phase = 'lost';
    } else if (currentTime >= contactStartTime) {
      phase = 'active';
    }

    return {
      phase,
      contactStart: contactStartTime,
      signalLost: signalLostTime,
      contactEnd: contactEndTime,
    };
  }, [pass, currentTime]);

  const handleSeek = useCallback((timestamp: bigint) => {
    setCurrentTimeOverride(timestamp);
    setIsPlaying(false);
  }, []);

  const handlePlayPause = useCallback(() => {
    setIsPlaying(prev => !prev);
  }, []);

  const handleSpeedChange = useCallback((speed: 1 | 4) => {
    setPlaybackSpeed(speed);
  }, []);

  if (!connected) {
    return (
      <div className="claim-page">
        <div className="claim-loading">Connecting to SpacetimeDB...</div>
      </div>
    );
  }

  if (!claim || !pass || !evidence || !decision || !outcome || !weather) {
    const message = !claimId
      ? 'No claims yet. Run server/seed.sh to seed one.'
      : claim ? `Loading claim ${claimId}...` : `Claim ${claimId} not found.`;
    return (
      <div className="claim-page">
        <div className="claim-loading">{message}</div>
      </div>
    );
  }

  const policyKnown = policyVersions.some(v => v.id === decision.policyVersion);

  return (
    <div className="claim-page">
      <div className="claim-content">
        <div className="claim-globe-section">
          <ClaimGlobe
            stationLat={pass.stationLat}
            stationLon={pass.stationLon}
            stationName={pass.stationName}
            stationRevenueCents={stationRevenueCents}
            satelliteTle1={pass.satelliteTle1}
            satelliteTle2={pass.satelliteTle2}
            currentTime={currentTime}
            signalLostTime={pass.signalLostTime}
            contactStartTime={pass.contactStartTime}
            contactEndTime={pass.contactEndTime}
            kpIndex={weather.kpIndex}
          />
        </div>

        <div className="claim-detail-panel">
          <div className="claim-header">
            <span className="claim-id">{claim.id}</span>
            <span className="claim-separator">·</span>
            <span className="claim-customer">{claim.customerName}</span>
            <span className="claim-separator">·</span>
            <span className="claim-amount">{formatDollarsExact(claim.amountClaimedCents)} claimed</span>
          </div>

          <div className="claim-sections">
            <div className="claim-section">
              <h3 className="section-title">Verified</h3>
              <div className="section-row">
                <span className="section-label">Data integrity check:</span>
                <span className={`section-value ${evidence.dataIntegrityStatus === DataIntegrityStatus.Pass ? 'pass' : 'fail'}`}>
                  {evidence.dataIntegrityStatus === DataIntegrityStatus.Pass ? 'PASS' :
                   evidence.dataIntegrityStatus === DataIntegrityStatus.Fail ? 'FAIL' : 'PENDING'}
                </span>
              </div>
            </div>

            <div className="claim-section">
              <h3 className="section-title">Model estimate</h3>
              <div className="section-row">
                <span className="section-label">Estimated loss:</span>
                <span className="section-value">{formatDollarsExact(evidence.estimatedLossCents)}</span>
              </div>
            </div>

            <div className="claim-section">
              <h3 className="section-title">Missing</h3>
              <div className="section-row">
                <span className="section-label">Unverified portion:</span>
                <span className="section-value muted">{formatDollarsExact(evidence.missingEvidenceCents)}</span>
              </div>
            </div>

            <div className="decision-card">
              <div className="decision-main">
                <span className="decision-credit">
                  {getCreditLabel(decision.creditAmountCents, claim.amountClaimedCents)} {formatDollarsExact(decision.creditAmountCents)}
                </span>
                <span className="decision-separator">·</span>
                <span className="decision-confidence">confidence {decision.confidencePercent}%</span>
                <span className="decision-separator">·</span>
                <span className={`decision-gate ${decision.gate.toLowerCase()}`}>{getGateLabel(decision.gate)}</span>
              </div>
              {reasons.length > 0 && (
                <div className="decision-reasons">
                  <span className="decision-reasons-title">Why (SHAP)</span>
                  {reasons.map(reason => (
                    <div key={String(reason.id)} className="reason-row">
                      <span className="reason-feature">
                        {reason.feature}
                        {reason.detail && <span className="reason-detail"> · {reason.detail}</span>}
                      </span>
                      <span className={`reason-value ${reason.shapValue < 0 ? 'negative' : ''}`}>{formatShap(reason.shapValue)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="decision-meta">
                <span>Rule: {decision.rule}</span>
                <span className="decision-separator">·</span>
                <VersionLink label="Policy" version={decision.policyVersion} policyVersion={decision.policyVersion} known={policyKnown} />
                <span className="decision-separator">·</span>
                <VersionLink label="Model" version={decision.modelVersion} policyVersion={decision.policyVersion} known={policyKnown} />
              </div>
            </div>

            <div className="outcome-row">
              <span className="outcome-item">{outcome.creditMemoSent ? 'Credit memo sent' : 'Credit memo not sent'}</span>
              <span className="outcome-separator">·</span>
              <span className="outcome-item">{outcome.ledgerPosted ? 'Ledger posted' : 'Ledger not posted'}</span>
            </div>
          </div>
        </div>
      </div>

      <ClaimPlaybackBar
        currentTime={currentTime}
        contactStart={playbackState.contactStart}
        signalLost={playbackState.signalLost}
        contactEnd={playbackState.contactEnd}
        isPlaying={isPlaying}
        speed={playbackSpeed}
        onPlayPause={handlePlayPause}
        onSeek={handleSeek}
        onSpeedChange={handleSpeedChange}
      />
    </div>
  );
}
