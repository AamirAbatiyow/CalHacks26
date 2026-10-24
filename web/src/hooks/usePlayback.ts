import { useState, useCallback, useRef, useEffect } from 'react';
import type { PlaybackState } from '../types';

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export function usePlayback() {
  const now = useRef(new Date());
  
  const [playback, setPlayback] = useState<PlaybackState>({
    isPlaying: false,
    speed: 1,
    currentTime: now.current,
    isLive: true,
  });

  const timeRangeStart = new Date(now.current.getTime() - TWENTY_FOUR_HOURS);
  const timeRangeEnd = now.current;

  const play = useCallback(() => {
    setPlayback((prev) => ({
      ...prev,
      isPlaying: true,
      isLive: false,
    }));
  }, []);

  const pause = useCallback(() => {
    setPlayback((prev) => ({
      ...prev,
      isPlaying: false,
    }));
  }, []);

  const togglePlay = useCallback(() => {
    setPlayback((prev) => ({
      ...prev,
      isPlaying: !prev.isPlaying,
      isLive: prev.isPlaying ? prev.isLive : false,
    }));
  }, []);

  const setSpeed = useCallback((speed: 1 | 4 | 16) => {
    setPlayback((prev) => ({
      ...prev,
      speed,
    }));
  }, []);

  const cycleSpeed = useCallback(() => {
    setPlayback((prev) => {
      const speeds: Array<1 | 4 | 16> = [1, 4, 16];
      const currentIndex = speeds.indexOf(prev.speed);
      const nextSpeed = speeds[(currentIndex + 1) % speeds.length];
      return {
        ...prev,
        speed: nextSpeed,
      };
    });
  }, []);

  const seek = useCallback((time: Date) => {
    const clampedTime = new Date(
      Math.min(
        Math.max(time.getTime(), timeRangeStart.getTime()),
        timeRangeEnd.getTime()
      )
    );
    setPlayback((prev) => ({
      ...prev,
      currentTime: clampedTime,
      isLive: clampedTime.getTime() >= timeRangeEnd.getTime() - 1000,
    }));
  }, [timeRangeStart, timeRangeEnd]);

  const seekToProgress = useCallback((progress: number) => {
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    const timeRange = timeRangeEnd.getTime() - timeRangeStart.getTime();
    const newTime = new Date(timeRangeStart.getTime() + timeRange * clampedProgress);
    seek(newTime);
  }, [seek, timeRangeStart, timeRangeEnd]);

  const stepForward = useCallback(() => {
    setPlayback((prev) => {
      const stepMs = 60 * 60 * 1000; // 1 hour step
      const newTime = new Date(
        Math.min(prev.currentTime.getTime() + stepMs, timeRangeEnd.getTime())
      );
      return {
        ...prev,
        currentTime: newTime,
        isLive: newTime.getTime() >= timeRangeEnd.getTime() - 1000,
      };
    });
  }, [timeRangeEnd]);

  const stepBackward = useCallback(() => {
    setPlayback((prev) => {
      const stepMs = 60 * 60 * 1000; // 1 hour step
      const newTime = new Date(
        Math.max(prev.currentTime.getTime() - stepMs, timeRangeStart.getTime())
      );
      return {
        ...prev,
        currentTime: newTime,
        isLive: false,
      };
    });
  }, [timeRangeStart]);

  const goLive = useCallback(() => {
    now.current = new Date();
    setPlayback({
      isPlaying: false,
      speed: 1,
      currentTime: now.current,
      isLive: true,
    });
  }, []);

  // Animation loop for playback
  useEffect(() => {
    if (!playback.isPlaying) return;

    let lastFrameTime = performance.now();
    let animationId: number;

    const animate = (currentFrameTime: number) => {
      const deltaMs = currentFrameTime - lastFrameTime;
      lastFrameTime = currentFrameTime;

      // Speed up time by the playback speed factor
      // 1x = real time, 4x = 4 times faster, etc.
      const simulatedDeltaMs = deltaMs * playback.speed * 60; // 60x base for visible movement

      setPlayback((prev) => {
        const newTime = new Date(prev.currentTime.getTime() + simulatedDeltaMs);
        
        // Stop at the end
        if (newTime.getTime() >= timeRangeEnd.getTime()) {
          return {
            ...prev,
            currentTime: timeRangeEnd,
            isPlaying: false,
            isLive: true,
          };
        }

        return {
          ...prev,
          currentTime: newTime,
        };
      });

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [playback.isPlaying, playback.speed, timeRangeEnd]);

  const progress = 
    (playback.currentTime.getTime() - timeRangeStart.getTime()) /
    (timeRangeEnd.getTime() - timeRangeStart.getTime());

  return {
    playback,
    progress,
    timeRangeStart,
    timeRangeEnd,
    play,
    pause,
    togglePlay,
    setSpeed,
    cycleSpeed,
    seek,
    seekToProgress,
    stepForward,
    stepBackward,
    goLive,
  };
}
