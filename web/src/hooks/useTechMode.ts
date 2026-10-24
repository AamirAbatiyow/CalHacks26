import { useSyncExternalStore } from 'react';

const KEY = 'gt.showTechnicalDetails';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setTechMode(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Private mode: the setting lasts for this tab only.
  }
  listeners.forEach(l => l());
}

/** Analyst mode: model accuracy, confidence, versions, worker and pipeline internals. Off by default. */
export function useTechMode(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
