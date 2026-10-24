import { reconnectDelayMs } from './backoff.ts';
import { DbConnection } from './module_bindings/index.ts';

export const STDB_HOST = process.env.STDB_HOST || 'ws://localhost:3000';
export const STDB_MODULE = process.env.STDB_MODULE || process.env.SPACETIMEDB_MODULE || 'ground-truth';

/**
 * Connects and keeps the connection alive: on a connect error or a disconnect it
 * retries with backoff instead of exiting, and calls `onConnect` again for every
 * new connection so subscriptions and the heartbeat resume.
 */
export function connect(onConnect: (conn: DbConnection) => void, opts: { retry?: boolean } = {}): void {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const retry = (why: string) => {
    if (opts.retry === false) {
      console.error(`[worker] ${why}`);
      process.exit(1);
    }
    if (timer) return;
    const delay = reconnectDelayMs(attempt++);
    console.error(`[worker] ${why}; reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt})`);
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  };

  const open = () => {
    try {
      DbConnection.builder()
        .withUri(STDB_HOST)
        .withDatabaseName(STDB_MODULE)
        .onConnect(conn => {
          if (attempt > 0) console.log(`[worker] reconnected to ${STDB_HOST}/${STDB_MODULE}`);
          attempt = 0;
          onConnect(conn);
        })
        .onConnectError((_ctx, err) => retry(`could not connect to ${STDB_HOST}/${STDB_MODULE}: ${err?.message ?? err}`))
        .onDisconnect((_ctx, err) => retry(`disconnected from SpacetimeDB${err ? `: ${err.message ?? err}` : ''}`))
        .build();
    } catch (err) {
      retry(`connection setup failed: ${(err as Error).message}`);
    }
  };

  open();
}

export const tagOf = (v: unknown): string =>
  typeof v === 'string' ? v : v && typeof v === 'object' && 'tag' in v ? String((v as { tag: unknown }).tag) : '';
