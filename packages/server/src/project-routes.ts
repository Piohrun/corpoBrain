/** Projects: initiative-level rollups and the drag-and-drop timeline. */
import {
  convertEffort,
  type EffortUnit,
  forecastProject,
  layoutPlan,
  type ProjectDef,
  type ProjectIssue,
  type ProjectRollup,
  projectOf,
  rollupProject,
  type ScheduledBlock,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { type BoardIssue, type BoardModel, buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

/** an issue with no estimate still needs a width on the calendar */
const UNESTIMATED_DAYS = 2;

export interface ProjectSummary extends ProjectRollup {
  forecastSprint: string | null;
  forecastDate: string | null;
  violations: number;
}

export interface TimelineBlock extends ScheduledBlock {
  summary: string | null;
  path: string;
  status: string | null;
  statusCategory: string | null;
  priority: string | null;
  blockedBy: string[];
  dependsOn: string[];
}

export interface TimelineModel {
  project: ProjectRollup;
  unit: string;
  sprints: {
    name: string;
    start: string | null;
    end: string | null;
    state: string;
    days: number;
  }[];
  rows: {
    assignee: string;
    name: string;
    path: string | null;
    color: string | null;
    capacityDays: Record<string, number>;
  }[];
  planBlocks: TimelineBlock[];
  forecastBlocks: TimelineBlock[];
  backlog: TimelineBlock[];
  forecast: {
    finishSprint: string | null;
    finishDate: string | null;
    violations: { key: string; blocker: string; detail: string }[];
    cycles: string[][];
    unscheduled: { key: string; reason: string }[];
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Project notes live in the projects folder; their frontmatter carries the rules. */
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
    });
  }
  return defs;
}

const asProjectIssue = (i: BoardIssue): ProjectIssue => i;

function forecastInput(board: BoardModel, v: VaultService, issues: ProjectIssue[]) {
  const cap = v.config.capacity;
  const unit = cap.unit as EffortUnit;
  const toDays = (effort: number) => convertEffort(effort, unit, 'days', cap) ?? effort;
  const capacityDays: Record<string, Record<string, number>> = {};
  for (const p of board.people) {
    if (!p.active) continue;
    const perSprint: Record<string, number> = {};
    for (const s of board.sprints) {
      const c = p.overrides[s.name] ?? p.suggested[s.name] ?? p.capacity;
      if (c !== null) perSprint[s.name] = toDays(c);
    }
    for (const id of p.jiraIds) capacityDays[id] = perSprint;
  }
  const defaultCapacityDays =
    board.defaultCapacity !== null ? toDays(board.defaultCapacity) : cap.sprintLengthDays;
  return {
    sprints: board.sprints.map((s) => ({ name: s.name, start: s.start, end: s.end })),
    issues,
    capacityDays,
    defaultCapacityDays,
    toDays,
    unestimatedDays: UNESTIMATED_DAYS,
  };
}

/** Issues grouped by the project they belong to. */
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

export function projectRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const board = buildBoard(v);
    const defs = projectDefs(v);
    const grouped = issuesByProject(board, defs);
    const projects: ProjectSummary[] = defs.map((d) => {
      const issues = grouped.get(d.path) ?? [];
      const rollup = rollupProject(d, issues);
      const f = forecastProject(forecastInput(board, v, issues));
      return {
        ...rollup,
        forecastSprint: f.finishSprint,
        forecastDate: f.finishDate,
        violations: f.violations.length,
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

  /** Everything the timeline needs for one project. */
  app.get('/timeline', (c) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'path query parameter is required');
    const defs = projectDefs(v);
    const def = defs.find((d) => d.path === path);
    if (!def) throw new HttpError(404, `unknown project: ${path}`);
    const board = buildBoard(v);
    const issues = issuesByProject(board, defs).get(def.path) ?? [];
    const byKey = new Map(board.issues.map((i) => [i.key, i]));

    const input = forecastInput(board, v, issues);
    const planned = layoutPlan(input);
    const f = forecastProject(input);

    const decorate = (b: ScheduledBlock): TimelineBlock => {
      const i = byKey.get(b.key);
      return {
        ...b,
        summary: i?.summary ?? null,
        path: i?.path ?? '',
        status: i?.status ?? null,
        statusCategory: i?.statusCategory ?? null,
        priority: i?.priority ?? null,
        blockedBy: i?.blockedBy ?? [],
        dependsOn: i?.dependsOn ?? [],
      };
    };

    const people = new Map<string, TimelineModel['rows'][number]>();
    const rowFor = (assignee: string) => {
      if (people.has(assignee)) return;
      const p = board.people.find((x) => x.jiraIds.includes(assignee));
      people.set(assignee, {
        assignee,
        name: p?.name ?? (assignee === '(unassigned)' ? 'Unassigned' : assignee),
        path: p?.path ?? null,
        color: p?.color ?? null,
        capacityDays: input.capacityDays[assignee] ?? {},
      });
    };
    for (const b of planned.blocks) rowFor(b.assignee);
    for (const b of f.blocks) rowFor(b.assignee);

    const backlog = issues
      .filter((i) => planned.backlog.includes(i.key))
      .map((i) => ({
        key: i.key,
        assignee: i.effectiveAssignee ?? '(unassigned)',
        sprint: 'Backlog',
        plannedSprint: 'Backlog',
        offsetDays: 0,
        days: i.effectiveEffort === null ? UNESTIMATED_DAYS : input.toDays(i.effectiveEffort),
        slipped: false,
        estimated: i.effectiveEffort !== null,
        overflow: false,
      }))
      .map(decorate);

    const model: TimelineModel = {
      project: rollupProject(def, issues),
      unit: board.unit,
      sprints: board.sprints.map((s) => ({
        name: s.name,
        start: s.start,
        end: s.end,
        state: s.state,
        days: 0,
      })),
      rows: [...people.values()].sort((a, b) =>
        a.assignee === '(unassigned)'
          ? 1
          : b.assignee === '(unassigned)'
            ? -1
            : a.name.localeCompare(b.name),
      ),
      planBlocks: planned.blocks.map(decorate),
      forecastBlocks: f.blocks.map(decorate),
      backlog,
      forecast: {
        finishSprint: f.finishSprint,
        finishDate: f.finishDate,
        violations: f.violations,
        cycles: f.cycles,
        unscheduled: f.unscheduled,
      },
    };
    return c.json(model);
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
      `---\ntype: project\ntitle: ${JSON.stringify(title)}\nstatus: active\nepics: []\nlabels: []\n---\n\n## Goal\n\n## Notes\n`,
      'project',
    );
    return c.json({ ok: true, path });
  });

  return app;
}
