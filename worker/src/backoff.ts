export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

/** Delay before reconnect attempt `attempt` (0-based): doubling from 1 s, capped at 30 s, with up to 20% jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + 0.2 * random()));
}
