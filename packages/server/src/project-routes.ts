/** Projects: rollups, the day-grid calendar, roster and auto-arrange. */
import {
  arrangeCalendar,
  type CalendarInput,
  convertEffort,
  dayIndexOf,
  type EffortUnit,
  endExclusive,
  layoutCalendar,
  localDay,
  normalizeCountry,
  type ProjectDef,
  type ProjectIssue,
  type ProjectRollup,
  parseAvailability,
  personCell,
  projectOf,
  rollupProject,
  setFrontmatterKey,
  sprintStart,
  weekdaysIn,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { readHolidays, resolvePerson } from './availability.ts';
import { applyPlanPatch, type BoardIssue, type BoardModel, buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

/** an issue with no estimate still needs a width on the calendar */
const UNESTIMATED_DAYS = 2;
const MAX_DAYS = 320;
const PAD_DAYS = 10;
const DEFAULT_HORIZON_MONTHS = 6;

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
  sprints: {
    name: string;
    from: number;
    span: number;
    state: string;
    /** workdays of scheduled blocks that land inside this sprint */
    scheduled: number;
    /** the project team's absence-adjusted capacity in days (null: no team rows) */
    capacity: number | null;
  }[];
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
    holiday: number[];
  }[];
  blocks: CalendarBlockOut[];
  rail: { key: string; summary: string | null; path: string; days: number; estimated: boolean }[];
  finishDate: string | null;
  target: string | null;
  /** membership rules from the project note (epic keys, Jira labels, issue keys) */
  rules: { epics: string[]; labels: string[]; keys: string[] };
  cycles: string[][];
  warnings: string[];
}

const RULE_KINDS = ['epics', 'labels', 'keys'] as const;
type RuleKind = (typeof RULE_KINDS)[number];

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
    const explicit = fm.type === 'project';
    if (fm.type !== undefined && !explicit && !r.path.startsWith(`${folder}/`)) continue;
    // Child pages of a project (nested under it in the tree, or in a
    // sub-folder) are notes about the project, not projects of their own.
    if (
      !explicit &&
      (typeof fm.parent === 'string' || r.path.slice(folder.length + 1).includes('/'))
    )
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

/** The day axis: from the earliest dated sprint to `months` past today. */
function buildAxis(
  board: BoardModel,
  months: number,
): { days: string[]; sprintFrom: Record<string, number> } {
  const dated = board.sprints.filter((s) => s.start && s.end);
  const horizon = new Date();
  horizon.setUTCMonth(horizon.getUTCMonth() + months);
  let from: Date;
  let to: Date;
  if (dated.length) {
    from = sprintStart(
      dated.reduce((m, s) => (s.start && s.start < m ? s.start : m), dated[0]?.start as string),
    );
    const lastEnd = dated.reduce(
      (m, s) => ((s.end as string) > m ? (s.end as string) : m),
      dated[0]?.end as string,
    );
    to = endExclusive(lastEnd);
  } else {
    from = new Date();
    to = horizon;
  }
  if (horizon > to) to = horizon;
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
/**
 * Continue the sprint cadence past the last real sprint: cycle length from the
 * gap between the last two dated starts (or the last sprint's own span), name
 * by incrementing the trailing number. Projected sprints are visual guides —
 * they never become plan.sprint values.
 */
export function projectedSprints(
  board: BoardModel,
  lastDay: string,
): { name: string; start: string; end: string }[] {
  const dated = board.sprints
    .filter((s): s is typeof s & { start: string; end: string } => Boolean(s.start && s.end))
    .sort((a, b) => a.start.localeCompare(b.start));
  const last = dated[dated.length - 1];
  if (!last) return [];
  const DAY_MS = 86_400_000;
  const lastStart = sprintStart(last.start).getTime();
  let cycleDays = 14;
  const prev = dated[dated.length - 2];
  if (prev) {
    const gap = Math.round((lastStart - sprintStart(prev.start).getTime()) / DAY_MS);
    if (gap >= 5 && gap <= 60) cycleDays = gap;
  } else {
    const span = Math.round((endExclusive(last.end).getTime() - lastStart) / DAY_MS);
    if (span >= 5 && span <= 60) cycleDays = span;
  }
  const spanMs = endExclusive(last.end).getTime() - lastStart;
  const base = last.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || last.name;
  const numMatch = /(\d+)(?!.*\d)/.exec(base);
  const out: { name: string; start: string; end: string }[] = [];
  for (let k = 1; k <= 26; k++) {
    const start = new Date(lastStart + k * cycleDays * DAY_MS);
    const iso = start.toISOString().slice(0, 10);
    if (iso > lastDay) break;
    const name = numMatch
      ? base.replace(/(\d+)(?!.*\d)/, String(Number(numMatch[1]) + k))
      : `${base} +${k}`;
    out.push({
      name,
      start: iso,
      end: new Date(start.getTime() + spanMs - DAY_MS).toISOString().slice(0, 10),
    });
  }
  return out;
}

function awayByAssignee(
  v: VaultService,
  board: BoardModel,
  days: string[],
): {
  ooo: Record<string, number[]>;
  support: Record<string, number[]>;
  holiday: Record<string, number[]>;
  merged: Record<string, number[]>;
} {
  const ooo: Record<string, number[]> = {};
  const support: Record<string, number[]> = {};
  const holiday: Record<string, number[]> = {};
  const merged: Record<string, number[]> = {};
  let entries: ReturnType<typeof parseAvailability>['entries'] = [];
  try {
    entries = parseAvailability(v.read(v.config.availability.file).content).entries;
  } catch {
    entries = [];
  }
  const daySet = new Map(days.map((d, i) => [d, i]));
  for (const e of entries) {
    const person = resolvePerson(e.person, board.people);
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
  // country bank holidays shade and block everyone from that country
  for (const h of readHolidays(v).entries) {
    const c = normalizeCountry(h.country);
    const hTo = new Date(`${h.to}T00:00:00Z`);
    hTo.setUTCDate(hTo.getUTCDate() + 1);
    const hitDays = dayList(new Date(`${h.from}T00:00:00Z`), hTo)
      .map((d) => daySet.get(d))
      .filter((i): i is number => i !== undefined);
    if (!hitDays.length) continue;
    for (const p of board.people) {
      if (!p.country || normalizeCountry(p.country) !== c) continue;
      const keys = p.jiraIds.length ? p.jiraIds : [`person:${p.path}`];
      for (const id of keys) {
        for (const idx of hitDays) {
          if (!merged[id]) merged[id] = [];
          merged[id]?.push(idx);
          if (!holiday[id]) holiday[id] = [];
          holiday[id]?.push(idx);
        }
      }
    }
  }
  return { ooo, support, holiday, merged };
}

function calendarInput(
  v: VaultService,
  board: BoardModel,
  issues: ProjectIssue[],
  months = DEFAULT_HORIZON_MONTHS,
): { input: CalendarInput; away: ReturnType<typeof awayByAssignee> } {
  const cap = v.config.capacity;
  const unit = cap.unit as EffortUnit;
  const { days, sprintFrom } = buildAxis(board, months);
  const away = awayByAssignee(v, board, days);
  return {
    input: {
      days,
      issues,
      sprintFrom,
      away: away.merged,
      toDays: (e) => convertEffort(e, unit, 'days', cap) ?? e,
      unestimatedDays: UNESTIMATED_DAYS,
      notBefore: Math.max(dayIndexOf(days, localDay()), 0),
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
    const horizonMonths = Math.min(
      Math.max(Number(c.req.query('months')) || DEFAULT_HORIZON_MONTHS, 1),
      12,
    );
    const { input, away } = calendarInput(v, board, issues, horizonMonths);
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
        scheduled: 0,
        capacity: null,
      });
    }
    for (const ps of projectedSprints(board, input.days[input.days.length - 1] ?? '')) {
      const from = dayIndexOf(input.days, ps.start);
      const endIdx = dayIndexOf(input.days, endExclusive(ps.end).toISOString().slice(0, 10));
      if (from >= input.days.length || endIdx <= 0) continue;
      const f = Math.max(from, 0);
      sprints.push({
        name: ps.name,
        from: f,
        span: Math.min(endIdx, input.days.length) - f,
        state: 'projected',
        scheduled: 0,
        capacity: null,
      });
    }

    const todayIdx = dayIndexOf(input.days, localDay());
    const today = todayIdx >= 0 && todayIdx < input.days.length ? todayIdx : null;

    // ---- rows: roster first, then anyone with a block, unassigned last ------
    const roster = def.people
      .map((raw) => resolvePerson(raw, board.people))
      .filter((p): p is NonNullable<typeof p> => p !== null);
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
        holiday: away.holiday[assignee] ?? [],
      });
    };
    // a roster person without a Jira id still deserves a row
    for (const p of roster) addRow(p.jiraIds[0] ?? `person:${p.path}`, true);
    for (const b of layout.blocks) if (b.assignee !== '(unassigned)') addRow(b.assignee, false);
    // one global order everywhere: the notes-tree position, then name; Unassigned last
    const orderOf = (path: string | null): number => {
      const p = board.people.find((x) => x.path === path);
      return p?.sortOrder ?? Number.POSITIVE_INFINITY;
    };
    rows.sort((a, b) => orderOf(a.path) - orderOf(b.path) || a.name.localeCompare(b.name));
    addRow('(unassigned)', false);

    // ---- per-sprint load footer -------------------------------------------
    const sprintOfDay = (d: number) => sprints.find((x) => d >= x.from && d < x.from + x.span);
    for (const b of layout.blocks) {
      const awaySet = new Set(input.away[b.assignee] ?? []);
      let counted = 0;
      for (let d = b.start; d < b.start + b.span && counted < b.workDays; d++) {
        if (awaySet.has(d)) continue;
        counted++;
        const sp = sprintOfDay(d);
        if (sp) sp.scheduled = Math.round((sp.scheduled + 1) * 100) / 100;
      }
    }
    const team = rows
      .map((r) => board.people.find((p) => r.jiraId && p.jiraIds.includes(r.jiraId)))
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    for (const sp of sprints) {
      if (!team.length) continue;
      let cap = 0;
      for (const p of team) {
        // override > absence-adjusted > base; projected sprints fall to the base
        const c = p.overrides[sp.name] ?? p.suggested[sp.name] ?? p.capacity;
        if (c !== null) cap += input.toDays(c);
      }
      sp.capacity = Math.round(cap * 100) / 100;
    }

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
      rules: { epics: def.epics, labels: def.labels, keys: def.keys },
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

  /**
   * Add or remove membership rules on the project note: every issue in the
   * epic / with the label / with the key joins (or leaves) the project at once.
   */
  app.put('/rules', async (c) => {
    const body = (await c.req.json()) as {
      path?: string;
      add?: Partial<Record<RuleKind, unknown>>;
      remove?: Partial<Record<RuleKind, unknown>>;
    };
    if (!body.path) throw new HttpError(400, 'path is required');
    const def = projectDefs(v).find((d) => d.path === body.path);
    if (!def) throw new HttpError(404, `unknown project: ${body.path}`);
    const cleaned = (kind: RuleKind, raw: unknown): string[] => {
      if (raw === undefined) return [];
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string'))
        throw new HttpError(400, `${kind} must be a list of strings`);
      const out = raw.map((x) => x.trim()).filter(Boolean);
      if (kind !== 'labels') {
        const bad = out.find((k) => !/^[A-Z][A-Z0-9_]+-\d+$/.test(k));
        if (bad) throw new HttpError(400, `"${bad}" is not a Jira issue key`);
      }
      return out;
    };
    const rules: Record<RuleKind, string[]> = {
      epics: def.epics,
      labels: def.labels,
      keys: def.keys,
    };
    v.patchNote(body.path, (content) => {
      let text = content;
      for (const kind of RULE_KINDS) {
        const add = cleaned(kind, body.add?.[kind]);
        const remove = new Set(cleaned(kind, body.remove?.[kind]));
        const next = [
          ...rules[kind].filter((x) => !remove.has(x)),
          ...add.filter((x) => !rules[kind].includes(x)),
        ];
        if (next.length === rules[kind].length && next.every((x, i) => x === rules[kind][i]))
          continue;
        rules[kind] = next;
        text = setFrontmatterKey(text, kind, next);
      }
      return text;
    });
    return c.json({ ok: true, rules });
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
      const person = resolvePerson(raw, board.people);
      if (!person) throw new HttpError(400, `"${raw}" does not match a person note`);
      if (!people.includes(person.name)) people.push(person.name);
    }
    v.patchNote(body.path, (content) => setFrontmatterKey(content, 'people', people));
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
