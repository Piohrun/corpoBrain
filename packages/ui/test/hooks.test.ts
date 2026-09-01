import { describe, expect, it, vi } from 'vitest';

/**
 * Exercise the debounce logic without React: the hook's body is a thin
 * wrapper, so we re-implement the ref plumbing with plain objects. If the
 * hook changes shape, this test should change with it.
 */
function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const flush = () => {
    const args = pending;
    cancel();
    if (args) fn(...args);
  };
  const call = (...args: A) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  };
  return [call, flush, cancel] as const;
}

describe('debounced save semantics', () => {
  it('cancel drops a pending call; flush after cancel is a no-op', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const [call, flush, cancel] = debounced(fn, 100);
    call('a');
    cancel();
    flush();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('flush runs the latest pending call once', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const [call, flush] = debounced(fn, 100);
    call('a');
    call('b');
    flush();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
    vi.useRealTimers();
  });
});
