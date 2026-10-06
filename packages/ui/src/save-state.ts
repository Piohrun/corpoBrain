import { useSyncExternalStore } from 'react';

export type SaveState = 'saved' | 'saving' | 'error';

/**
 * The editor's save indicator. It flips twice per autosave; kept outside React
 * state so only the status bar re-renders, not the whole app shell.
 */
let current: SaveState = 'saved';
const listeners = new Set<() => void>();

export function getSaveState(): SaveState {
  return current;
}

export function setSaveState(next: SaveState): void {
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSaveState(): SaveState {
  return useSyncExternalStore(subscribe, getSaveState);
}
