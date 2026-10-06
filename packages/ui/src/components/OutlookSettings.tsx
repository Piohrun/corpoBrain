import { useCallback, useEffect, useState } from 'react';
import { type OutlookConfig, type OutlookStatus, outlookApi } from '../api.ts';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function summary(status: OutlookStatus): string | null {
  const run = status.lastRun;
  if (!run) return null;
  const when = (run.finishedAt ?? run.startedAt).slice(0, 16).replace('T', ' ');
  if (run.outcome === 'failed') return null;
  if (run.outcome !== 'success') return `last sync ${run.outcome} · ${when}`;
  const r = run.reports[0];
  if (!r) return `last sync ${when}`;
  const parts = [
    `${r.fetched} calendar items`,
    `${r.created.length} new`,
    `${r.updated.length} updated`,
    `${r.unchanged} unchanged`,
  ];
  if (r.gone.length) parts.push(`${r.gone.length} no longer in Outlook`);
  return `last sync ${when} · ${parts.join(' · ')}`;
}

/** Settings → Outlook calendar: the local-Outlook meeting sync. */
export function OutlookSettings() {
  const [cfg, setCfg] = useState<OutlookConfig | null>(null);
  const [status, setStatus] = useState<OutlookStatus | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    outlookApi
      .config()
      .then(setCfg)
      .catch(() => {});
  }, []);
  const refreshStatus = useCallback(() => {
    outlookApi
      .status()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(refreshStatus, [refreshStatus]);
  // Poll only while a job runs; the job belongs to the server, not this page.
  useEffect(() => {
    if (!status?.syncing) return;
    const timer = setInterval(refreshStatus, 1000);
    return () => clearInterval(timer);
  }, [status?.syncing, refreshStatus]);

  const save = (patch: Partial<OutlookConfig>) =>
    outlookApi
      .saveConfig(patch)
      .then((next) => {
        setCfg(next);
        setMsg(null);
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));

  // Back to the saved value after a rejected edit: the old error no longer applies.
  const saveIfChanged = (changed: boolean, patch: Partial<OutlookConfig>) => {
    if (changed) void save(patch);
    else setMsg((m) => (m?.ok ? m : null));
  };

  if (!cfg) return null;
  const run = status?.lastRun;
  const progress = status?.progress;
  return (
    <section>
      <h2 className="plan-h2">Outlook calendar</h2>
      <div className="settings-card">
        <p className="muted small">
          Meeting notes from your local classic Outlook, read through Python (<code>comtypes</code>
          ). Each occurrence gets a note in <code>{cfg.folder}/</code>; your notes go below the
          marker line and are never overwritten. Attendees link to people by their{' '}
          <code>email:</code>.
        </p>
        {!cfg.exporterFound && (
          <p className="plan-error">outlook_export.py is missing from this build.</p>
        )}
        <div className="settings-grid">
          <label htmlFor="ol-enabled">sync automatically</label>
          <select
            id="ol-enabled"
            value={cfg.enabled ? String(cfg.intervalMinutes) : 'off'}
            onChange={(e) =>
              void save(
                e.target.value === 'off'
                  ? { enabled: false }
                  : { enabled: true, intervalMinutes: Number(e.target.value) },
              )
            }
          >
            <option value="off">off (Sync now only)</option>
            <option value="15">every 15 minutes</option>
            <option value="30">every 30 minutes</option>
            <option value="60">every hour</option>
          </select>
          <label htmlFor="ol-python">Python</label>
          <input
            id="ol-python"
            key={`py-${cfg.python}`}
            defaultValue={cfg.python}
            placeholder="python, py or a full path to python.exe"
            onBlur={(e) =>
              saveIfChanged(e.target.value.trim() !== cfg.python, { python: e.target.value })
            }
          />
          <label htmlFor="ol-folder">folder for new notes</label>
          <input
            id="ol-folder"
            key={`folder-${cfg.folder}`}
            defaultValue={cfg.folder}
            onBlur={(e) =>
              saveIfChanged(e.target.value.trim() !== cfg.folder, { folder: e.target.value })
            }
          />
          <label htmlFor="ol-back">days back</label>
          <input
            id="ol-back"
            key={`back-${cfg.daysBack}`}
            type="number"
            min="0"
            max="90"
            defaultValue={cfg.daysBack}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v !== cfg.daysBack) void save({ daysBack: v });
            }}
          />
          <label htmlFor="ol-ahead">days ahead</label>
          <input
            id="ol-ahead"
            key={`ahead-${cfg.daysAhead}`}
            type="number"
            min="0"
            max="90"
            defaultValue={cfg.daysAhead}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (v !== cfg.daysAhead) void save({ daysAhead: v });
            }}
          />
          <label htmlFor="ol-appts">appointments without attendees</label>
          <select
            id="ol-appts"
            value={cfg.includeAppointments ? 'yes' : 'no'}
            onChange={(e) => void save({ includeAppointments: e.target.value === 'yes' })}
          >
            <option value="no">skip (focus time, reminders)</option>
            <option value="yes">create notes too</option>
          </select>
          <label htmlFor="ol-subjects">skip subjects containing</label>
          <input
            id="ol-subjects"
            key={`subj-${cfg.skipSubjects.join(',')}`}
            defaultValue={cfg.skipSubjects.join(', ')}
            placeholder="e.g. Lunch, Commute"
            onBlur={(e) => void save({ skipSubjects: list(e.target.value) })}
          />
          <label htmlFor="ol-cats">skip categories</label>
          <input
            id="ol-cats"
            key={`cats-${cfg.skipCategories.join(',')}`}
            defaultValue={cfg.skipCategories.join(', ')}
            placeholder="e.g. Personal"
            onBlur={(e) => void save({ skipCategories: list(e.target.value) })}
          />
        </div>
        <p className="muted small">
          Current window: {cfg.window.from} to {cfg.window.to} (exclusive). Declined meetings are
          skipped; a note for a meeting that disappears is flagged, never deleted.
        </p>
        <div>
          <button
            type="button"
            className="plan-btn"
            onClick={() => {
              setMsg({ ok: true, text: 'asking Outlook…' });
              outlookApi
                .test()
                .then((r) =>
                  setMsg({
                    ok: true,
                    text: `connected to Outlook ${r.outlookVersion ?? '?'} as ${r.me ?? 'unknown'} · ${r.today} item(s) today`,
                  }),
                )
                .catch((e: Error) => setMsg({ ok: false, text: e.message }));
            }}
          >
            Test connection
          </button>{' '}
          {status?.syncing && status.runId ? (
            <button
              type="button"
              className="plan-btn"
              disabled={status.cancelling}
              onClick={() =>
                status.runId &&
                outlookApi
                  .cancel(status.runId)
                  .then(refreshStatus)
                  .catch(() => {})
              }
            >
              {status.cancelling ? 'Cancelling…' : 'Cancel sync'}
            </button>
          ) : (
            <button
              type="button"
              className="plan-btn"
              onClick={() =>
                outlookApi
                  .start()
                  .then(refreshStatus)
                  .catch((e: Error) => setMsg({ ok: false, text: e.message }))
              }
            >
              Sync now
            </button>
          )}
          {msg && <span className={`probe-result ${msg.ok ? 'ok' : 'err'}`}> {msg.text}</span>}
        </div>
        {status?.syncing && progress && (
          <p className="muted small">
            {progress.phase === 'export'
              ? `reading Outlook… ${progress.current ? `${progress.current} items` : ''}`
              : `writing notes ${progress.current}/${progress.total}`}
          </p>
        )}
        {status && !status.syncing && summary(status) && (
          <p className="muted small">{summary(status)}</p>
        )}
        {!status?.syncing && run?.outcome === 'failed' && run.error && (
          <p className="plan-error">last sync failed: {run.error}</p>
        )}
        {!status?.syncing &&
          run?.reports[0]?.warnings.map((w) => (
            <p key={w} className="plan-error small">
              {w}
            </p>
          ))}
        {status?.historyError && <p className="plan-error">{status.historyError}</p>}
      </div>
    </section>
  );
}
