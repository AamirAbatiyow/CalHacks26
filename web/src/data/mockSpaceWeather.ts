import type { SpaceWeatherEvent } from '../types';

const now = new Date();
const hour = 60 * 60 * 1000;

function hoursAgo(h: number): Date {
  return new Date(now.getTime() - h * hour);
}

export const mockSpaceWeather: SpaceWeatherEvent[] = [
  { time: hoursAgo(24), kpIndex: 2 },
  { time: hoursAgo(23), kpIndex: 2 },
  { time: hoursAgo(22), kpIndex: 3 },
  { time: hoursAgo(21), kpIndex: 3 },
  { time: hoursAgo(20), kpIndex: 4 },
  { time: hoursAgo(19), kpIndex: 4 },
  { time: hoursAgo(18), kpIndex: 5 },
  { time: hoursAgo(17), kpIndex: 5 },
  { time: hoursAgo(16), kpIndex: 6, flareClass: 'M', flareIntensity: 2.1 },
  { time: hoursAgo(15), kpIndex: 6 },
  { time: hoursAgo(14), kpIndex: 6 },
  { time: hoursAgo(13), kpIndex: 5 },
  { time: hoursAgo(12), kpIndex: 5 },
  { time: hoursAgo(11), kpIndex: 4 },
  { time: hoursAgo(10), kpIndex: 4 },
  { time: hoursAgo(9), kpIndex: 3 },
  { time: hoursAgo(8), kpIndex: 3 },
  { time: hoursAgo(7), kpIndex: 3 },
  { time: hoursAgo(6), kpIndex: 4 },
  { time: hoursAgo(5), kpIndex: 5 },
  { time: hoursAgo(4), kpIndex: 5 },
  { time: hoursAgo(3), kpIndex: 4 },
  { time: hoursAgo(2), kpIndex: 3 },
  { time: hoursAgo(1), kpIndex: 3 },
  { time: hoursAgo(0), kpIndex: 2 },
];

export function getSpaceWeatherAtTime(time: Date): SpaceWeatherEvent | undefined {
  // Find the most recent weather event at or before the given time
  const sorted = [...mockSpaceWeather].sort(
    (a, b) => b.time.getTime() - a.time.getTime()
  );
  return sorted.find((event) => event.time <= time);
}

export function getKpIndexAtTime(time: Date): number {
  const event = getSpaceWeatherAtTime(time);
  return event?.kpIndex ?? 2;
}

// Returns the auroral oval latitude based on Kp index
// Higher Kp = larger auroral oval = lower latitude
export function getAuroralOvalLatitude(kpIndex: number): number {
  // Simplified model: Kp 0 = ~67°, Kp 9 = ~45°
  return Math.max(45, 67 - kpIndex * 2.5);
}
