import { useEffect, useState } from 'react';
import { Timestamp } from 'spacetimedb';
import { DbConnection, tables } from '../module_bindings';
import { SPACETIMEDB_HOST, SPACETIMEDB_MODULE } from '../config';

type Db = DbConnection['db'];
export type TableName = keyof typeof tables & keyof Db;
export type RowOf<K extends TableName> = Db[K] extends { iter(): IterableIterator<infer R> } ? R : never;

interface TableHandle {
  iter(): IterableIterator<unknown>;
  onInsert(cb: () => void): void;
  onDelete(cb: () => void): void;
  onUpdate?: (cb: () => void) => void;
}

let conn: DbConnection | null = null;
let connected = false;
let reconnectDelay = 1000;
let currentIdentity: string | null = null;
const listeners = new Map<string, Set<() => void>>();
const subscribed = new Set<string>();
const pending = new Set<string>();
const connectionListeners = new Set<() => void>();

function notify(name: string) {
  if (pending.has(name)) return;
  pending.add(name);
  queueMicrotask(() => {
    pending.delete(name);
    listeners.get(name)?.forEach(l => l());
  });
}

function ensureSubscribed(name: TableName) {
  if (!conn || !connected || subscribed.has(name)) return;
  subscribed.add(name);
  const handle = conn.db[name] as unknown as TableHandle;
  const fire = () => notify(name);
  handle.onInsert(fire);
  handle.onDelete(fire);
  handle.onUpdate?.(fire);
  conn.subscriptionBuilder()
    .onApplied(fire)
    .onError(ctx => console.error(`Subscription to ${name} failed:`, ctx.event))
    .subscribe([tables[name]]);
}

export function getConnection(): DbConnection {
  if (conn) return conn;
  conn = DbConnection.builder()
    .withUri(SPACETIMEDB_HOST)
    .withDatabaseName(SPACETIMEDB_MODULE)
    .onConnect((_connection, identity) => {
      connected = true;
      currentIdentity = identity.toHexString();
      reconnectDelay = 1000;
      for (const name of listeners.keys()) ensureSubscribed(name as TableName);
      connectionListeners.forEach(l => l());
    })
    .onDisconnect(() => scheduleReconnect())
    .onConnectError(() => scheduleReconnect())
    .build();
  return conn;
}

function scheduleReconnect() {
  connected = false;
  conn = null;
  currentIdentity = null;
  subscribed.clear();
  connectionListeners.forEach(l => l());
  setTimeout(getConnection, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

/** Returns the current database identity as a hex string, or null if not connected. */
export function useIdentity(): string | null {
  const [id, setId] = useState<string | null>(currentIdentity);
  useEffect(() => {
    const update = () => setId(currentIdentity);
    connectionListeners.add(update);
    getConnection();
    update();
    return () => { connectionListeners.delete(update); };
  }, []);
  return id;
}

function readRows<K extends TableName>(name: K): RowOf<K>[] {
  if (!conn || !connected) return [];
  return Array.from((conn.db[name] as unknown as TableHandle).iter()) as RowOf<K>[];
}

/** Live rows of a SpacetimeDB table, shared across components over one connection. */
export function useTable<K extends TableName>(name: K): RowOf<K>[] {
  const [rows, setRows] = useState<RowOf<K>[]>(() => readRows(name));
  useEffect(() => {
    const update = () => setRows(readRows(name));
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(update);
    getConnection();
    ensureSubscribed(name);
    update();
    return () => {
      set.delete(update);
    };
  }, [name]);
  return rows;
}

export function useConnected(): boolean {
  const [state, setState] = useState(connected);
  useEffect(() => {
    const update = () => setState(connected);
    connectionListeners.add(update);
    getConnection();
    update();
    return () => {
      connectionListeners.delete(update);
    };
  }, []);
  return state;
}

/** Reducer namespace of the shared connection, or null while disconnected. */
export function reducers(): DbConnection['reducers'] | null {
  return conn && connected ? conn.reducers : null;
}

export function micros(ts: unknown): bigint {
  if (ts instanceof Timestamp) return ts.microsSinceUnixEpoch;
  if (typeof ts === 'bigint') return ts;
  if (typeof ts === 'number') return BigInt(Math.round(ts));
  if (ts && typeof ts === 'object' && '__timestamp_micros_since_unix_epoch__' in ts) {
    return BigInt((ts as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__);
  }
  return 0n;
}

/** Variant name of a SpacetimeDB sum-type value (`{ tag: 'Auto' }` -> `'Auto'`). */
export function tag(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'tag' in value) return String((value as { tag: unknown }).tag);
  return '';
}
