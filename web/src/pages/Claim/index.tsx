import { useState, useMemo, useCallback, useEffect } from 'react';
import { ClaimGlobe } from './ClaimGlobe';
import { ClaimPlaybackBar } from './ClaimPlaybackBar';
import { useClaimData } from '../../hooks/useClaimData';
import { useHashParam } from '../../hooks/useHashPage';
import { useTable } from '../../hooks/useTable';
import { EmptyState } from '../../ui/EmptyState';
import { ClaimPanel, ClaimSkeleton } from './ClaimPanel';
import './Claim.css';

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

  if (!connected || (claimId && claim && (!pass || !evidence || !decision || !outcome || !weather))) {
    return <ClaimSkeleton />;
  }

  if (!claim || !pass || !evidence || !decision || !outcome || !weather) {
    return (
      <div className="claim-page">
        {!claimId
          ? <EmptyState art="orbit" title="No claims yet" hint={<>Seed one with <code>server/seed.sh</code>.</>} />
          : <EmptyState art="orbit" title={`Claim ${claimId} not found`} hint="It may not have synced yet, or the id is wrong." />}
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

        <ClaimPanel
          claim={claim}
          evidence={evidence}
          decision={decision}
          outcome={outcome}
          weather={weather}
          reasons={reasons}
          policyKnown={policyKnown}
        />
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
