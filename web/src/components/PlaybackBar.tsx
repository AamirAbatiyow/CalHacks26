import { useMemo } from 'react';
import type { Pass, PlaybackSpeed } from '../types';
import { PassStatus } from '../types';
import './PlaybackBar.css';

interface PlaybackBarProps {
  currentTime: bigint;
  startTime: bigint;
  endTime: bigint;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  isLive: boolean;
  passes: Pass[];
  onPlayPause: () => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onSeek: (timestamp: bigint) => void;
  onGoLive: () => void;
}

function formatTimestamp(micros: bigint): string {
  const date = new Date(Number(micros) / 1000);
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  };
  return date.toLocaleString('en-US', options);
}

export function PlaybackBar({
  currentTime,
  startTime,
  endTime,
  isPlaying,
  speed,
  isLive,
  passes,
  onPlayPause,
  onSpeedChange,
  onSeek,
  onGoLive,
}: PlaybackBarProps) {
  const progress = useMemo(() => {
    const total = Number(endTime - startTime);
    const current = Number(currentTime - startTime);
    return Math.max(0, Math.min(100, (current / total) * 100));
  }, [currentTime, startTime, endTime]);

  const eventTicks = useMemo(() => {
    const total = Number(endTime - startTime);
    return passes
      .filter(p => p.status === PassStatus.Dropped || p.status === PassStatus.Active)
      .map(p => ({
        position: (Number(p.startTime - startTime) / total) * 100,
        isDispute: p.status === PassStatus.Dropped,
      }))
      .filter(t => t.position >= 0 && t.position <= 100);
  }, [passes, startTime, endTime]);

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const timestamp = startTime + BigInt(Math.floor(percentage * Number(endTime - startTime)));
    onSeek(timestamp);
  };

  const speeds: PlaybackSpeed[] = [1, 4, 16];

  return (
    <div className="playback-bar">
      <div className="playback-controls">
        <button className="control-btn" onClick={() => onSeek(startTime)} title="Skip to start">
          ⏮
        </button>
        <button className="control-btn play-btn" onClick={onPlayPause} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? '⏸' : '▶'}
        </button>
        <button className="control-btn" onClick={() => onSeek(endTime)} title="Skip to end">
          ⏭
        </button>
        <div className="speed-controls">
          {speeds.map(s => (
            <button
              key={s}
              className={`speed-btn ${speed === s ? 'active' : ''}`}
              onClick={() => onSpeedChange(s)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="scrubber-container">
        <div className="scrubber" onClick={handleScrub}>
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
        <span className="scrubber-label">last 24 hours</span>
      </div>

      <div className="playback-timestamp">
        <span className="timestamp-value">{formatTimestamp(currentTime)}</span>
        <button
          className={`live-btn ${isLive ? 'active' : ''}`}
          onClick={onGoLive}
        >
          Live
        </button>
      </div>
    </div>
  );
}
