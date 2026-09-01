import { useCallback, useEffect, useRef, useState } from 'react';
import { type JiraStatus, planApi } from './api.ts';

type PathsListener = (paths: string[]) => void;

/**
 * One EventSource for the whole tab. Every page and panel subscribes here;
 * opening a stream per subscriber ate the browser's per-host connection
 * budget (six on HTTP/1.1) and queued ordinary API calls behind them.
 */
const listeners = new Set<PathsListener>();
let stream: EventSource | null = null;

function ensureStream(): void {
  if (stream) return;
  stream = new EventSource('/api/events'); // reconnects on its own after errors
  stream.onmessage = (ev) => {
    let paths: string[] | undefined;
    try {
      paths = (JSON.parse(ev.data as string) as { paths?: string[] }).paths;
    } catch {
      return;
    }
    if (!paths?.length) return;
    for (const fn of [...listeners]) fn(paths);
  };
}

function subscribe(fn: PathsListener): () => void {
  listeners.add(fn);
  ensureStream();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && stream) {
      stream.close();
      stream = null;
    }
  };
}

/** Subscribe to server-sent vault change events (shared connection). */
export function useVaultEvents(onPaths: PathsListener): void {
  const cb = useRef(onPaths);
  cb.current = onPaths;
  useEffect(() => subscribe((paths) => cb.current(paths)), []);
}

/**
 * Debounce `fn`. Returns [call, flush, cancel]: flush runs a pending call
 * now, cancel drops it. Pending work is flushed on unmount unless the
 * caller cancelled it first (e.g. the note was just deleted).
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): [(...args: A) => void, () => void, () => void] {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<A | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };
  const flush = () => {
    const args = pending.current;
    cancel();
    if (args) fnRef.current(...args);
  };
  const call = (...args: A) => {
    pending.current = args;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, ms);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush pending work on unmount only
  useEffect(() => flush, []);
  return [call, flush, cancel];
}

/** Trigger a Jira sync and poll live progress until it settles. */
export function useJiraSync(onDone: () => void): {
  syncing: boolean;
  status: JiraStatus | null;
  start: (full?: boolean) => void;
  error: string | null;
} {
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** our own POST is still running: a status poll that says idle is stale */
  const inFlight = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const poll = useCallback(() => {
    planApi
      .jiraStatus()
      .then((st) => {
        setStatus(st);
        // The interval only feeds the progress bar. Completion is decided
        // here, but never while our POST is in flight — the first poll can
        // land before the server has marked the sync as started.
        if (!st.syncing && !inFlight.current && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
          setSyncing(false);
          doneRef.current();
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [poll]);

  const start = useCallback(
    (full = false) => {
      setSyncing(true);
      setError(null);
      inFlight.current = true;
      if (!timer.current) timer.current = setInterval(poll, 700);
      planApi
        .jiraSync(full)
        .catch((e: Error) => setError(e.message))
        .finally(() => {
          inFlight.current = false;
          poll(); // settles: stops the interval and fires onDone once idle
        });
    },
    [poll],
  );

  return { syncing: syncing || (status?.syncing ?? false), status, start, error };
}
