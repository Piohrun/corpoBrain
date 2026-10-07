/**
 * Home: the day at a glance — today's meetings, tasks due, tracked items to
 * look at, who is away this week, the active sprint. Read-only, and small:
 * only what the page shows, never the whole task list.
 */
import { isCalendarDay, localDay, naturalCompare, normalizeCountry } from '@corpobrain/core';
import { Hono } from 'hono';
import { readAvailability, readHolidays, resolvePerson } from './availability.ts';
import { buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

/** tracked statuses that need no more attention (as on the Tracked page) */
const CLOSED = new Set([
  'done',
  'dropped',
  'superseded',
  'reversed',
  'mitigated',
  'accepted',
  'validated',
  'invalidated',
]);
const INITIAL_STATUS: Record<string, string> = {
  commitment: 'open',
  decision: 'active',
  risk: 'open',
  assumption: 'active',
};

/** tasks and tracked items due within this many days count as coming up */
const SOON_DAYS = 7;
const TASK_LIMIT = 100;

export interface HomeResponse {
  day: string;
  meetings: {
    path: string;
    title: string;
    start: string | null;
    end: string | null;
    allDay: boolean;
    location: string | null;
    cancelled: boolean;
  }[];
  tasks: { path: string; line: number; text: string; due: string; title: string; kind: string }[];
  overdueCount: number;
  tracked: {
    path: string;
    title: string;
    kind: string;
    status: string;
    due: string | null;
    review: string | null;
  }[];
  away: {
    path: string;
    name: string;
    kind: 'ooo' | 'holiday' | 'support';
    days: string[];
    note: string;
  }[];
  week: string[];
  sprint: { name: string; end: string | null; daysLeft: number | null } | null;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Monday to Friday of the week `day` is in. */
export function workWeek(day: string): string[] {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(day, dow === 0 ? -6 : 1 - dow);
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function homeModel(v: VaultService, day: string): HomeResponse {
  const db = v.indexer.db;

  const meetings = (
    db
      .prepare(
        `SELECT n.path, n.title, n.frontmatter_json FROM notes n
         JOIN properties p ON p.path = n.path AND p.key = 'date'
         WHERE n.type = 'meeting' AND n.protected = 0 AND p.value_json = ?`,
      )
      .all(JSON.stringify(day)) as { path: string; title: string; frontmatter_json: string }[]
  )
    .map((r) => {
      const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
      return {
        path: r.path,
        title: r.title,
        start: str(fm.start),
        end: str(fm.end),
        allDay: fm.all_day === true,
        location: str(fm.location),
        cancelled: fm.cancelled === true,
      };
    })
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        (a.start ?? '').localeCompare(b.start ?? '') ||
        naturalCompare(a.title, b.title),
    );

  const soon = addDays(day, SOON_DAYS);
  const tasks = db
    .prepare(
      `SELECT t.path, t.line, t.text, t.due, t.kind, n.title
       FROM tasks t JOIN notes n ON n.path = t.path
       WHERE t.done = 0 AND t.due IS NOT NULL AND t.due <= ? AND n.protected = 0
       ORDER BY t.due, t.path, t.line LIMIT ?`,
    )
    .all(soon, TASK_LIMIT) as HomeResponse['tasks'];
  const { n: overdueCount } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN notes n ON n.path = t.path
       WHERE t.done = 0 AND t.due IS NOT NULL AND t.due < ? AND n.protected = 0`,
    )
    .get(day) as { n: number };

  const tracked = (
    db
      .prepare(
        `SELECT path, title, type, frontmatter_json FROM notes
         WHERE type IN ('commitment', 'decision', 'risk', 'assumption') AND protected = 0`,
      )
      .all() as { path: string; title: string; type: string; frontmatter_json: string }[]
  )
    .map((r) => {
      const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
      return {
        path: r.path,
        title: r.title,
        kind: r.type,
        status: str(fm.status) ?? INITIAL_STATUS[r.type] ?? 'open',
        due: str(fm.due),
        review: str(fm.review),
      };
    })
    .filter((t) => !CLOSED.has(t.status))
    .filter((t) => (t.due !== null && t.due <= soon) || (t.review !== null && t.review <= day))
    .sort((a, b) => (a.due ?? a.review ?? '').localeCompare(b.due ?? b.review ?? ''));

  // who is away this week: the availability table plus bank holidays by country
  const week = workWeek(day);
  const board = buildBoard(v);
  const people = board.people.filter((p) => p.active);
  const away = new Map<string, HomeResponse['away'][number]>();
  const mark = (
    person: { path: string; name: string },
    kind: 'ooo' | 'holiday' | 'support',
    from: string,
    to: string,
    note: string,
  ) => {
    const days = week.filter((d) => d >= from && d <= to);
    if (!days.length) return;
    const key = `${person.path}|${kind}`;
    const row = away.get(key) ?? { path: person.path, name: person.name, kind, days: [], note };
    row.days = [...new Set([...row.days, ...days])].sort();
    away.set(key, row);
  };
  for (const e of readAvailability(v).entries) {
    const p = resolvePerson(e.person, people);
    if (p) mark(p, e.kind, e.from, e.to, e.note);
  }
  for (const h of readHolidays(v).entries) {
    const c = normalizeCountry(h.country);
    for (const p of people)
      if (p.country && normalizeCountry(p.country) === c) mark(p, 'holiday', h.from, h.to, h.name);
  }

  const active = board.sprints.find((s) => s.state === 'active') ?? null;
  const daysLeft =
    active?.end && isCalendarDay(active.end.slice(0, 10))
      ? Math.round(
          (Date.parse(`${active.end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
            86_400_000,
        )
      : null;

  return {
    day,
    meetings,
    tasks,
    overdueCount,
    tracked,
    away: [...away.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || naturalCompare(a.name, b.name),
    ),
    week,
    sprint: active ? { name: active.name, end: active.end, daysLeft } : null,
  };
}

export function homeRoutes(v: VaultService): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    // the browser's day: it is the user's, even if the server's clock zone differs
    const day = c.req.query('day') ?? localDay();
    if (!isCalendarDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD');
    return c.json(homeModel(v, day));
  });
  return app;
}
