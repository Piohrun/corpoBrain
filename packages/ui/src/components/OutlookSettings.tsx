import { useCallback, useEffect, useState } from 'react';
import {
  type OutlookCalendarConfig,
  type OutlookConfig,
  type OutlookConfigPatch,
  type OutlookPreview,
  type OutlookReport,
  type OutlookStatus,
  outlookApi,
} from '../api.ts';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function describe(r: OutlookReport): string {
  if (r.profile === 'calendar') {
    const parts = [
      `${r.fetched} calendar items`,
      `${r.created.length} new notes`,
      `${r.updated.length} updated`,
      `${r.skipped.length} skipped`,
    ];
    if (r.gone.length) parts.push(`${r.gone.length} no longer in Outlook`);
    return parts.join(' · ');
  }
  return `${r.fetched} flagged emails · ${r.added.length} new tasks · ${r.ticked} ticked`;
}

function lastRunLines(status: OutlookStatus): string[] {
  const run = status.lastRun;
  if (!run || run.outcome === 'failed') return [];
  const when = (run.finishedAt ?? run.startedAt).slice(0, 16).replace('T', ' ');
  if (run.outcome !== 'success') return [`last sync ${run.outcome} · ${when}`];
  return [`last sync ${when}`, ...run.reports.map(describe)];
}

/** A text input that saves on blur when its value changed. */
function TextSetting({
  id,
  value,
  placeholder,
  onSave,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onSave: (value: string) => void;
}) {
  return (
    <input
      id={id}
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => {
        if (e.target.value.trim() !== value) onSave(e.target.value);
      }}
    />
  );
}

function NumberSetting({
  id,
  value,
  min,
  max,
  onSave,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onSave: (value: number) => void;
}) {
  return (
    <input
      id={id}
      key={value}
      type="number"
      min={min}
      max={max}
      defaultValue={value}
      onBlur={(e) => {
        const v = Number(e.target.value);
        if (e.target.value !== '' && v !== value) onSave(v);
      }}
    />
  );
}

/** Settings → Outlook: calendar → meeting notes, flagged email → tasks. */
export function OutlookSettings() {
  const [cfg, setCfg] = useState<OutlookConfig | null>(null);
  const [status, setStatus] = useState<OutlookStatus | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<OutlookPreview | 'loading' | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

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

  const save = (patch: OutlookConfigPatch) =>
    outlookApi
      .saveConfig(patch)
      .then((next) => {
        setCfg(next);
        setMsg(null);
        setPreview(null); // the rules changed: an old preview would mislead
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  const saveCal = (patch: Partial<OutlookCalendarConfig>) => void save({ calendar: patch });

  if (!cfg) return null;
  const cal = cfg.calendar;
  const run = status?.lastRun;
  const progress = status?.progress;
  const anyEnabled = cal.enabled || cfg.mail.enabled;
  const p = preview && preview !== 'loading' ? preview : null;
  const shownMeetings = p?.meetings.filter((m) => showSkipped || m.action !== 'skip') ?? [];
  const skippedCount = p?.meetings.filter((m) => m.action === 'skip').length ?? 0;

  return (
    <section>
      <h2 className="plan-h2">Outlook</h2>
      <div className="settings-card">
        <p className="muted small">
          Reads your local classic Outlook through Python (<code>comtypes</code>). Set up once with{' '}
          <code>scripts\setup-outlook.cmd</code> (uv). Nothing is ever sent to Outlook.
        </p>
        {!cfg.exporterFound && (
          <p className="plan-error">outlook_export.py is missing from this build.</p>
        )}
        <div className="settings-grid outlook-grid">
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
          <div>
            <TextSetting
              id="ol-python"
              value={cfg.python}
              placeholder="automatic"
              onSave={(python) => void save({ python })}
            />
            <div className="muted small">
              {cfg.pythonSource === 'venv'
                ? `using the corpoBrain .venv: ${cfg.pythonResolved}`
                : cfg.pythonSource === 'path'
                  ? 'no .venv found: using python from PATH (run setup-outlook.cmd)'
                  : `using ${cfg.pythonResolved}`}
            </div>
          </div>
        </div>
      </div>

      <div className="settings-card outlook-card">
        <h3 className="outlook-h3">
          <label className="outlook-check">
            <input
              type="checkbox"
              checked={cal.enabled}
              onChange={(e) => saveCal({ enabled: e.target.checked })}
            />
            Calendar → meeting notes
          </label>
        </h3>
        {cal.enabled && (
          <>
            <div className="settings-grid outlook-grid">
              <label htmlFor="ol-back">days back</label>
              <NumberSetting
                id="ol-back"
                value={cal.daysBack}
                min={0}
                max={365}
                onSave={(daysBack) => saveCal({ daysBack })}
              />
              <label htmlFor="ol-ahead">days ahead</label>
              <NumberSetting
                id="ol-ahead"
                value={cal.daysAhead}
                min={0}
                max={90}
                onSave={(daysAhead) => saveCal({ daysAhead })}
              />
              <label htmlFor="ol-folder">folder for new notes</label>
              <TextSetting
                id="ol-folder"
                value={cal.folder}
                onSave={(folder) => saveCal({ folder })}
              />
            </div>
            <p className="outlook-rule-head">Create a note when a meeting matches any of:</p>
            <div className="settings-grid outlook-grid">
              <label htmlFor="ol-people">people</label>
              <label className="outlook-check">
                <input
                  id="ol-people"
                  type="checkbox"
                  checked={cal.withPeople}
                  onChange={(e) => saveCal({ withPeople: e.target.checked })}
                />
                someone attending has a person note (matched by <code>email:</code>)
              </label>
              <label htmlFor="ol-only-cats">Outlook category</label>
              <TextSetting
                id="ol-only-cats"
                value={cal.onlyCategories.join(', ')}
                placeholder="e.g. corpoBrain"
                onSave={(v) => saveCal({ onlyCategories: list(v) })}
              />
              <label htmlFor="ol-only-subj">subject contains</label>
              <TextSetting
                id="ol-only-subj"
                value={cal.onlySubjects.join(', ')}
                placeholder="e.g. 1:1, interview, steering"
                onSave={(v) => saveCal({ onlySubjects: list(v) })}
              />
            </div>
            {!cal.withPeople && !cal.onlyCategories.length && !cal.onlySubjects.length && (
              <p className="muted small">
                No rule set: every meeting not excluded below gets a note.
              </p>
            )}
            <p className="outlook-rule-head">…but never for:</p>
            <div className="settings-grid outlook-grid">
              <label htmlFor="ol-max">more attendees than</label>
              <NumberSetting
                id="ol-max"
                value={cal.maxAttendees}
                min={0}
                max={10000}
                onSave={(maxAttendees) => saveCal({ maxAttendees })}
              />
              <label htmlFor="ol-recurring">recurring meetings</label>
              <select
                id="ol-recurring"
                value={cal.recurring ? 'yes' : 'no'}
                onChange={(e) => saveCal({ recurring: e.target.value === 'yes' })}
              >
                <option value="yes">allowed (1:1s, standups…)</option>
                <option value="no">skip every recurring series</option>
              </select>
              <label htmlFor="ol-appts">no attendees</label>
              <select
                id="ol-appts"
                value={cal.includeAppointments ? 'yes' : 'no'}
                onChange={(e) => saveCal({ includeAppointments: e.target.value === 'yes' })}
              >
                <option value="no">skip (focus time, reminders)</option>
                <option value="yes">allowed (still needs a category or subject rule)</option>
              </select>
              <label htmlFor="ol-skip-subj">subject contains</label>
              <TextSetting
                id="ol-skip-subj"
                value={cal.skipSubjects.join(', ')}
                placeholder="e.g. Lunch, Town hall"
                onSave={(v) => saveCal({ skipSubjects: list(v) })}
              />
              <label htmlFor="ol-skip-cats">Outlook category</label>
              <TextSetting
                id="ol-skip-cats"
                value={cal.skipCategories.join(', ')}
                placeholder="e.g. Personal"
                onSave={(v) => saveCal({ skipCategories: list(v) })}
              />
            </div>
            <p className="muted small">
              Window: {cfg.window.from} to {cfg.window.to} (exclusive). 0 attendees = no limit.
              Declined meetings never get a note. Existing notes keep updating even if the rules
              change, and are flagged — never deleted — when the meeting disappears.
            </p>
          </>
        )}
      </div>

      <div className="settings-card outlook-card">
        <h3 className="outlook-h3">
          <label className="outlook-check">
            <input
              type="checkbox"
              checked={cfg.mail.enabled}
              onChange={(e) => void save({ mail: { enabled: e.target.checked } })}
            />
            Flagged email → tasks
          </label>
        </h3>
        {cfg.mail.enabled && (
          <>
            <div className="settings-grid outlook-grid">
              <label htmlFor="ol-mail-back">days back</label>
              <NumberSetting
                id="ol-mail-back"
                value={cfg.mail.daysBack}
                min={1}
                max={365}
                onSave={(daysBack) => void save({ mail: { daysBack } })}
              />
              <label htmlFor="ol-mail-note">task note</label>
              <TextSetting
                id="ol-mail-note"
                value={cfg.mail.note}
                onSave={(note) => void save({ mail: { note } })}
              />
            </div>
            <p className="muted small">
              Flagged mail received since {cfg.mailSince} becomes a task in that note, with the
              sender linked and the flag's due date. Edit, move or delete tasks freely: completing
              or clearing the flag in Outlook ticks the task, and a deleted task never comes back.
            </p>
          </>
        )}
      </div>

      <div className="outlook-actions">
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
        </button>
        <button
          type="button"
          className="plan-btn"
          disabled={!anyEnabled || preview === 'loading'}
          title="Show what a sync would do, without writing anything"
          onClick={() => {
            setPreview('loading');
            setMsg(null);
            outlookApi
              .preview()
              .then(setPreview)
              .catch((e: Error) => {
                setPreview(null);
                setMsg({ ok: false, text: e.message });
              });
          }}
        >
          {preview === 'loading' ? 'Previewing…' : 'Preview'}
        </button>
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
            disabled={!anyEnabled}
            onClick={() =>
              outlookApi
                .start()
                .then(() => {
                  setPreview(null);
                  refreshStatus();
                })
                .catch((e: Error) => setMsg({ ok: false, text: e.message }))
            }
          >
            Sync now
          </button>
        )}
        {msg && <span className={`probe-result ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
      </div>

      {status?.syncing && progress && (
        <p className="muted small">
          {progress.phase === 'export'
            ? `reading Outlook… ${progress.current ? `${progress.current} items` : ''}`
            : progress.phase === 'notes'
              ? `writing meeting notes ${progress.current}/${progress.total}`
              : 'updating email tasks…'}
        </p>
      )}
      {status && !status.syncing && (
        <div className="muted small outlook-last">
          {lastRunLines(status).map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
      {!status?.syncing && run?.outcome === 'failed' && run.error && (
        <p className="plan-error">last sync failed: {run.error}</p>
      )}
      {!status?.syncing &&
        run?.reports
          .flatMap((r) => r.warnings)
          .map((w) => (
            <p key={w} className="plan-error small">
              {w}
            </p>
          ))}
      {status?.historyError && <p className="plan-error">{status.historyError}</p>}

      {p && (
        <div className="outlook-preview">
          {cal.enabled && (
            <>
              <h3 className="outlook-h3">
                Meetings: {p.meetings.filter((m) => m.action === 'create').length} new notes ·{' '}
                {p.meetings.filter((m) => m.action === 'update').length} existing · {skippedCount}{' '}
                skipped
                {skippedCount > 0 && (
                  <button
                    type="button"
                    className="props-toggle"
                    onClick={() => setShowSkipped((s) => !s)}
                  >
                    {showSkipped ? 'hide skipped' : 'show skipped'}
                  </button>
                )}
              </h3>
              <table className="issue-table">
                <thead>
                  <tr>
                    <th>day</th>
                    <th>time</th>
                    <th>subject</th>
                    <th>people</th>
                    <th>result</th>
                  </tr>
                </thead>
                <tbody>
                  {shownMeetings.map((m) => (
                    <tr key={m.id} className={m.action === 'skip' ? 'muted' : undefined}>
                      <td>{m.day}</td>
                      <td>{m.start}</td>
                      <td>{m.subject || '(no subject)'}</td>
                      <td>{m.attendeeCount}</td>
                      <td>
                        {m.action === 'create'
                          ? 'new note'
                          : m.action === 'update'
                            ? 'update note'
                            : `skip: ${m.reason}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {cfg.mail.enabled && (
            <>
              <h3 className="outlook-h3">
                Flagged email: {p.mails.filter((m) => m.action === 'add').length} new tasks ·{' '}
                {p.mails.filter((m) => m.action === 'tick').length} to tick
              </h3>
              <table className="issue-table">
                <thead>
                  <tr>
                    <th>received</th>
                    <th>subject</th>
                    <th>from</th>
                    <th>result</th>
                  </tr>
                </thead>
                <tbody>
                  {p.mails.map((m, i) => (
                    <tr
                      // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are static
                      key={i}
                      className={m.action === 'keep' ? 'muted' : undefined}
                    >
                      <td>{m.received}</td>
                      <td>{m.subject || '(no subject)'}</td>
                      <td>{m.from}</td>
                      <td>
                        {m.action === 'add'
                          ? 'new task'
                          : m.action === 'tick'
                            ? 'tick task'
                            : m.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </section>
  );
}
