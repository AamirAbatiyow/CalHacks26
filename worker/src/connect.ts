import { DbConnection } from './module_bindings/index.ts';

export const STDB_HOST = process.env.STDB_HOST || 'ws://localhost:3000';
export const STDB_MODULE = process.env.STDB_MODULE || process.env.SPACETIMEDB_MODULE || 'ground-truth';

export function connect(onConnect: (conn: DbConnection) => void): DbConnection {
  return DbConnection.builder()
    .withUri(STDB_HOST)
    .withDatabaseName(STDB_MODULE)
    .onConnect(conn => onConnect(conn))
    .onConnectError((_ctx, err) => {
      console.error(`[worker] could not connect to ${STDB_HOST}/${STDB_MODULE}:`, err);
      process.exit(1);
    })
    .onDisconnect(() => {
      console.error('[worker] disconnected from SpacetimeDB');
      process.exit(1);
    })
    .build();
}

export const tagOf = (v: unknown): string =>
  typeof v === 'string' ? v : v && typeof v === 'object' && 'tag' in v ? String((v as { tag: unknown }).tag) : '';
