import type { JiraStatus } from './api.ts';

/** Poll on mount and while idle too, so navigation and scheduled runs reconnect. */
export function watchJiraSync(
  load: () => Promise<JiraStatus>,
  onStatus: (status: JiraStatus) => void,
  onSettled: () => void,
  onError: (error: unknown) => void,
): { refresh: () => void; stop: () => void } {
  let stopped = false;
  let loading = false;
  let queued = false;
  let initialized = false;
  let finishedId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (stopped) return;
    clearTimeout(timer);
    if (loading) {
      queued = true;
      return;
    }
    loading = true;
    let interval = 2000;
    try {
      const status = await load();
      if (stopped) return;
      onStatus(status);
      const completed =
        status.lastRun && status.lastRun.outcome !== 'running' ? status.lastRun.id : undefined;
      if (initialized && completed && completed !== finishedId) onSettled();
      if (completed) finishedId = completed;
      initialized = true;
      interval = status.syncing ? 700 : 5000;
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      loading = false;
      if (!stopped) {
        timer = setTimeout(
          () => {
            void refresh();
          },
          queued ? 0 : interval,
        );
        queued = false;
      }
    }
  };
  void refresh();
  return {
    refresh: () => {
      void refresh();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
