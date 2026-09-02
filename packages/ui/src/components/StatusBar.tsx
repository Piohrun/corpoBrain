import { useEffect, useRef, useState } from 'react';
import { api, type GitStatus, gitApi, type JiraStatus, planApi } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { useVaultEvents } from '../hooks.ts';

const POLL_MS = 60_000;

const clock = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * One quiet line at the bottom: vault, save state, Jira sync state, git state.
 * It also raises the toasts for background events (sync finished / failed),
 * because it is the one component that always sees them.
 */
export function StatusBar({
  saveState,
  notePath,
  onOpenJira,
  onOpenSettings,
  onHelp,
}: {
  saveState: 'saved' | 'saving' | 'error';
  notePath: string | null;
  onOpenJira: () => void;
  onOpenSettings: () => void;
  onHelp: () => void;
}) {
  const dlg = useDialogs();
  const [vault, setVault] = useState<string | null>(null);
  const [jira, setJira] = useState<JiraStatus | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const lastSeen = useRef<{ synced: string | null; error: string | null } | null>(null);

  useEffect(() => {
    api
      .health()
      .then((h) => setVault(h.vault))
      .catch(() => {});
  }, []);

  const refresh = () => {
    planApi
      .jiraStatus()
      .then((st) => {
        setJira(st);
        const seen = lastSeen.current;
        if (seen) {
          if (st.lastSynced && st.lastSynced !== seen.synced && st.lastReports) {
            const created = st.lastReports.reduce((n, r) => n + r.created.length, 0);
            const updated = st.lastReports.reduce((n, r) => n + r.updated.length, 0);
            const changes = st.lastReports.reduce((n, r) => n + (r.changes ?? 0), 0);
            dlg.toast({
              kind: 'success',
              message: `Jira synced · ${created} new, ${updated} updated${changes ? `, ${changes} changes in the digest` : ''}`,
            });
          }
          if (st.lastSyncError && st.lastSyncError !== seen.error)
            dlg.toast({ kind: 'error', message: `Jira sync failed: ${st.lastSyncError}` });
        }
        lastSeen.current = { synced: st.lastSynced, error: st.lastSyncError };
      })
      .catch(() => {});
    gitApi
      .status()
      .then(setGit)
      .catch(() => {});
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    refreshRef.current();
    const t = setInterval(() => refreshRef.current(), POLL_MS);
    return () => clearInterval(t);
  }, []);
  useVaultEvents((paths) => {
    if (paths.some((p) => p.startsWith('jira/'))) refreshRef.current();
  });

  const vaultName = vault ? (vault.split(/[\\/]/).pop() ?? vault) : '';
  const jiraText = !jira
    ? ''
    : !jira.configured
      ? 'Jira not connected'
      : jira.syncing
        ? `Jira syncing${jira.progress ? ` · ${jira.progress.phase} ${jira.progress.current}${jira.progress.total ? `/${jira.progress.total}` : ''}` : '…'}`
        : jira.lastSyncError
          ? 'Jira sync failed'
          : `Jira synced ${clock(jira.lastSynced)}`;
  const gitText = !git
    ? ''
    : !git.available
      ? 'git unavailable'
      : !git.isRepo
        ? 'git off'
        : git.dirtyFiles > 0
          ? `git · ${git.dirtyFiles} changed`
          : `git · clean${git.head ? ` (${git.head.hash})` : ''}`;

  return (
    <div className="status-bar">
      <span className="status-item" title={vault ?? ''}>
        {vaultName}
        {notePath ? <span className="muted"> · {notePath}</span> : null}
      </span>
      <span className="spacer" />
      <span className={`status-item save-${saveState}`}>
        {saveState === 'saved' ? '✓ saved' : saveState === 'saving' ? 'saving…' : '⚠ save failed'}
      </span>
      {jiraText && (
        <button
          type="button"
          className={`status-item link${jira?.lastSyncError ? ' bad' : ''}`}
          onClick={onOpenJira}
          title={jira?.lastSyncError ?? 'Jira settings and sync'}
        >
          {jiraText}
        </button>
      )}
      {gitText && (
        <button
          type="button"
          className={`status-item link${git?.lastError ? ' bad' : ''}`}
          onClick={onOpenSettings}
          title={git?.lastError ?? 'Vault history (git)'}
        >
          {gitText}
        </button>
      )}
      <button
        type="button"
        className="status-item link"
        onClick={onHelp}
        title="Keyboard shortcuts"
      >
        ? keys
      </button>
    </div>
  );
}
