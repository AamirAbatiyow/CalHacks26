import { useState, useMemo, useCallback, useEffect } from 'react';
import { ClaimGlobe } from './ClaimGlobe';
import { ClaimPlaybackBar } from './ClaimPlaybackBar';
import { KpiStrip } from '../../components/KpiStrip';
import { useClaimData } from '../../hooks/useClaimData';
import { ClaimGate, DataIntegrityStatus } from '../../types';
import type { Claim, ClaimPass, ClaimEvidence, ClaimDecision, ClaimOutcome, ClaimWeather, Kpi } from '../../types';
import './Claim.css';

const DEMO_MODE = true;

function getDemoData(): {
  claim: Claim;
  pass: ClaimPass;
  evidence: ClaimEvidence;
  decision: ClaimDecision;
  outcome: ClaimOutcome;
  weather: ClaimWeather;
  kpi: Kpi;
} {
  const now = BigInt(Date.now() * 1000);
  return {
    claim: {
      id: 'CLM-10021',
      customerName: 'Northpoint Orbital',
      amountClaimedCents: BigInt(1820000),
      passId: BigInt(10021),
      createdAt: now,
    },
    pass: {
      id: BigInt(10021),
      claimId: 'CLM-10021',
      stationLat: 78.23,
      stationLon: 15.39,
      stationName: 'Svalbard',
      satelliteNoradId: 25544,
      satelliteTle1: '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9025',
      satelliteTle2: '2 25544  51.6400 208.9163 0006703 272.9017  87.1268 15.50109356999999',
      contactStartTime: now - BigInt(45 * 60 * 1000000),
      signalLostTime: now - BigInt(32 * 60 * 1000000),
      contactEndTime: now - BigInt(20 * 60 * 1000000),
      maxElevationDeg: 12.4,
    },
    evidence: {
      claimId: 'CLM-10021',
      dataIntegrityStatus: DataIntegrityStatus.Pass,
      estimatedLossCents: BigInt(240000),
      missingEvidenceCents: BigInt(158000),
    },
    decision: {
      claimId: 'CLM-10021',
      creditAmountCents: BigInt(115000),
      confidencePercent: 96,
      gate: ClaimGate.Auto,
      rule: 'credit_auto_limit',
      policyVersion: 'v4',
      modelVersion: 'v2',
      decidedAt: now,
    },
    outcome: {
      claimId: 'CLM-10021',
      creditMemoSent: true,
      ledgerPosted: true,
      completedAt: now,
    },
    weather: {
      claimId: 'CLM-10021',
      kpIndex: 6,
      stormActive: true,
    },
    kpi: {
      id: 'main',
      billedThisMonthCents: BigInt(1940000000),
      revenueAtRiskCents: BigInt(41200000),
      creditsPaidCents: BigInt(8600000),
      recoveredCents: BigInt(13100000),
    },
  };
}

function formatDollarsExact(cents: bigint | number): string {
  const dollars = Number(cents) / 100;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function getGateLabel(gate: ClaimGate): string {
  switch (gate) {
    case ClaimGate.Auto:
      return 'auto';
    case ClaimGate.Approval:
      return 'needs approval';
    case ClaimGate.Escalated:
      return 'escalated';
  }
}

interface ClaimPageProps {
  claimId?: string;
}

export default function ClaimPage({ claimId = 'CLM-10021' }: ClaimPageProps) {
  const liveData = useClaimData(claimId);

  const demoData = useMemo(() => getDemoData(), []);
  
  const useDemo = DEMO_MODE || !liveData.connected;
  const claim = useDemo ? demoData.claim : liveData.claim;
  const pass = useDemo ? demoData.pass : liveData.pass;
  const evidence = useDemo ? demoData.evidence : liveData.evidence;
  const decision = useDemo ? demoData.decision : liveData.decision;
  const outcome = useDemo ? demoData.outcome : liveData.outcome;
  const weather = useDemo ? demoData.weather : liveData.weather;
  const kpi = useDemo ? demoData.kpi : liveData.kpi;
  const connected = useDemo || liveData.connected;

  const [currentTimeOverride, setCurrentTimeOverride] = useState<bigint | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 4>(4);

  const currentTime = currentTimeOverride ?? pass?.contactStartTime ?? BigInt(0);

  useEffect(() => {
    if (DEMO_MODE || !liveData.connected) return;

    const timer = setTimeout(() => {
      if (!liveData.claim) {
        liveData.seedDemoClaim();
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [liveData]);

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
        <KpiStrip kpi={null} connected={false} />
        <div className="claim-loading">Connecting to SpacetimeDB...</div>
      </div>
    );
  }

  if (!claim || !pass || !evidence || !decision || !outcome || !weather) {
    return (
      <div className="claim-page">
        <KpiStrip kpi={kpi} connected={connected} />
        <div className="claim-loading">Loading claim data...</div>
      </div>
    );
  }

  return (
    <div className="claim-page">
      <KpiStrip kpi={kpi} connected={connected} />

      <div className="claim-content">
        <div className="claim-globe-section">
          <ClaimGlobe
            stationLat={pass.stationLat}
            stationLon={pass.stationLon}
            stationName={pass.stationName}
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
                <span className="decision-credit">Partial credit {formatDollarsExact(decision.creditAmountCents)}</span>
                <span className="decision-separator">·</span>
                <span className="decision-confidence">confidence {decision.confidencePercent}%</span>
                <span className="decision-separator">·</span>
                <span className={`decision-gate ${decision.gate.toLowerCase()}`}>{getGateLabel(decision.gate)}</span>
              </div>
              <div className="decision-meta">
                <span>Rule: {decision.rule}</span>
                <span className="decision-separator">·</span>
                <span>Policy {decision.policyVersion}</span>
                <span className="decision-separator">·</span>
                <span>Model {decision.modelVersion}</span>
              </div>
            </div>

            <div className="outcome-row">
              {outcome.creditMemoSent && <span className="outcome-item">Credit memo sent</span>}
              {outcome.creditMemoSent && outcome.ledgerPosted && (
                <span className="outcome-separator">·</span>
              )}
              {outcome.ledgerPosted && <span className="outcome-item">Ledger posted</span>}
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
