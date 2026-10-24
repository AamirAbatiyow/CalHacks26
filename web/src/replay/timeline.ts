import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { animate, useMotionValue, useMotionValueEvent, type AnimationPlaybackControls, type MotionValue } from 'motion/react';

/**
 * The replay runs on one motion value `t`, measured in stages. Stage `i` owns
 * `[i, i + 1)`: its node draws in over `DRAW`, its output settles over
 * `CONTENT`, it holds at `REST`, and the edge to the next stage pulses over
 * `[i + 1 - EDGE, i + 1)`. Every node and edge derives its own progress from
 * `t`, so playback never re-renders React per frame.
 */
export const DRAW: [number, number] = [0, 0.3];
export const CONTENT: [number, number] = [0.14, 0.42];
export const REST = 0.55;
export const EDGE = 0.4;
export const SECONDS_PER_STAGE = 1.9;
export const SPEEDS = [0.5, 1, 2, 4] as const;
export type ReplaySpeed = (typeof SPEEDS)[number];

export const restPoint = (i: number) => i + REST;
export const endPoint = (count: number) => restPoint(Math.max(0, count - 1));

export interface TimelineContextValue {
  t: MotionValue<number>;
  active: number;
}

export const TimelineContext = createContext<TimelineContextValue | null>(null);

export function useTimelineContext(): TimelineContextValue {
  const ctx = useContext(TimelineContext);
  if (!ctx) throw new Error('Replay nodes must render inside a TimelineContext');
  return ctx;
}

export function useTimeline(count: number) {
  const t = useMotionValue(0);
  const end = endPoint(count);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [active, setActive] = useState(0);
  const [done, setDone] = useState(false);
  const [run, setRun] = useState(0);
  const controls = useRef<AnimationPlaybackControls | null>(null);

  useMotionValueEvent(t, 'change', v => {
    setActive(Math.max(0, Math.min(count - 1, Math.floor(v + 1e-6))));
    setDone(v >= end - 1e-3);
  });

  const stop = useCallback(() => {
    controls.current?.stop();
    controls.current = null;
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (t.get() >= end - 1e-3) t.set(0);
    const remaining = end - t.get();
    const c = animate(t, end, { duration: (remaining * SECONDS_PER_STAGE) / speed, ease: 'linear' });
    controls.current = c;
    c.then(() => {
      if (t.get() >= end - 1e-3) setPlaying(false);
    });
    return () => c.stop();
  }, [playing, speed, end, run, t]);

  const goTo = useCallback((target: number) => {
    stop();
    setPlaying(false);
    const distance = Math.abs(target - t.get());
    controls.current = animate(t, target, {
      duration: Math.min(1.4, (distance * SECONDS_PER_STAGE * 0.5) / speed),
      ease: [0.33, 0, 0.2, 1],
    });
  }, [speed, stop, t]);

  const stageAt = useCallback(() => Math.max(0, Math.min(count - 1, Math.floor(t.get() + 1e-6))), [count, t]);

  const stepForward = useCallback(() => {
    goTo(restPoint(Math.min(count - 1, stageAt() + 1)));
  }, [count, goTo, stageAt]);

  const stepBack = useCallback(() => {
    const current = stageAt();
    goTo(current === 0 ? 0 : restPoint(current - 1));
  }, [goTo, stageAt]);

  const seekStage = useCallback((i: number) => goTo(restPoint(i)), [goTo]);

  const replay = useCallback(() => {
    stop();
    t.set(0);
    setPlaying(true);
    setRun(r => r + 1);
  }, [stop, t]);

  const togglePlay = useCallback(() => {
    if (playing) {
      stop();
      setPlaying(false);
    } else {
      setPlaying(true);
    }
  }, [playing, stop]);

  return { t, end, active, done, playing, speed, setSpeed, togglePlay, stepForward, stepBack, seekStage, replay };
}
