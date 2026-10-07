import { useCallback, useEffect, useState } from 'react';
import { api, type HomeData, homeApi, type OutlookToday, outlookApi } from '../api.ts';
import { localISODate } from '../dates.ts';
import { useVaultEvents } from '../hooks.ts';
import { WikiText } from './WikiText.tsx';
import type { View } from './WorkspaceNav.tsx';

type Task = HomeData['tasks'][number];

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

const weekday = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

/** "all week", "Thu", "Thu–Fri" */
const span = (days: string[], week: string[]) =>
  days.length === week.length
    ? 'all week'
    : days.length === 1
      ? weekday(days[0] as string)
      : `${weekday(days[0] as string)}–${weekday(days[days.length - 1] as string)}`;

const KIND_ICON: Record<string, string> = {
  commitment: '✓',
  decision: '◆',
  risk: '▲',
  assumption: '≈',
};
const AWAY_LABEL = { ooo: 'out', holiday: 'holiday', support: 'support' } as const;

type OutlookState =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: OutlookToday };

/**
 * Today's meetings: meeting notes, plus today's Outlook meetings that have no
 * note yet, each one click from one. Outlook is read in the background (a
 * few seconds) and at most every 10 minutes; ↻ reads it now.
 */
function MeetingsCard({
  day,
  notes,
  onOpenNote,
  onView,
  onCreated,
}: {
  day: string;
  notes: HomeData['meetings'];
  onOpenNote: (path: string) => void;
  onView: (view: View) => void;
  /** a meeting note was written: reload the notes list */
  onCreated: () => void;
}) {
  const [outlook, setOutlook] = useState<OutlookState>({ kind: 'loading' });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((refresh = false) => {
    if (refresh) setOutlook({ kind: 'loading' });
    outlookApi
      .today(refresh)
      .then((data) => setOutlook({ kind: 'ready', data }))
      .catch((e: Error) =>
        setOutlook(
          /calendar sync is off/i.test(e.message)
            ? { kind: 'off' }
            : { kind: 'error', message: e.message },
        ),
      );
  }, []);
  useEffect(() => load(), [load]);
  // replanned from the server's cached read: a new note shows up as a note
  useVaultEvents(() => load());

  const create = (id: string) => {
    setBusy((b) => new Set(b).add(id));
    setError(null);
    outlookApi
      .createMeetings([id])
      .then(() => {
        onCreated();
        load();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() =>
        setBusy((b) => {
          const next = new Set(b);
          next.delete(id);
          return next;
        }),
      );
  };

  const noteRows = notes.map((m) => ({
    key: m.path,
    allDay: m.allDay,
    start: m.start ?? '',
    node: (
      <li key={m.path} data-path={m.path} className={m.cancelled ? 'cancelled' : ''}>
        <span className="home-time">
          {m.allDay ? 'all day' : `${time(m.start)}${m.end ? `–${time(m.end)}` : ''}`}
        </span>
        <button type="button" className="text-link" onClick={() => onOpenNote(m.path)}>
          {/* meeting notes are named "<day> <subject>"; the day is this page's */}
          {m.title.startsWith(`${day} `) ? m.title.slice(day.length + 1) : m.title}
        </button>
        {m.location && <span className="muted small">{m.location}</span>}
        {m.cancelled && <span className="muted small">cancelled</span>}
      </li>
    ),
  }));
  const unpicked = outlook.kind === 'ready' ? outlook.data.meetings.filter((m) => !m.path) : [];
  const outlookRows = unpicked.map((m) => ({
    key: m.id,
    allDay: m.allDay,
    start: m.start,
    node: (
      <li key={m.id} className={m.suggested ? 'home-unpicked' : 'home-unpicked muted'}>
        <span className="home-time">
          {m.allDay ? 'all day' : `${time(m.start)}–${time(m.end)}`}
        </span>
        <span
          className="home-subject"
          title={
            m.suggested ? 'Suggested by your Outlook rules' : `Skipped by the rules: ${m.reason}`
          }
        >
          {m.subject || '(no subject)'}
        </span>
        {m.location && <span className="muted small">{m.location}</span>}
        <button
          type="button"
          className={m.suggested ? 'risk-chip home-pick' : 'props-toggle home-pick'}
          disabled={busy.has(m.id)}
          title="Create the meeting note; syncs keep it up to date from then on"
          onClick={() => create(m.id)}
        >
          {busy.has(m.id) ? 'creating…' : '+ note'}
        </button>
      </li>
    ),
  }));
  const rows = [...noteRows, ...outlookRows].sort(
    (a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start),
  );
  const fetched =
    outlook.kind === 'ready'
      ? new Date(outlook.data.fetchedAt).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        })
      : null;

  return (
    <section className="home-card">
      <h2 className="plan-h2">
        Meetings <span className="health-badge">{rows.length}</span>
        <span className="spacer" />
        {outlook.kind === 'loading' && <span className="muted small">reading Outlook…</span>}
        {outlook.kind !== 'off' && outlook.kind !== 'loading' && (
          <button
            type="button"
            className="text-link small"
            onClick={() => load(true)}
            title={fetched ? `Outlook read at ${fetched}; read it again` : 'Read Outlook again'}
          >
            ↻ Outlook
          </button>
        )}
      </h2>
      {error && <p className="plan-error wrap small">{error}</p>}
      {outlook.kind === 'error' && (
        <p className="muted small">
          Outlook could not be read ({outlook.message}).{' '}
          <button type="button" className="text-link" onClick={() => onView('outlook')}>
            Tools → Outlook
          </button>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="muted small">
          {outlook.kind === 'loading'
            ? 'No meeting notes for today yet.'
            : outlook.kind === 'off'
              ? 'No meeting notes for today. Turn on calendar sync in Tools → Outlook to pick meetings here.'
              : 'Nothing in the calendar today.'}
        </p>
      ) : (
        <ul className="home-list">{rows.map((r) => r.node)}</ul>
      )}
    </section>
  );
}

/**
 * Home: the day at a glance. It never creates notes by itself; "Today"
 * (sidebar, Ctrl+D) is what opens or creates the daily note.
 */
export function HomePage({
  onOpenNote,
  onView,
  onDaily,
  recent,
}: {
  onOpenNote: (path: string) => void;
  onView: (view: View) => void;
  onDaily: () => void;
  recent: { path: string; title: string }[];
}) {
  const [day, setDay] = useState(localISODate);
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ticked here, waiting for the write and the refreshed list
  const [ticking, setTicking] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    const today = localISODate();
    setDay(today);
    homeApi
      .get(today)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);
  // past midnight the page is about a new day
  useEffect(() => {
    const timer = setInterval(() => {
      if (localISODate() !== day) refresh();
    }, 60_000);
    return () => clearInterval(timer);
  }, [day, refresh]);

  const toggle = (t: Task) => {
    const key = `${t.path}:${t.line}`;
    setTicking((cur) => new Set(cur).add(key));
    api
      .toggleTask(t.path, t.line)
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        refresh();
        setTicking((cur) => {
          const next = new Set(cur);
          next.delete(key);
          return next;
        });
      });
  };

  const heading = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const overdue = data?.tasks.filter((t) => t.due < day) ?? [];
  const dueToday = data?.tasks.filter((t) => t.due === day) ?? [];
  const soon = data?.tasks.filter((t) => t.due > day) ?? [];

  const taskList = (tasks: Task[], showDue: boolean) => (
    <div className="home-tasks">
      {tasks.map((t) => (
        <div key={`${t.path}:${t.line}`} className="task-row" data-path={t.path}>
          <input
            type="checkbox"
            aria-label={`done: ${t.text}`}
            checked={ticking.has(`${t.path}:${t.line}`)}
            disabled={ticking.has(`${t.path}:${t.line}`)}
            onChange={() => toggle(t)}
          />
          <WikiText text={t.text} onOpen={onOpenNote} />
          {showDue && <span className="due-chip">{t.due}</span>}
          <button
            type="button"
            className="text-link home-source"
            onClick={() => onOpenNote(t.path)}
          >
            {t.title}
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Home</span>
        <span className="muted small">{heading}</span>
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        <button
          type="button"
          className="plan-btn ghost"
          onClick={onDaily}
          title="Open today's daily note, creating it if needed (Ctrl+D)"
        >
          Today's note
        </button>
      </div>
      {!data ? (
        <div className="planning-scroll muted">loading…</div>
      ) : (
        <div className="planning-scroll home-grid">
          <div className="home-main">
            <MeetingsCard
              day={day}
              notes={data.meetings}
              onOpenNote={onOpenNote}
              onView={onView}
              onCreated={refresh}
            />

            <section className="home-card">
              <h2 className="plan-h2">
                Tasks
                <span className="spacer" />
                <button type="button" className="text-link small" onClick={() => onView('tasks')}>
                  all tasks
                </button>
              </h2>
              {data.tasks.length === 0 && (
                <p className="muted small">Nothing due in the next 7 days.</p>
              )}
              {overdue.length > 0 && (
                <>
                  <h3 className="home-h3 overdue">
                    Overdue <span className="health-badge">{data.overdueCount}</span>
                  </h3>
                  {taskList(overdue, true)}
                </>
              )}
              {dueToday.length > 0 && (
                <>
                  <h3 className="home-h3">
                    Today <span className="health-badge">{dueToday.length}</span>
                  </h3>
                  {taskList(dueToday, false)}
                </>
              )}
              {soon.length > 0 && (
                <>
                  <h3 className="home-h3">
                    Next 7 days <span className="health-badge">{soon.length}</span>
                  </h3>
                  {taskList(soon, true)}
                </>
              )}
            </section>
          </div>

          <div className="home-side">
            {data.sprint && (
              <section className="home-card">
                <h2 className="plan-h2">Sprint</h2>
                <p>
                  <button type="button" className="text-link" onClick={() => onView('planning')}>
                    {data.sprint.name}
                  </button>
                  {data.sprint.daysLeft !== null && (
                    <span className="muted">
                      {' '}
                      ·{' '}
                      {data.sprint.daysLeft > 0
                        ? `${data.sprint.daysLeft} day${data.sprint.daysLeft === 1 ? '' : 's'} left`
                        : data.sprint.daysLeft === 0
                          ? 'ends today'
                          : 'ended'}
                    </span>
                  )}
                </p>
              </section>
            )}

            <section className="home-card">
              <h2 className="plan-h2">
                Tracked <span className="health-badge">{data.tracked.length}</span>
              </h2>
              {data.tracked.length === 0 ? (
                <p className="muted small">Nothing due or up for review.</p>
              ) : (
                <ul className="home-list">
                  {data.tracked.map((t) => (
                    <li key={t.path} data-path={t.path}>
                      <span className="home-kind" title={t.kind}>
                        {KIND_ICON[t.kind] ?? '•'}
                      </span>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => onOpenNote(t.path)}
                      >
                        {t.title}
                      </button>
                      <span
                        className={`muted small${(t.due ?? t.review ?? '') < day ? ' overdue' : ''}`}
                      >
                        {t.due ? `due ${t.due}` : `review ${t.review}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="home-card">
              <h2 className="plan-h2">Away this week</h2>
              {data.away.length === 0 ? (
                <p className="muted small">Everyone is in.</p>
              ) : (
                <ul className="home-list">
                  {data.away.map((a) => (
                    <li key={`${a.path}|${a.kind}`} data-path={a.path}>
                      <i className={`avail-chip ${a.kind}`}>{AWAY_LABEL[a.kind]}</i>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => onOpenNote(a.path)}
                      >
                        {a.name}
                      </button>
                      <span className="muted small" title={a.note}>
                        {span(a.days, data.week)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {recent.length > 0 && (
              <section className="home-card">
                <h2 className="plan-h2">Recent notes</h2>
                <ul className="home-list">
                  {recent.slice(0, 8).map((n) => (
                    <li key={n.path} data-path={n.path}>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => onOpenNote(n.path)}
                      >
                        {n.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
