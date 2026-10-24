import { useMemo } from 'react';

interface ClaimPlaybackBarProps {
  currentTime: bigint;
  contactStart: bigint;
  signalLost: bigint;
  contactEnd: bigint;
  isPlaying: boolean;
  speed: 1 | 4;
  onPlayPause: () => void;
  onSeek: (timestamp: bigint) => void;
  onSpeedChange: (speed: 1 | 4) => void;
}

export function ClaimPlaybackBar({
  currentTime,
  contactStart,
  signalLost,
  contactEnd,
  isPlaying,
  speed,
  onPlayPause,
  onSeek,
  onSpeedChange,
}: ClaimPlaybackBarProps) {
  const { progress, signalLostPosition } = useMemo(() => {
    const total = Number(contactEnd - contactStart);
    if (total <= 0) return { progress: 0, signalLostPosition: 50 };
    
    const current = Number(currentTime - contactStart);
    const signalLostOffset = Number(signalLost - contactStart);
    
    return {
      progress: Math.max(0, Math.min(100, (current / total) * 100)),
      signalLostPosition: Math.max(0, Math.min(100, (signalLostOffset / total) * 100)),
    };
  }, [currentTime, contactStart, signalLost, contactEnd]);

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const timestamp = contactStart + BigInt(Math.floor(percentage * Number(contactEnd - contactStart)));
    onSeek(timestamp);
  };

  const handleSkipToStart = () => onSeek(contactStart);
  const handleSkipToSignalLost = () => onSeek(signalLost);
  const handleSkipToEnd = () => onSeek(contactEnd);

  return (
    <div className="claim-playback-bar">
      <div className="playback-controls">
        <button className="control-btn" onClick={handleSkipToStart} title="Contact start">
          ⏮
        </button>
        <button className="control-btn play-btn" onClick={onPlayPause} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '▐▐' : '▶'}
        </button>
        <button className="control-btn" onClick={handleSkipToEnd} title="Contact end">
          ⏭
        </button>
        <div className="speed-controls">
          <button
            className={`speed-btn ${speed === 1 ? 'active' : ''}`}
            onClick={() => onSpeedChange(1)}
          >
            1x
          </button>
          <button
            className={`speed-btn ${speed === 4 ? 'active' : ''}`}
            onClick={() => onSpeedChange(4)}
          >
            4x
          </button>
        </div>
      </div>

      <div className="claim-scrubber-container">
        <div className="claim-scrubber" onClick={handleScrub}>
          <div className="claim-scrubber-track">
            <div className="claim-scrubber-progress" style={{ width: `${progress}%` }} />
            <div
              className="claim-scrubber-event signal-lost-tick"
              style={{ left: `${signalLostPosition}%` }}
              title="Signal lost"
            />
            <div className="claim-scrubber-handle" style={{ left: `${progress}%` }} />
          </div>
        </div>
        <div className="claim-scrubber-labels">
          <button className="scrubber-label-btn" onClick={handleSkipToStart}>Contact start</button>
          <button 
            className="scrubber-label-btn signal-lost" 
            onClick={handleSkipToSignalLost}
            style={{ left: `${signalLostPosition}%` }}
          >
            Signal lost
          </button>
          <button className="scrubber-label-btn" onClick={handleSkipToEnd}>Contact end</button>
        </div>
      </div>
    </div>
  );
}
