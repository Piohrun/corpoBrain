/**
 * Flow metrics over the mirrored changelog: status timelines, cycle and lead
 * time percentiles, aging work in progress, and sprint scope churn.
 *
 * Team- and issue-level by default. A per-person breakdown exists behind an
 * explicit query flag, so the page cannot be mistaken for monitoring people.
 */
import {
  civilDay,
  endExclusive,
  type FlowTimes,
  flowTimes,
  percentile,
  type StatusBand,
  type StatusCategory,
  sprintChurn,
  sprintStart,
  statusBands,
  type Transition,
  type TransitionField,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { type BoardModel, buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

interface IssueFlow {
  key: string;
  path: string;
  summary: string | null;
  issueType: string | null;
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  assigneeName: string | null;
  sprint: string;
  created: string | null;
  bands: (StatusBand & { category: StatusCategory | null })[];
  times: FlowTimes;
}

interface Percentiles {
  n: number;
  p50: number | null;
  p85: number | null;
  max: number | null;
}

const pct = (values: number[]): Percentiles => ({
  n: values.length,
  p50: percentile(values, 50),
  p85: percentile(values, 85),
  max: values.length ? Math.max(...values) : null,
});

/** status name → category, from what the mirror has seen, with a name fallback. */
function categoryLookup(v: VaultService): (status: string) => StatusCategory | null {
  const rows = v.indexer.db
    .prepare(
      'SELECT DISTINCT status, status_category FROM jira WHERE status IS NOT NULL AND status_category IS NOT NULL',
    )
    .all() as { status: string; status_category: string }[];
  const map = new Map(
    rows.map((r) => [r.status.toLowerCase(), r.status_category as StatusCategory]),
  );
  return (status) => {
    const known = map.get(status.toLowerCase());
    if (known) return known;
    if (/^(done|closed|resolved|released|cancelled|canceled|won'?t do)$/i.test(status))
      return 'done';
    if (/^(to do|open|backlog|new|selected for development|ready)$/i.test(status)) return 'new';
    return 'indeterminate';
  };
}

function transitionsByKey(v: VaultService, keys?: string[]): Map<string, Transition[]> {
  const rows = (
    keys
      ? v.indexer.db
          .prepare(
            `SELECT key, at, author, field, from_value, to_value FROM transitions WHERE key IN (${keys.map(() => '?').join(',')}) ORDER BY at`,
          )
          .all(...keys)
      : v.indexer.db
          .prepare(
            'SELECT key, at, author, field, from_value, to_value FROM transitions ORDER BY at',
          )
          .all()
  ) as {
    key: string;
    at: string;
    author: string | null;
    field: TransitionField;
    from_value: string | null;
    to_value: string | null;
  }[];
  const map = new Map<string, Transition[]>();
  for (const r of rows) {
    const list = map.get(r.key) ?? [];
    list.push({ at: r.at, author: r.author, field: r.field, from: r.from_value, to: r.to_value });
    map.set(r.key, list);
  }
  return map;
}

function issueFlows(v: VaultService, board: BoardModel, now: Date): IssueFlow[] {
  const created = new Map(
    (
      v.indexer.db.prepare('SELECT key, created FROM jira').all() as {
        key: string;
        created: string | null;
      }[]
    ).map((r) => [r.key, r.created]),
  );
  const byKey = transitionsByKey(v);
  const categoryOf = categoryLookup(v);
  const nameOf = (id: string | null) =>
    id ? (board.people.find((p) => p.jiraIds.includes(id))?.name ?? id) : null;
  return board.issues.map((i) => {
    const c = created.get(i.key) ?? now.toISOString();
    const bands = statusBands(c, byKey.get(i.key) ?? [], i.status);
    return {
      key: i.key,
      path: i.path,
      summary: i.summary,
      issueType: i.issueType,
      status: i.status,
      statusCategory: i.statusCategory,
      assignee: i.effectiveAssignee,
      assigneeName: nameOf(i.effectiveAssignee),
      sprint: i.effectiveSprint,
      created: created.get(i.key) ?? null,
      bands: bands.map((b) => ({ ...b, category: categoryOf(b.status) })),
      times: flowTimes(bands, categoryOf, now),
    };
  });
}

export function flowRoutes(v: VaultService): Hono {
  const app = new Hono();

  /** One issue: its status timeline and derived times. */
  app.get('/issue', (c) => {
    const key = c.req.query('key');
    if (!key) throw new HttpError(400, 'key required');
    const board = buildBoard(v);
    const flow = issueFlows(v, board, new Date()).find((f) => f.key === key);
    if (!flow) throw new HttpError(404, `unknown issue ${key}`);
    return c.json({ ...flow, transitions: transitionsByKey(v, [key]).get(key) ?? [] });
  });

  /**
   * The sprint view: aging open work against the team's historical
   * percentiles, what got done and how long it took, and scope churn.
   */
  app.get('/sprint', (c) => {
    const now = new Date();
    const board = buildBoard(v);
    const name =
      c.req.query('name') ??
      board.sprints.find((s) => s.state === 'active')?.name ??
      board.sprints[0]?.name;
    if (!name) throw new HttpError(404, 'no sprints on the board');
    const sprint = board.sprints.find((s) => s.name === name);
    if (!sprint) throw new HttpError(404, `unknown sprint ${name}`);
    const windowDays = Math.min(Math.max(Number(c.req.query('days')) || 90, 7), 365);
    const byPerson = c.req.query('byPerson') === '1';
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

    const flows = issueFlows(v, board, now);
    const inSprint = flows.filter((f) => f.sprint === name);
    const open = inSprint
      .filter((f) => f.statusCategory !== 'done')
      .sort((a, b) => (b.times.ageDays ?? -1) - (a.times.ageDays ?? -1));
    const done = inSprint
      .filter((f) => f.statusCategory === 'done')
      .sort((a, b) => (b.times.cycleDays ?? 0) - (a.times.cycleDays ?? 0));

    // reference lines: everything the team finished in the window, board-wide
    const recent = flows.filter(
      (f) => f.times.doneAt !== null && (f.times.doneAt as string) >= since,
    );
    const cycles = recent.map((f) => f.times.cycleDays).filter((x): x is number => x !== null);
    const leads = recent.map((f) => f.times.leadDays).filter((x): x is number => x !== null);
    // where the time goes: statuses on the way to done; time *in* a done
    // status is just the age of the record and would dominate the chart
    const categoryOf = categoryLookup(v);
    const perStatus: Record<string, { days: number; n: number }> = {};
    for (const f of recent) {
      for (const [status, days] of Object.entries(f.times.perStatus)) {
        if (categoryOf(status) === 'done') continue;
        const cur = perStatus[status] ?? { days: 0, n: 0 };
        cur.days += days;
        cur.n++;
        perStatus[status] = cur;
      }
    }
    const timeInStatus = Object.entries(perStatus)
      .map(([status, { days, n }]) => ({ status, avgDays: Math.round((days / n) * 100) / 100, n }))
      .sort((a, b) => b.avgDays - a.avgDays);

    const start = sprint.start ? sprintStart(sprint.start).toISOString() : null;
    const end = sprint.end ? endExclusive(sprint.end).toISOString() : null;
    const churn =
      start && end
        ? sprintChurn({ name, start, end }, transitionsByKey(v))
        : { added: [], removed: [], reestimated: [] };

    const people = byPerson
      ? [...new Set(recent.map((f) => f.assignee).filter((a): a is string => a !== null))]
          .map((id) => {
            const mine = recent.filter((f) => f.assignee === id);
            return {
              assignee: id,
              name: mine[0]?.assigneeName ?? id,
              done: mine.length,
              cycle: pct(mine.map((f) => f.times.cycleDays).filter((x): x is number => x !== null)),
            };
          })
          .sort((a, b) => b.done - a.done)
      : null;

    return c.json({
      sprint: {
        name,
        state: sprint.state,
        start: sprint.start ? civilDay(sprint.start) : null,
        end: sprint.end ? civilDay(sprint.end) : null,
      },
      windowDays,
      reference: { cycle: pct(cycles), lead: pct(leads), timeInStatus },
      open,
      done,
      churn,
      people,
    });
  });

  /** Cycle/lead percentiles by issue type over a window, board-wide. */
  app.get('/stats', (c) => {
    const now = new Date();
    const windowDays = Math.min(Math.max(Number(c.req.query('days')) || 90, 7), 365);
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const flows = issueFlows(v, buildBoard(v), now).filter(
      (f) => f.times.doneAt !== null && (f.times.doneAt as string) >= since,
    );
    const groups = new Map<string, IssueFlow[]>();
    for (const f of flows) {
      const k = f.issueType ?? 'unknown';
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    const byType = [...groups.entries()]
      .map(([issueType, list]) => ({
        issueType,
        cycle: pct(list.map((f) => f.times.cycleDays).filter((x): x is number => x !== null)),
        lead: pct(list.map((f) => f.times.leadDays).filter((x): x is number => x !== null)),
      }))
      .sort((a, b) => b.cycle.n - a.cycle.n);
    return c.json({
      windowDays,
      all: {
        cycle: pct(flows.map((f) => f.times.cycleDays).filter((x): x is number => x !== null)),
        lead: pct(flows.map((f) => f.times.leadDays).filter((x): x is number => x !== null)),
      },
      byType,
    });
  });

  return app;
}
