import { useCallback, useEffect, useRef, useState } from 'react';
import { type JiraStatus, planApi } from './api.ts';

/** Subscribe to server-sent vault change events. */
export function useVaultEvents(onPaths: (paths: string[]) => void): void {
  const cb = useRef(onPaths);
  cb.current = onPaths;
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as { paths?: string[] };
        if (data.paths?.length) cb.current(data.paths);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, []);
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
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const poll = useCallback(() => {
    planApi
      .jiraStatus()
      .then((st) => {
        setStatus(st);
        if (!st.syncing && timer.current) {
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
      if (!timer.current) timer.current = setInterval(poll, 700);
      planApi.jiraSync(full).catch((e: Error) => setError(e.message));
      poll();
    },
    [poll],
  );

  return { syncing: syncing || (status?.syncing ?? false), status, start, error };
}
