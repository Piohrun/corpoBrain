import { useCallback, useEffect, useState } from 'react';
import {
  type JiraConfig,
  type PreviewRow,
  type StagedChange,
  type WriteApplyReport,
  writebackApi,
} from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { useVaultEvents } from '../hooks.ts';

export function WritebackSection({
  config,
  onChanged,
}: {
  config: JiraConfig;
  onChanged: () => void;
}) {
  const dlg = useDialogs();
  const [staged, setStaged] = useState<StagedChange[]>([]);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [report, setReport] = useState<WriteApplyReport | null>(null);
  const [journal, setJournal] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    writebackApi
      .staged()
      .then(setStaged)
      .catch(() => {});
    writebackApi
      .journal()
      .then(setJournal)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  // plan edits elsewhere (planning grid, calendar) change what is staged
  useVaultEvents(refresh);

  const mode = config.writeback;
  const modeLabel =
    mode === 'on'
      ? 'ARMED — writes go to Jira'
      : mode === 'dry-run'
        ? 'dry-run (simulated)'
        : 'off';

  const doPreview = () => {
    setBusy(true);
    setError(null);
    setReport(null);
    writebackApi
      .preview()
      .then(setPreview)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const doApply = async () => {
    if (!preview) return;
    const items = preview
      .filter((r) => !r.conflict)
      .map((r) => ({ key: r.key, field: r.field, to: r.to }));
    if (!items.length) return;
    if (
      mode === 'on' &&
      !(await dlg.confirm(`Send ${items.length} change(s) to Jira? This modifies real tickets.`))
    )
      return;
    setBusy(true);
    setError(null);
    writebackApi
      .apply(items)
      .then((r) => {
        setReport(r);
        setPreview(null);
        refresh();
        onChanged();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  /** preview + apply a single staged change, with the same safety rails */
  const pushOne = (staged: StagedChange) => {
    const id = `${staged.key}:${staged.field}`;
    setBusy(true);
    setError(null);
    setRowStatus((m) => ({ ...m, [id]: 'checking…' }));
    writebackApi
      .preview([staged.key])
      .then(async (rows) => {
        const row = rows.find((r) => r.key === staged.key && r.field === staged.field);
        if (!row) throw new Error('no longer staged — refresh');
        if (row.conflict) {
          setRowStatus((m) => ({
            ...m,
            [id]: `conflict: ${row.conflictReason ?? 'changed in Jira'}`,
          }));
          return null;
        }
        if (
          mode === 'on' &&
          !(await dlg.confirm(`Push ${staged.key} ${staged.field} → "${staged.to}" to Jira?`))
        ) {
          setRowStatus((m) => ({ ...m, [id]: '' }));
          return null;
        }
        return writebackApi.apply([{ key: staged.key, field: staged.field, to: staged.to }]);
      })
      .then((r) => {
        if (!r) return;
        const res = r.results[0];
        setRowStatus((m) => ({
          ...m,
          [id]: res ? `${res.status}${res.detail ? ` — ${res.detail}` : ''}` : 'done',
        }));
        refresh();
        onChanged();
      })
      .catch((e: Error) => setRowStatus((m) => ({ ...m, [id]: `error: ${e.message}` })))
      .finally(() => setBusy(false));
  };

  const lastRealBatch = journal.find((e) => e.ok === true && e.dryRun === false);

  const doUndo = () => {
    if (!lastRealBatch) return;
    const batchId = lastRealBatch.batchId as string;
    writebackApi
      .undo(batchId)
      .then(async ({ items }) => {
        if (!items.length) return;
        if (
          !(await dlg.confirm(
            `Revert batch ${batchId}: re-apply ${items.length} previous value(s) to Jira?`,
          ))
        )
          return;
        setBusy(true);
        return writebackApi
          .apply(items)
          .then((r) => {
            setReport(r);
            refresh();
            onChanged();
          })
          .finally(() => setBusy(false));
      })
      .catch((e: Error) => setError(e.message));
  };

  const writable = staged.filter((s) => s.writable);
  const unwritable = staged.filter((s) => !s.writable);

  return (
    <section>
      <h2 className="plan-h2">
        Write-back to Jira <span className={`wb-mode wb-${mode}`}>{modeLabel}</span>
      </h2>
      {staged.length === 0 ? (
        <p className="muted small">No uncommitted plan changes to push.</p>
      ) : (
        <div className="changes-panel">
          {writable.map((s) => {
            const id = `${s.key}:${s.field}`;
            const status = rowStatus[id];
            return (
              <div key={id} className="change-row">
                <span className="key-link">{s.key}</span>
                <span className="change-diffs">
                  <span className="change-diff">
                    {s.field}: <span className="load-committed">{s.from ?? '—'}</span> →{' '}
                    <b className="load-planned">{s.to}</b>
                  </span>
                  {status && (
                    <span
                      className={`muted small${status.startsWith('conflict') || status.startsWith('error') ? ' plan-error' : ''}`}
                    >
                      {status}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="risk-chip"
                  disabled={busy || mode === 'off'}
                  title={
                    mode === 'off'
                      ? 'Enable dry-run in Connection settings first'
                      : mode === 'dry-run'
                        ? 'Simulate pushing just this change'
                        : 'Push just this change to Jira (with live conflict check)'
                  }
                  onClick={() => pushOne(s)}
                >
                  {mode === 'dry-run' ? '→ dry-run' : '→ Jira'}
                </button>
              </div>
            );
          })}
          {unwritable.map((s) => (
            <div key={`${s.key}:${s.field}`} className="change-row muted">
              <span className="key-link">{s.key}</span>
              <span className="change-diffs">
                <span className="change-diff">
                  {s.field} → {s.to} — not writable: {s.reason}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="risk-chip"
          disabled={busy || mode === 'off' || writable.length === 0}
          title={
            mode === 'off'
              ? 'Enable dry-run in Connection settings first'
              : 'Fetch live Jira values and check for conflicts'
          }
          onClick={doPreview}
        >
          Preview against live Jira
        </button>
        {preview && (
          <button type="button" className="plan-btn" disabled={busy} onClick={doApply}>
            {mode === 'dry-run' ? 'Dry-run apply' : 'Apply to Jira'} (
            {preview.filter((r) => !r.conflict).length})
          </button>
        )}
        {lastRealBatch && (
          <button type="button" className="risk-chip clear" disabled={busy} onClick={doUndo}>
            Undo last batch
          </button>
        )}
        {error && <span className="plan-error">{error}</span>}
      </div>

      {preview && (
        <div className="grid-wrap" style={{ marginTop: 8 }}>
          <table className="issue-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Field</th>
                <th>Jira now</th>
                <th>Will become</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={`${r.key}:${r.field}`} className={r.conflict ? 'wb-conflict' : ''}>
                  <td className="key-link">{r.key}</td>
                  <td>{r.field}</td>
                  <td className="muted">
                    {r.field === 'assignee' ? (r.liveAssignee ?? '—') : (r.from ?? '—')}
                  </td>
                  <td>
                    <b className="load-planned">{r.to}</b>
                  </td>
                  <td>
                    {r.conflict ? (
                      <span className="flag">CONFLICT — {r.conflictReason}</span>
                    ) : (
                      <span className="muted small">ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && (
        <div className="settings-card" style={{ marginTop: 8 }}>
          <p className="muted small">
            batch {report.batchId} {report.dryRun ? '(dry-run)' : ''}
            {report.stopped ? ' — STOPPED on error' : ''}
          </p>
          {report.results.map((r) => (
            <div key={`${r.key}:${r.field}`} className="muted small">
              {r.key} {r.field} → {r.to ?? 'unassigned'}: <b>{r.status}</b>
              {r.detail ? ` — ${r.detail}` : ''}
            </div>
          ))}
        </div>
      )}

      <p className="muted small">
        <button type="button" className="key-link" onClick={() => setShowJournal((v) => !v)}>
          {showJournal ? 'hide' : 'show'} journal ({journal.length})
        </button>{' '}
        — every action is logged to <code>.corpobrain/jira-writeback.log</code> in the vault.
      </p>
      {showJournal &&
        journal.slice(0, 20).map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: journal rows are append-only positional log lines
          <div key={`${e.batchId}-${i}`} className="muted small">
            {String(e.ts).slice(0, 19)} [{String(e.batchId)}] {String(e.key)} {String(e.field)}:{' '}
            {String(e.before ?? '—')} → {String(e.to)}{' '}
            {e.dryRun ? '(dry-run)' : e.ok ? '✓' : `✗ ${String(e.error ?? e.conflict ?? '')}`}
          </div>
        ))}
    </section>
  );
}
