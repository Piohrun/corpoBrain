import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JiraStatus } from '../src/api.ts';
import { watchJiraSync } from '../src/jira-sync-poller.ts';

const status = (id: string | null, outcome = 'running') =>
  ({
    syncing: id !== null && outcome === 'running',
    runId: outcome === 'running' ? id : null,
    lastRun: id ? { id, outcome } : null,
  }) as JiraStatus;
afterEach(() => vi.useRealTimers());

describe('sync progress reconnection', () => {
  it('reconnects on mount, keeps polling an existing job, and refreshes once on completion', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(status('job'));
    const seen = vi.fn();
    const done = vi.fn();
    const watcher = watchJiraSync(load, seen, done, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveBeenCalledWith(status('job'));
    await vi.advanceTimersByTimeAsync(700);
    expect(load).toHaveBeenCalledTimes(2);
    load.mockResolvedValue(status('job', 'cancelled'));
    await vi.advanceTimersByTimeAsync(700);
    expect(done).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('discovers background jobs while idle and recovers after a failed status request', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(status(null));
    const errors = vi.fn();
    const seen = vi.fn();
    const watcher = watchJiraSync(load, seen, vi.fn(), errors);
    await vi.advanceTimersByTimeAsync(0);
    load.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status('scheduled'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(errors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveBeenLastCalledWith(status('scheduled'));
    watcher.stop();
  });

  it('serializes refreshes and ignores responses after unmount', async () => {
    vi.useFakeTimers();
    let resolve: (value: JiraStatus) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<JiraStatus>((r) => {
          resolve = r;
        }),
    );
    const seen = vi.fn();
    const watcher = watchJiraSync(load, seen, vi.fn(), vi.fn());
    watcher.refresh();
    watcher.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    resolve(status(null));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    watcher.stop();
    resolve(status('job'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
