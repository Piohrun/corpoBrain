import { useCallback, useEffect, useState } from 'react';
import { api, type HomeData, homeApi } from '../api.ts';
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

/**
 * Home: the day at a glance. Read-only — it never creates notes; "Today"
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
            <section className="home-card">
              <h2 className="plan-h2">
                Meetings <span className="health-badge">{data.meetings.length}</span>
              </h2>
              {data.meetings.length === 0 ? (
                <p className="muted small">
                  No meeting notes for today.{' '}
                  <button type="button" className="text-link" onClick={() => onView('outlook')}>
                    Outlook → Preview
                  </button>{' '}
                  picks meetings to make notes for.
                </p>
              ) : (
                <ul className="home-list">
                  {data.meetings.map((m) => (
                    <li key={m.path} data-path={m.path} className={m.cancelled ? 'cancelled' : ''}>
                      <span className="home-time">
                        {m.allDay ? 'all day' : `${time(m.start)}${m.end ? `–${time(m.end)}` : ''}`}
                      </span>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => onOpenNote(m.path)}
                      >
                        {/* meeting notes are named "<day> <subject>"; the day is this page's */}
                        {m.title.startsWith(`${day} `) ? m.title.slice(day.length + 1) : m.title}
                      </button>
                      {m.location && <span className="muted small">{m.location}</span>}
                      {m.cancelled && <span className="muted small">cancelled</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

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
