/** Projects: rollups, the day-grid calendar, roster and auto-arrange. */
import {
  arrangeCalendar,
  type CalendarInput,
  convertEffort,
  dayIndexOf,
  type EffortUnit,
  endExclusive,
  layoutCalendar,
  type ProjectDef,
  type ProjectIssue,
  type ProjectRollup,
  parseAvailability,
  personCell,
  projectOf,
  rollupProject,
  setFrontmatterKey,
  weekdaysIn,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { applyPlanPatch, type BoardIssue, type BoardModel, buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

/** an issue with no estimate still needs a width on the calendar */
const UNESTIMATED_DAYS = 2;
const MAX_DAYS = 120;
const PAD_DAYS = 10;

export interface ProjectSummary extends ProjectRollup {
  forecastDate: string | null;
  lateDeps: number;
  conflicts: number;
}

export interface CalendarBlockOut {
  key: string;
  assignee: string;
  start: number;
  span: number;
  workDays: number;
  pinned: boolean;
  estimated: boolean;
  awayDays: number;
  conflict: boolean;
  clamped: boolean;
  lateDeps: string[];
  summary: string | null;
  path: string;
  status: string | null;
  statusCategory: string | null;
  priority: string | null;
  blockedBy: string[];
}

export interface CalendarModel {
  project: ProjectRollup & { people: ProjectRollup['people'] };
  unit: string;
  days: string[];
  today: number | null;
  months: { label: string; from: number; span: number }[];
  sprints: { name: string; from: number; span: number; state: string }[];
  rows: {
    /** row key: the person's Jira id, or person:<path> when they have none */
    assignee: string;
    /** null when the person note has no Jira id — blocks cannot be dropped here yet */
    jiraId: string | null;
    name: string;
    path: string | null;
    color: string | null;
    inRoster: boolean;
    ooo: number[];
    support: number[];
  }[];
  blocks: CalendarBlockOut[];
  rail: { key: string; summary: string | null; path: string; days: number; estimated: boolean }[];
  finishDate: string | null;
  target: string | null;
  cycles: string[][];
  warnings: string[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function projectDefs(v: VaultService): ProjectDef[] {
  const folder = v.config.folders.projects;
  const rows = v.indexer.db
    .prepare(
      "SELECT path, title, frontmatter_json FROM notes WHERE (type = 'project' OR path LIKE ?) AND protected = 0 ORDER BY title",
    )
    .all(`${folder}/%`) as { path: string; title: string; frontmatter_json: string }[];
  const defs: ProjectDef[] = [];
  for (const r of rows) {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
    } catch {
      /* unparsable frontmatter: rules stay empty */
    }
    if (fm.type !== undefined && fm.type !== 'project' && !r.path.startsWith(`${folder}/`))
      continue;
    defs.push({
      path: r.path,
      title: r.title,
      status: str(fm.status),
      color: str(fm.color),
      start: str(fm.start),
      target: str(fm.target),
      epics: list(fm.epics),
      labels: list(fm.labels),
      keys: list(fm.keys),
      people: list(fm.people).map((p) => personCell(p)),
    });
  }
  return defs;
}

const asProjectIssue = (i: BoardIssue): ProjectIssue => i;

export function issuesByProject(
  board: BoardModel,
  defs: ProjectDef[],
): Map<string, ProjectIssue[]> {
  const map = new Map<string, ProjectIssue[]>();
  for (const d of defs) map.set(d.path, []);
  for (const i of board.issues) {
    const p = projectOf(asProjectIssue(i), defs);
    if (p) map.get(p)?.push(asProjectIssue(i));
  }
  return map;
}

const dayList = (from: Date, to: Date): string[] => weekdaysIn(from, to);

/** The day axis: from the earliest dated sprint to PAD_DAYS past the latest. */
function buildAxis(board: BoardModel): { days: string[]; sprintFrom: Record<string, number> } {
  const dated = board.sprints.filter((s) => s.start && s.end);
  let from: Date;
  let to: Date;
  if (dated.length) {
    from = new Date(
      dated.reduce((m, s) => (s.start && s.start < m ? s.start : m), dated[0]?.start as string),
    );
    const lastEnd = dated.reduce(
      (m, s) => ((s.end as string) > m ? (s.end as string) : m),
      dated[0]?.end as string,
    );
    to = endExclusive(lastEnd);
  } else {
    from = new Date();
    to = new Date(from.getTime());
    to.setUTCDate(to.getUTCDate() + 45);
  }
  const padded = new Date(to.getTime());
  padded.setUTCDate(padded.getUTCDate() + Math.ceil(PAD_DAYS * 1.4));
  const days = dayList(from, padded).slice(0, MAX_DAYS);
  const sprintFrom: Record<string, number> = {};
  for (const s of board.sprints) {
    if (!s.start) continue;
    const idx = dayIndexOf(days, s.start.slice(0, 10));
    if (idx >= 0 && idx < days.length) sprintFrom[s.name] = idx;
  }
  return { days, sprintFrom };
}

/** Away day indexes per assignee id, split by kind for the UI. */
function awayByAssignee(
  v: VaultService,
  board: BoardModel,
  days: string[],
): {
  ooo: Record<string, number[]>;
  support: Record<string, number[]>;
  merged: Record<string, number[]>;
} {
  const ooo: Record<string, number[]> = {};
  const support: Record<string, number[]> = {};
  const merged: Record<string, number[]> = {};
  let entries: ReturnType<typeof parseAvailability>['entries'] = [];
  try {
    entries = parseAvailability(v.read(v.config.availability.file).content).entries;
  } catch {
    return { ooo, support, merged };
  }
  const daySet = new Map(days.map((d, i) => [d, i]));
  const norm = (x: string) => x.trim().toLowerCase();
  const basename = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/i, '');
  for (const e of entries) {
    const n = norm(e.person);
    const person = board.people.find(
      (p) =>
        norm(p.name) === n ||
        norm(p.path) === n ||
        norm(basename(p.path)) === n ||
        p.jiraIds.some((id) => norm(id) === n),
    );
    if (!person) continue;
    const rowKeys = person.jiraIds.length ? person.jiraIds : [`person:${person.path}`];
    const to = new Date(`${e.to}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    for (const d of dayList(new Date(`${e.from}T00:00:00Z`), to)) {
      const idx = daySet.get(d);
      if (idx === undefined) continue;
      for (const id of rowKeys) {
        if (!merged[id]) merged[id] = [];
        merged[id]?.push(idx);
        const bucket = e.kind === 'support' ? support : ooo;
        if (!bucket[id]) bucket[id] = [];
        bucket[id]?.push(idx);
      }
    }
  }
  return { ooo, support, merged };
}

function calendarInput(
  v: VaultService,
  board: BoardModel,
  issues: ProjectIssue[],
): { input: CalendarInput; away: ReturnType<typeof awayByAssignee> } {
  const cap = v.config.capacity;
  const unit = cap.unit as EffortUnit;
  const { days, sprintFrom } = buildAxis(board);
  const away = awayByAssignee(v, board, days);
  return {
    input: {
      days,
      issues,
      sprintFrom,
      away: away.merged,
      toDays: (e) => convertEffort(e, unit, 'days', cap) ?? e,
      unestimatedDays: UNESTIMATED_DAYS,
      notBefore: Math.max(dayIndexOf(days, new Date().toISOString().slice(0, 10)), 0),
    },
    away,
  };
}

export function projectRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const board = buildBoard(v);
    const defs = projectDefs(v);
    const grouped = issuesByProject(board, defs);
    const projects: ProjectSummary[] = defs.map((d) => {
      const issues = grouped.get(d.path) ?? [];
      const { input } = calendarInput(v, board, issues);
      const layout = layoutCalendar(input);
      const arranged = arrangeCalendar(input);
      return {
        ...rollupProject(d, issues),
        forecastDate: arranged.finishDate,
        lateDeps: layout.blocks.filter((b) => b.lateDeps.length).length,
        conflicts: layout.blocks.filter((b) => b.conflict).length,
      };
    });
    const tagged = new Set([...grouped.values()].flat().map((i) => i.key));
    return c.json({
      projects,
      untagged: board.issues.filter((i) => !tagged.has(i.key) && i.statusCategory !== 'done')
        .length,
      unit: board.unit,
    });
  });

  /** The day-grid calendar for one project. */
  app.get('/timeline', (c) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'path query parameter is required');
    const defs = projectDefs(v);
    const def = defs.find((d) => d.path === path);
    if (!def) throw new HttpError(404, `unknown project: ${path}`);
    const board = buildBoard(v);
    const issues = issuesByProject(board, defs).get(def.path) ?? [];
    const byKey = new Map(board.issues.map((i) => [i.key, i]));
    const { input, away } = calendarInput(v, board, issues);
    const layout = layoutCalendar(input);
    const arranged = arrangeCalendar(input);

    // ---- header spans -------------------------------------------------------
    const months: CalendarModel['months'] = [];
    for (let i = 0; i < input.days.length; i++) {
      const label = new Date(`${input.days[i]}T00:00:00Z`).toLocaleDateString('en-GB', {
        month: 'short',
        year: '2-digit',
      });
      const last = months[months.length - 1];
      if (last && last.label === label) last.span++;
      else months.push({ label, from: i, span: 1 });
    }
    const sprints: CalendarModel['sprints'] = [];
    for (const s of board.sprints) {
      if (!s.start || !s.end) continue;
      const from = dayIndexOf(input.days, s.start.slice(0, 10));
      const endIdx = dayIndexOf(input.days, endExclusive(s.end).toISOString().slice(0, 10));
      if (from >= input.days.length || endIdx <= 0) continue;
      const f = Math.max(from, 0);
      sprints.push({
        name: s.name,
        from: f,
        span: Math.min(endIdx, input.days.length) - f,
        state: s.state,
      });
    }
    const todayIdx = dayIndexOf(input.days, new Date().toISOString().slice(0, 10));
    const today = todayIdx >= 0 && todayIdx < input.days.length ? todayIdx : null;

    // ---- rows: roster first, then anyone with a block, unassigned last ------
    const roster = def.people
      .map((raw) => {
        const n = raw.trim().toLowerCase();
        return board.people.find((p) => p.name.toLowerCase() === n || p.path.toLowerCase() === n);
      })
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    const rows: CalendarModel['rows'] = [];
    const seen = new Set<string>();
    const addRow = (assignee: string, inRoster: boolean) => {
      if (seen.has(assignee)) return;
      seen.add(assignee);
      const p = assignee.startsWith('person:')
        ? board.people.find((x) => x.path === assignee.slice('person:'.length))
        : board.people.find((x) => x.jiraIds.includes(assignee));
      rows.push({
        assignee,
        jiraId: assignee.startsWith('person:')
          ? null
          : assignee === '(unassigned)'
            ? null
            : assignee,
        name: p?.name ?? (assignee === '(unassigned)' ? 'Unassigned' : assignee),
        path: p?.path ?? null,
        color: p?.color ?? null,
        inRoster,
        ooo: away.ooo[assignee] ?? [],
        support: away.support[assignee] ?? [],
      });
    };
    // a roster person without a Jira id still deserves a row
    for (const p of roster) addRow(p.jiraIds[0] ?? `person:${p.path}`, true);
    for (const b of layout.blocks) if (b.assignee !== '(unassigned)') addRow(b.assignee, false);
    addRow('(unassigned)', false);

    const decorate = (b: (typeof layout.blocks)[number]): CalendarBlockOut => {
      const i = byKey.get(b.key);
      return {
        ...b,
        summary: i?.summary ?? null,
        path: i?.path ?? '',
        status: i?.status ?? null,
        statusCategory: i?.statusCategory ?? null,
        priority: i?.priority ?? null,
        blockedBy: [...new Set([...(i?.dependsOn ?? []), ...(i?.blockedBy ?? [])])],
      };
    };

    const warnings: string[] = [];
    const conflicted = layout.blocks.filter((b) => b.conflict).map((b) => b.key);
    if (conflicted.length)
      warnings.push(`overlapping blocks: ${[...new Set(conflicted)].join(', ')}`);
    for (const b of layout.blocks) {
      for (const d of b.lateDeps) warnings.push(`${b.key} starts before its blocker ${d} finishes`);
    }
    for (const c2 of arranged.cycles) warnings.push(`dependency cycle: ${c2.join(' → ')}`);

    const model: CalendarModel = {
      project: rollupProject(def, issues),
      unit: board.unit,
      days: input.days,
      today,
      months,
      sprints,
      rows,
      blocks: layout.blocks.map(decorate),
      rail: issues
        .filter((i) => layout.unplaced.includes(i.key))
        .map((i) => ({
          key: i.key,
          summary: i.summary,
          path: i.path,
          days:
            i.effectiveEffort === null
              ? UNESTIMATED_DAYS
              : Math.max(1, Math.ceil(input.toDays(i.effectiveEffort))),
          estimated: i.effectiveEffort !== null,
        })),
      finishDate: arranged.finishDate,
      target: def.target,
      cycles: arranged.cycles,
      warnings,
    };
    return c.json(model);
  });

  /** Auto-arrange: pin every scheduled issue to the computed start day. */
  app.post('/arrange', async (c) => {
    const body = (await c.req.json()) as { path?: string };
    if (!body.path) throw new HttpError(400, 'path is required');
    const defs = projectDefs(v);
    const def = defs.find((d) => d.path === body.path);
    if (!def) throw new HttpError(404, `unknown project: ${body.path}`);
    const board = buildBoard(v);
    const issues = issuesByProject(board, defs).get(def.path) ?? [];
    const { input } = calendarInput(v, board, issues);
    const arranged = arrangeCalendar(input);
    const sprintOf = (date: string): string | null => {
      const idx = dayIndexOf(input.days, date);
      let best: { name: string; from: number } | null = null;
      for (const [name, from] of Object.entries(input.sprintFrom)) {
        if (from <= idx && (!best || from > best.from)) best = { name, from };
      }
      return best?.name ?? null;
    };
    let pinned = 0;
    for (const [key, date] of arranged.starts) {
      const issue = issues.find((i) => i.key === key);
      const patch: Record<string, unknown> = { start: date };
      const sprint = sprintOf(date);
      if (sprint && issue && sprint !== issue.effectiveSprint) patch.sprint = sprint;
      applyPlanPatch(v, key, patch);
      pinned++;
    }
    return c.json({ ok: true, pinned, finishDate: arranged.finishDate, cycles: arranged.cycles });
  });

  /** Replace the project's people roster (person note paths). */
  app.put('/roster', async (c) => {
    const body = (await c.req.json()) as { path?: string; people?: unknown };
    if (!body.path) throw new HttpError(400, 'path is required');
    if (!Array.isArray(body.people)) throw new HttpError(400, 'people must be an array');
    const defs = projectDefs(v);
    if (!defs.some((d) => d.path === body.path))
      throw new HttpError(404, `unknown project: ${body.path}`);
    const board = buildBoard(v);
    const people: string[] = [];
    for (const raw of body.people) {
      if (typeof raw !== 'string') throw new HttpError(400, 'people must be strings');
      const n = raw.trim().toLowerCase();
      const person = board.people.find(
        (p) => p.path.toLowerCase() === n || p.name.toLowerCase() === n,
      );
      if (!person) throw new HttpError(400, `"${raw}" does not match a person note`);
      if (!people.includes(person.name)) people.push(person.name);
    }
    const { content } = v.read(body.path);
    v.write(body.path, setFrontmatterKey(content, 'people', people));
    return c.json({ ok: true, people });
  });

  /** Create a project note. */
  app.post('/', async (c) => {
    const body = (await c.req.json()) as { title?: string };
    const title = body.title?.trim();
    if (!title) throw new HttpError(400, 'title is required');
    const slug =
      title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '') || 'project';
    const rel = `${v.config.folders.projects}/${slug}.md`;
    const { path } = v.create(
      rel,
      title,
      `---\ntype: project\ntitle: ${JSON.stringify(title)}\nstatus: active\nepics: []\nlabels: []\npeople: []\n---\n\n## Goal\n\n## Notes\n`,
      'project',
    );
    return c.json({ ok: true, path });
  });

  return app;
}
