import { useCallback, useRef, useState } from 'react';
import type { PlaybackState, TimelineEvent } from '../types';
import { TimelineTicks } from './TimelineTicks';
import './PlaybackBar.css';

interface PlaybackBarProps {
  playback: PlaybackState;
  progress: number;
  timeRangeStart: Date;
  timeRangeEnd: Date;
  onPlay: () => void;
  onPause: () => void;
  onTogglePlay: () => void;
  onCycleSpeed: () => void;
  onSeekToProgress: (progress: number) => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onGoLive: () => void;
  events?: TimelineEvent[];
}

function formatTime(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Los_Angeles',
  }) + ' PT';
}

function StepBackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function StepForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z" />
    </svg>
  );
}

export function PlaybackBar({
  playback,
  progress,
  timeRangeStart,
  timeRangeEnd,
  onTogglePlay,
  onCycleSpeed,
  onSeekToProgress,
  onStepForward,
  onStepBackward,
  onGoLive,
  events,
}: PlaybackBarProps) {
  const [isDragging, setIsDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  const handleScrubberChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value);
      onSeekToProgress(value);
    },
    [onSeekToProgress]
  );

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const newProgress = Math.max(0, Math.min(1, clickX / rect.width));
      onSeekToProgress(newProgress);
    },
    [onSeekToProgress]
  );

  const handleMouseDown = useCallback(() => {
    setIsDragging(true);
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const clampedProgress = Math.max(0, Math.min(1, progress));

  return (
    <div className="playback-bar-container" role="region" aria-label="Playback controls">
      {/* Controls Section */}
      <div className="playback-controls-section">
        <button
          className="playback-control-btn"
          onClick={onStepBackward}
          aria-label="Step backward 1 hour"
          title="Step backward (1 hour)"
        >
          <StepBackIcon />
        </button>
        
        <button
          className={`playback-control-btn ${playback.isPlaying ? 'playback-control-btn--active' : ''}`}
          onClick={onTogglePlay}
          aria-label={playback.isPlaying ? 'Pause playback' : 'Start playback'}
          title={playback.isPlaying ? 'Pause' : 'Play'}
        >
          {playback.isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        
        <button
          className="playback-control-btn"
          onClick={onStepForward}
          aria-label="Step forward 1 hour"
          title="Step forward (1 hour)"
        >
          <StepForwardIcon />
        </button>
        
        <button
          className="playback-control-btn playback-speed-btn"
          onClick={onCycleSpeed}
          aria-label={`Playback speed: ${playback.speed}x. Click to cycle.`}
          title={`Speed: ${playback.speed}x`}
        >
          {playback.speed}x
        </button>
      </div>

      {/* Timeline Section */}
      <div className="playback-timeline-section">
        <div
          ref={trackRef}
          className="timeline-track-container"
          onClick={handleTrackClick}
          role="presentation"
        >
          <div className="timeline-track">
            <div
              className="timeline-progress"
              style={{ width: `${clampedProgress * 100}%` }}
            />
            <TimelineTicks
              timeRangeStart={timeRangeStart}
              timeRangeEnd={timeRangeEnd}
              events={events}
            />
          </div>
          
          <input
            type="range"
            min="0"
            max="1"
            step="0.0001"
            value={clampedProgress}
            onChange={handleScrubberChange}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onTouchStart={handleMouseDown}
            onTouchEnd={handleMouseUp}
            className="timeline-scrubber"
            aria-label="Playback timeline scrubber"
            aria-valuemin={0}
            aria-valuemax={1}
            aria-valuenow={clampedProgress}
            aria-valuetext={formatTime(playback.currentTime)}
          />
          
          <div
            className="timeline-thumb"
            style={{ left: `${clampedProgress * 100}%` }}
            data-dragging={isDragging}
          />
        </div>
        
        <span className="timeline-label">last 24 hours</span>
      </div>

      {/* Time Display Section */}
      <div className="playback-time-section">
        <span className="time-display" aria-live="polite" aria-atomic="true">
          {formatTime(playback.currentTime)}
        </span>
        
        <button
          className={`live-btn ${playback.isLive ? 'live-btn--active' : ''}`}
          onClick={onGoLive}
          aria-label={playback.isLive ? 'Currently live' : 'Jump to live'}
          aria-pressed={playback.isLive}
        >
          Live
        </button>
      </div>
    </div>
  );
}

export type { PlaybackBarProps };
