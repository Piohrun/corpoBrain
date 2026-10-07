import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type OutlookCalendarConfig,
  type OutlookConfig,
  type OutlookConfigPatch,
  type OutlookPreview,
  type OutlookReport,
  type OutlookStatus,
  outlookApi,
  type PythonEnvStatus,
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

/** errors that a fresh .venv with comtypes fixes */
const PYTHON_TROUBLE = /comtypes|No module named|python.*(not found|ENOENT)|ENOENT.*python/i;

/**
 * The .venv next to the app with comtypes in it: shows whether it is ready and
 * builds it in one click (uv with the system certificates when available,
 * otherwise python -m venv + pip). The setup runs on the server; this polls.
 */
function PythonEnv({ onFinished }: { onFinished: () => void }) {
  const [env, setEnv] = useState<PythonEnvStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    outlookApi
      .python()
      .then(setEnv)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (!env?.running) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [env?.running, refresh]);
  const finished = env && !env.running && env.ok !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when a run finishes
  useEffect(() => {
    if (finished) onFinished();
  }, [finished]);

  if (error) return <div className="plan-error small wrap">{error}</div>;
  if (!env) return null;
  return (
    <div className="python-env">
      <div className="python-env-row">
        <span className={env.ready ? 'python-env-ok' : 'muted'}>
          {env.running
            ? 'setting up…'
            : env.ready
              ? `✓ .venv ready with comtypes${env.configured ? ' (not used: a Python path is set above)' : ''}`
              : '.venv with comtypes not set up yet'}
        </span>
        {!env.running && (
          <button
            type="button"
            className={env.ready ? 'plan-btn ghost' : 'plan-btn'}
            title={`Creates ${env.venv} and installs comtypes into it`}
            onClick={() =>
              outlookApi
                .setupPython()
                .then(setEnv)
                .catch((e: Error) => setError(e.message))
            }
          >
            {env.ready ? 'Reinstall' : 'Set up Python for Outlook'}
          </button>
        )}
      </div>
      {(env.running || env.ok === false) && env.log.length > 0 && (
        <pre
          className="python-env-log"
          ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight; // the outcome is at the end
          }}
        >
          {env.log.join('\n')}
        </pre>
      )}
    </div>
  );
}

type PreviewMeeting = OutlookPreview['meetings'][number];

/** What the preview says about one meeting, in words. */
function meetingResult(m: PreviewMeeting, pickMode: boolean): string {
  if (m.action === 'update') return 'has a note';
  if (m.action === 'create') return pickMode ? 'suggested' : 'note on next sync';
  if (m.suggested) return 'suggested';
  return `skipped: ${m.reason}`;
}

/**
 * The preview's meetings, each one click from a note: suggested and skipped
 * meetings alike can be picked, existing notes open.
 */
function MeetingsPreview({
  meetings,
  pickMode,
  onOpenNote,
  onCreated,
}: {
  meetings: PreviewMeeting[];
  pickMode: boolean;
  onOpenNote: (path: string) => void;
  /** created/updated notes by meeting id */
  onCreated: (paths: Map<string, string>) => void;
}) {
  const [showSkipped, setShowSkipped] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const isSuggestion = (m: PreviewMeeting) =>
    m.action === 'create' || (m.action === 'skip' && m.suggested);
  const suggestions = meetings.filter(isSuggestion);
  const existing = meetings.filter((m) => m.action === 'update').length;
  const skipped = meetings.filter((m) => m.action === 'skip' && !m.suggested);
  const shown = meetings.filter((m) => showSkipped || m.action !== 'skip' || m.suggested);

  const create = (ids: string[]) => {
    setBusy((b) => new Set([...b, ...ids]));
    setError(null);
    outlookApi
      .createMeetings(ids)
      .then((report) => {
        // created notes come back in meeting order; updates are already known by path
        const paths = new Map<string, string>();
        const created = [...report.created];
        for (const m of meetings)
          if (ids.includes(m.id)) {
            const path = m.path ?? created.shift();
            if (path) paths.set(m.id, path);
          }
        onCreated(paths);
        if (report.warnings.length) setError(report.warnings.join(' · '));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy((b) => new Set([...b].filter((id) => !ids.includes(id)))));
  };

  return (
    <section>
      <h2 className="plan-h2 outlook-preview-head">
        Meetings
        <span className="muted small">
          {suggestions.length} suggested · {existing} with a note · {skipped.length} skipped
        </span>
        {skipped.length > 0 && (
          <button type="button" className="props-toggle" onClick={() => setShowSkipped((s) => !s)}>
            {showSkipped ? 'hide skipped' : 'show skipped'}
          </button>
        )}
        <span className="spacer" />
        {suggestions.length > 1 && (
          <button
            type="button"
            className="plan-btn"
            disabled={busy.size > 0}
            onClick={() => create(suggestions.map((m) => m.id))}
          >
            Create all {suggestions.length} suggested
          </button>
        )}
      </h2>
      {error && <p className="plan-error wrap small">{error}</p>}
      <p className="muted small">
        {pickMode
          ? 'New notes are only made for meetings you pick here; the rules decide what is suggested.'
          : 'Suggested meetings get a note on the next sync anyway; create one now, or pick a skipped meeting the rules left out.'}
      </p>
      <table className="issue-table outlook-meetings">
        <thead>
          <tr>
            <th>day</th>
            <th>time</th>
            <th>subject</th>
            <th>people</th>
            <th>status</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => (
            <tr
              key={m.id}
              className={m.action === 'skip' && !m.suggested ? 'muted' : undefined}
              data-path={m.path ?? undefined}
            >
              <td>{m.day}</td>
              <td>{m.start}</td>
              <td>
                {m.path ? (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => m.path && onOpenNote(m.path)}
                  >
                    {m.subject || '(no subject)'}
                  </button>
                ) : (
                  m.subject || '(no subject)'
                )}
              </td>
              <td>{m.attendeeCount}</td>
              <td className={isSuggestion(m) ? 'outlook-suggested' : undefined}>
                {meetingResult(m, pickMode)}
              </td>
              <td className="outlook-row-action">
                {m.path ? (
                  <button
                    type="button"
                    className="props-toggle"
                    onClick={() => m.path && onOpenNote(m.path)}
                  >
                    open
                  </button>
                ) : (
                  <button
                    type="button"
                    className={isSuggestion(m) ? 'risk-chip' : 'props-toggle'}
                    disabled={busy.has(m.id)}
                    title="Create the meeting note now; syncs keep it up to date from then on"
                    onClick={() => create([m.id])}
                  >
                    {busy.has(m.id) ? 'creating…' : '+ note'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Tools → Outlook: calendar → meeting notes, flagged email → tasks. */
export function OutlookPage({
  onOpenNote,
  onNotesChanged,
}: {
  onOpenNote: (path: string) => void;
  /** notes were written on the server: refresh the app's note lists */
  onNotesChanged: () => void;
}) {
  const [cfg, setCfg] = useState<OutlookConfig | null>(null);
  const [status, setStatus] = useState<OutlookStatus | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<OutlookPreview | 'loading' | null>(null);

  const refreshConfig = useCallback(() => {
    outlookApi
      .config()
      .then(setCfg)
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);
  useEffect(refreshConfig, [refreshConfig]);
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
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && status && !status.syncing) onNotesChanged();
    wasSyncing.current = status?.syncing ?? false;
  }, [status, onNotesChanged]);

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

  const runPreview = () => {
    setPreview('loading');
    setMsg(null);
    outlookApi
      .preview()
      .then(setPreview)
      .catch((e: Error) => {
        setPreview(null);
        setMsg({
          ok: false,
          text: PYTHON_TROUBLE.test(e.message)
            ? `${e.message} · try “Set up Python for Outlook” below`
            : e.message,
        });
      });
  };

  if (!cfg)
    return (
      <div className="planning">
        <div className="planning-header">
          <span className="title">Outlook</span>
          {msg && <span className="plan-error">{msg.text}</span>}
        </div>
      </div>
    );
  const cal = cfg.calendar;
  const pickMode = cal.newNotes === 'pick';
  const run = status?.lastRun;
  const progress = status?.progress;
  const anyEnabled = cal.enabled || cfg.mail.enabled;
  const p = preview && preview !== 'loading' ? preview : null;

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Outlook</span>
        <span className="muted small">
          classic Outlook on this machine · read only{p?.me ? ` · ${p.me}` : ''}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="risk-chip"
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
              .catch((e: Error) =>
                setMsg({
                  ok: false,
                  text: PYTHON_TROUBLE.test(e.message)
                    ? `${e.message} · try “Set up Python for Outlook” below`
                    : e.message,
                }),
              );
          }}
        >
          Test connection
        </button>
        <button
          type="button"
          className="plan-btn ghost"
          disabled={!anyEnabled || preview === 'loading'}
          title="Read Outlook and list what a sync would do; pick meetings to make notes for"
          onClick={runPreview}
        >
          {preview === 'loading' ? 'Previewing…' : 'Preview'}
        </button>
        {status?.syncing && status.runId ? (
          <button
            type="button"
            className="plan-btn ghost"
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
      </div>

      <div className="planning-scroll">
        {msg && <p className={`probe-result wrap ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
        {!cfg.exporterFound && (
          <p className="plan-error wrap">outlook_export.py is missing from this build.</p>
        )}
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
          <p className="plan-error wrap">last sync failed: {run.error}</p>
        )}
        {!status?.syncing &&
          run?.reports
            .flatMap((r) => r.warnings)
            .map((w) => (
              <p key={w} className="plan-error wrap small">
                {w}
              </p>
            ))}
        {status?.historyError && <p className="plan-error wrap">{status.historyError}</p>}

        {!p && cal.enabled && (
          <section>
            <h2 className="plan-h2">Meetings</h2>
            <p className="muted small">
              {preview === 'loading'
                ? 'reading Outlook…'
                : `Preview reads ${cfg.window.from} to ${cfg.window.to} and lists every meeting with what a sync would do; pick the ones you want notes for.`}
            </p>
          </section>
        )}
        {p && cal.enabled && (
          <MeetingsPreview
            meetings={p.meetings}
            pickMode={pickMode}
            onOpenNote={onOpenNote}
            onCreated={(paths) => {
              onNotesChanged();
              setPreview((cur) =>
                cur && cur !== 'loading'
                  ? {
                      ...cur,
                      meetings: cur.meetings.map((m) => {
                        const path = paths.get(m.id);
                        return path
                          ? { ...m, action: 'update', reason: null, suggested: false, path }
                          : m;
                      }),
                    }
                  : cur,
              );
            }}
          />
        )}
        {p && cfg.mail.enabled && (
          <section>
            <h2 className="plan-h2">
              Flagged email: {p.mails.filter((m) => m.action === 'add').length} new tasks ·{' '}
              {p.mails.filter((m) => m.action === 'tick').length} to tick
            </h2>
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
          </section>
        )}

        <section>
          <h2 className="plan-h2">Connection</h2>
          <div className="settings-card">
            <p className="muted small">
              Reads your local classic Outlook through Python (<code>comtypes</code>). Nothing is
              ever sent to Outlook.
            </p>
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
                      ? 'no .venv found: using python from PATH'
                      : `using ${cfg.pythonResolved}`}
                </div>
                <PythonEnv onFinished={refreshConfig} />
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="plan-h2">What to sync</h2>
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
                  <label htmlFor="ol-new">new notes</label>
                  <select
                    id="ol-new"
                    value={cal.newNotes}
                    onChange={(e) => saveCal({ newNotes: e.target.value as 'auto' | 'pick' })}
                  >
                    <option value="auto">created by a sync, for meetings matching the rules</option>
                    <option value="pick">only for meetings I pick in Preview</option>
                  </select>
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
                <p className="outlook-rule-head">
                  {pickMode ? 'Suggest' : 'Create'} a note when a meeting matches any of:
                </p>
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
                    No rule set: every meeting not excluded below is{' '}
                    {pickMode ? 'suggested' : 'given a note'}.
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
                  These rules apply to syncs; in Preview you can still pick any meeting. Existing
                  notes keep updating even if the rules change, and are flagged — never deleted —
                  when the meeting disappears.
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
                  sender linked and the flag's due date. Edit, move or delete tasks freely:
                  completing or clearing the flag in Outlook ticks the task, and a deleted task
                  never comes back.
                </p>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
