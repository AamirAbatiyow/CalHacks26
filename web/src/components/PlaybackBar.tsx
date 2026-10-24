import { useMemo } from 'react';
import type { Pass, PlaybackSpeed, SpaceWeather } from '../types';
import { PassStatus } from '../types';
import { stormIntervals } from '../utils/storm';
import './PlaybackBar.css';

interface PlaybackBarProps {
  currentTime: bigint;
  startTime: bigint;
  endTime: bigint;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  isLive: boolean;
  passes: Pass[];
  spaceWeather: SpaceWeather[];
  onPlayPause: () => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onSeek: (timestamp: bigint) => void;
  onGoLive: () => void;
}

const PT = 'America/Los_Angeles';
const HOUR_MICROS = 3_600_000_000n;
const TICK_HOURS = 3;
const DROP_BINS = 96;

function formatTimestamp(micros: bigint): string {
  return new Date(Number(micros) / 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: PT, timeZoneName: 'short',
  });
}

function ptHour(ms: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: PT }).format(ms));
}

function tickLabel(ms: number): string {
  const hour = ptHour(ms);
  if (hour === 0) return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: PT });
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: PT });
}

export function PlaybackBar({
  currentTime,
  startTime,
  endTime,
  isPlaying,
  speed,
  isLive,
  passes,
  spaceWeather,
  onPlayPause,
  onSpeedChange,
  onSeek,
  onGoLive,
}: PlaybackBarProps) {
  const total = Number(endTime - startTime);
  const pct = (t: bigint) => Math.max(0, Math.min(100, (Number(t - startTime) / total) * 100));
  const progress = pct(currentTime);

  // Ticks on whole PT hours divisible by TICK_HOURS; the window start is truncated
  // to the hour so the ticks don't shift with every clock update.
  const hourStart = Number(startTime / HOUR_MICROS);
  const hourEnd = Number(endTime / HOUR_MICROS);
  const ticks = useMemo(() => {
    const out: { hourMs: number; label: string }[] = [];
    for (let h = hourStart + 1; h <= hourEnd; h++) {
      const ms = h * 3_600_000;
      if (ptHour(ms) % TICK_HOURS === 0) out.push({ hourMs: ms, label: tickLabel(ms) });
    }
    return out;
  }, [hourStart, hourEnd]);

  const storms = useMemo(
    () => stormIntervals(spaceWeather).filter(s => s.end > startTime && s.start < endTime),
    [spaceWeather, startTime, endTime],
  );

  const dropBins = useMemo(() => {
    const bins = new Array<number>(DROP_BINS).fill(0);
    for (const p of passes) {
      if (p.status !== PassStatus.Dropped || p.startTime < startTime || p.startTime >= endTime) continue;
      bins[Math.floor((Number(p.startTime - startTime) / total) * DROP_BINS)]++;
    }
    const max = Math.max(1, ...bins);
    return bins.map(n => n / max);
  }, [passes, startTime, endTime, total]);

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(startTime + BigInt(Math.floor(fraction * total)));
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
          <div className="scrubber-drops" aria-hidden>
            {dropBins.map((v, i) => v > 0 && (
              <span
                key={i}
                className="scrubber-drop"
                style={{ left: `${(i / DROP_BINS) * 100}%`, width: `${100 / DROP_BINS}%`, height: `${20 + v * 80}%` }}
              />
            ))}
          </div>
          <div className="scrubber-track">
            {storms.map(s => (
              <div
                key={String(s.start)}
                className="scrubber-storm"
                style={{ left: `${pct(s.start)}%`, width: `${pct(s.end) - pct(s.start)}%`, background: s.level.color }}
                title={`G${s.level.g} ${s.level.name}, peak Kp ${s.peakKp.toFixed(1)}: ${formatTimestamp(s.start)} – ${formatTimestamp(s.end)}`}
              />
            ))}
            <div className="scrubber-progress" style={{ width: `${progress}%` }} />
            {ticks.map(t => (
              <div key={t.hourMs} className="scrubber-hour" style={{ left: `${pct(BigInt(t.hourMs) * 1000n)}%` }} />
            ))}
            <div className="scrubber-handle" style={{ left: `${progress}%` }} />
          </div>
        </div>
        <div className="scrubber-ticks">
          {ticks.map(t => (
            <span key={t.hourMs} className="scrubber-tick-label" style={{ left: `${pct(BigInt(t.hourMs) * 1000n)}%` }}>
              {t.label}
            </span>
          ))}
          <span className="scrubber-tz">PT · last 24 h</span>
        </div>
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
