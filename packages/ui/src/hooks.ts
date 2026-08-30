import { useEffect, useRef } from 'react';

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

export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): [(...args: A) => void, () => void] {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<A | null>(null);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      const args = pending.current;
      pending.current = null;
      fnRef.current(...args);
    }
  };
  const call = (...args: A) => {
    pending.current = args;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, ms);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush pending work on unmount only
  useEffect(() => flush, []);
  return [call, flush];
}
