/** Planning workbench API: board model, plan writes, person capacity. */
import {
  type Absence,
  adjustCapacity,
  convertEffort,
  type EffortUnit,
  issueRiskFlags,
  parseFrontmatter,
  patchFrontmatter,
  type RiskFlag,
  setFrontmatterKey,
  sprintHealth,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { resolveAvailability } from './availability.ts';
import { buildTree, syncRegionParent, type TreeNode } from './tree-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

export interface BoardIssue {
  key: string;
  path: string;
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  issueType: string | null;
  priority: string | null;
  epic: string | null;
  labels: string[];
  updated: string | null;
  jiraSprint: string | null;
  jiraAssignee: string | null;
  estimate: number | null;
  plan: {
    sprint: string | null;
    assignee: string | null;
    rank: number | null;
    effort: number | null;
    risk: string | null;
    confidence: string | null;
    bucket: string | null;
    blockedOn: string[];
    note: string | null;
    project: string | null;
    /** pinned start day on the project calendar, YYYY-MM-DD */
    start: string | null;
  };
  effectiveSprint: string;
  effectiveAssignee: string | null;
  effectiveEffort: number | null;
  overridden: { sprint: boolean; assignee: boolean };
  riskFlags: RiskFlag[];
  /** issue keys this depends on: plan.blocked_on + Jira "is blocked by" links */
  dependsOn: string[];
  /** subset of dependsOn that are known and not done */
  blockedBy: string[];
}

export interface BoardPerson {
  path: string;
  name: string;
  jiraIds: string[];
  capacity: number | null;
  overrides: Record<string, number>;
  active: boolean;
  /** capacity came from the vault-wide default, not this person's file */
  capacityIsDefault: boolean;
  region: string | null;
  team: string | null;
  /** manual replacement of the person's planned/used load per sprint */
  loadOverrides: Record<string, number>;
  /** explicit display color (hub notes); falls back to a name-derived hue */
  color: string | null;
  /**
   * Depth-first position in the notes tree. Hierarchical: everyone under the
   * first region hub sorts before anyone under the second, at every level.
   * null (not in the people tree) sorts last.
   */
  sortOrder: number | null;
  /** for country-wide bank holidays */
  country: string | null;
  /** bandwidth after absence, per sprint — only where it is lower than capacity */
  suggested: Record<string, number>;
  /** why it is lower */
  absence: Record<string, Absence>;
}

export interface BoardModel {
  unit: string;
  health: { bigIssue: number; staleDays: number; underloadPct: number };
  sprints: {
    id: number;
    name: string;
    state: string;
    start: string | null;
    end: string | null;
    source: string;
  }[];
  columns: string[]; // sprint names in order + 'Backlog'
  people: BoardPerson[];
  issues: BoardIssue[];
  defaultCapacity: number | null;
  /** loads[personKey][column] = summed effective effort */
  loads: Record<string, Record<string, number>>;
}

const VIEW_FILTER_KEYS = ['text', 'flag', 'sprint', 'assignee'] as const;

const PLAN_KEYS = [
  'sprint',
  'assignee',
  'rank',
  'effort',
  'risk',
  'confidence',
  'bucket',
  'blocked_on',
  'note',
  'project',
  'start',
] as const;

/** path → depth-first rank across the people folder's tree (hubs included). */
function peopleTreeRank(v: VaultService): Map<string, number> {
  const rank = new Map<string, number>();
  let i = 0;
  const walk = (n: TreeNode): void => {
    rank.set(n.path, i++);
    for (const c of n.children) walk(c);
  };
  for (const f of buildTree(v).folders) {
    if (f.folder !== v.config.folders.people) continue;
    for (const r of f.roots) walk(r);
  }
  return rank;
}

/**
 * The board is rebuilt from the index on every request that needs it (board,
 * availability, projects, timeline, person…). Between two index changes the
 * answer is identical, so it is memoised per vault on the index version —
 * and on the day, since risk flags look at today.
 */
const boardCache = new WeakMap<VaultService, { key: string; board: BoardModel }>();

export function buildBoard(v: VaultService, now = new Date()): BoardModel {
  const key = `${v.indexer.version}|${now.toISOString().slice(0, 10)}`;
  const hit = boardCache.get(v);
  if (hit && hit.key === key) return hit.board;
  const board = computeBoard(v, now);
  boardCache.set(v, { key, board });
  return board;
}

function computeBoard(v: VaultService, now: Date): BoardModel {
  const db = v.indexer.db;
  const cap = v.config.capacity;
  const estimateUnit = v.config.jira.estimateUnit as EffortUnit;

  const sprints = db
    .prepare(
      `SELECT id, name, state, start, end, source FROM sprints
       WHERE state IN ('active','future') ORDER BY state = 'future', start IS NULL, start, id`,
    )
    .all() as {
    id: number;
    name: string;
    state: string;
    start: string | null;
    end: string | null;
    source: string;
  }[];
  const columns = [...sprints.map((s) => s.name), 'Backlog'];

  const treeRank = peopleTreeRank(v);
  const people = (
    db
      .prepare(
        'SELECT path, jira_id, name, capacity, overrides_json, active, region, team, load_overrides_json, color, sort_order, country FROM people ORDER BY sort_order IS NULL, sort_order, name',
      )
      .all() as {
      path: string;
      jira_id: string | null;
      name: string;
      capacity: number | null;
      overrides_json: string | null;
      active: number;
      region: string | null;
      team: string | null;
      load_overrides_json: string | null;
      color: string | null;
      sort_order: number | null;
      country: string | null;
    }[]
  ).map((p) => ({
    path: p.path,
    name: p.name,
    jiraIds: safeArr(p.jira_id),
    capacity: p.capacity ?? cap.defaultCapacity,
    capacityIsDefault: p.capacity === null && cap.defaultCapacity !== null,
    overrides: safeObj(p.overrides_json),
    active: p.active === 1,
    region: p.region,
    team: p.team,
    loadOverrides: safeObj(p.load_overrides_json),
    color: p.color,
    sortOrder: treeRank.get(p.path) ?? null,
    country: p.country,
    suggested: {} as Record<string, number>,
    absence: {} as Record<string, Absence>,
  }));
  people.sort(
    (a, b) =>
      (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );

  // out-of-office and support rota reduce bandwidth before anything else reads it
  const availability = resolveAvailability(
    v,
    sprints.map((s) => ({ name: s.name, start: s.start, end: s.end })),
    people,
  );
  for (const p of people) {
    const perSprint = availability.byPerson.get(p.path);
    if (!perSprint) continue;
    for (const [sprint, absence] of perSprint) {
      p.absence[sprint] = absence;
      if (p.capacity === null) continue;
      const adjusted = adjustCapacity(p.capacity, absence);
      if (adjusted < p.capacity) p.suggested[sprint] = adjusted;
    }
  }

  const doneKeys = new Set(
    (
      db.prepare("SELECT key FROM jira WHERE status_category = 'done'").all() as { key: string }[]
    ).map((r) => r.key),
  );
  const allKeys = new Set(
    (db.prepare('SELECT key FROM jira').all() as { key: string }[]).map((r) => r.key),
  );

  const rows = db
    .prepare(
      `SELECT j.*, n.frontmatter_json AS fm_json,
              p.sprint AS p_sprint, p.assignee AS p_assignee, p.rank AS p_rank,
              p.effort AS p_effort, p.risk AS p_risk, p.confidence AS p_confidence,
              p.bucket AS p_bucket, p.blocked_on_json AS p_blocked, p.note AS p_note,
              p.project AS p_project, p.start AS p_start
       FROM jira j
       LEFT JOIN notes n ON n.path = j.path
       LEFT JOIN plan p ON p.key = j.key ORDER BY j.key`,
    )
    .all() as Record<string, unknown>[];

  const sprintNames = new Set(columns);
  const issues: BoardIssue[] = rows.map((r) => {
    const estimate = r.estimate as number | null;
    const planEffort = r.p_effort as number | null;
    const effectiveEffort =
      planEffort ??
      (estimate !== null ? convertEffort(estimate, estimateUnit, cap.unit, cap) : null);
    const planSprint = r.p_sprint as string | null;
    const jiraSprint = r.sprint as string | null;
    // A jira sprint that is not one of the visible columns (e.g. closed) maps to Backlog.
    const baseSprint = jiraSprint && sprintNames.has(jiraSprint) ? jiraSprint : 'Backlog';
    const effectiveSprint = planSprint && sprintNames.has(planSprint) ? planSprint : baseSprint;
    const blockedOn = safeArr(r.p_blocked as string | null);
    const linksBlocked = extractBlockingLinks(r.fm_json as string | null);
    const dependsOn = [...new Set([...blockedOn, ...linksBlocked])];
    const blockedUnresolved = dependsOn.filter((k) => allKeys.has(k) && !doneKeys.has(k));
    const issue: BoardIssue = {
      key: r.key as string,
      path: r.path as string,
      summary: r.summary as string | null,
      status: r.status as string | null,
      statusCategory: r.status_category as string | null,
      issueType: r.issue_type as string | null,
      priority: r.priority as string | null,
      epic: r.epic as string | null,
      labels: safeArr(r.labels_json as string | null),
      updated: r.updated as string | null,
      jiraSprint,
      jiraAssignee: r.assignee as string | null,
      estimate,
      plan: {
        sprint: planSprint,
        assignee: r.p_assignee as string | null,
        rank: r.p_rank as number | null,
        effort: planEffort,
        risk: r.p_risk as string | null,
        confidence: r.p_confidence as string | null,
        bucket: r.p_bucket as string | null,
        blockedOn,
        note: r.p_note as string | null,
        project: r.p_project as string | null,
        start: r.p_start as string | null,
      },
      effectiveSprint,
      effectiveAssignee: (r.p_assignee as string | null) ?? (r.assignee as string | null),
      effectiveEffort,
      overridden: {
        sprint: planSprint !== null && effectiveSprint !== baseSprint,
        assignee: r.p_assignee !== null && r.p_assignee !== r.assignee,
      },
      dependsOn,
      blockedBy: blockedUnresolved,
      riskFlags: issueRiskFlags(
        {
          statusCategory: r.status_category as string | null,
          assignee: r.assignee as string | null,
          planAssignee: r.p_assignee as string | null,
          estimate,
          planEffort,
          updated: r.updated as string | null,
          blockedOn,
          blockedOnUnresolved: blockedUnresolved,
          priority: r.priority as string | null,
        },
        now,
      ),
    };
    return issue;
  });

  const personKeyOf = (assignee: string | null): string => {
    if (!assignee) return '(unassigned)';
    const person = people.find((p) => p.jiraIds.includes(assignee));
    return person ? person.path : assignee;
  };
  const loads: Record<string, Record<string, number>> = {};
  for (const i of issues) {
    if (i.statusCategory === 'done') continue;
    const pk = personKeyOf(i.effectiveAssignee);
    const col = i.effectiveSprint;
    loads[pk] ??= {};
    loads[pk][col] = Math.round(((loads[pk][col] ?? 0) + (i.effectiveEffort ?? 0)) * 100) / 100;
  }

  return {
    unit: cap.unit,
    health: v.config.health,
    defaultCapacity: cap.defaultCapacity,
    sprints,
    columns,
    people,
    issues,
    loads,
  };
}

const WIKILINK_VALUE = /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/;

/** Inward "blocked" links from the mirrored frontmatter `links:` list. */
function extractBlockingLinks(fmJson: string | null): string[] {
  if (!fmJson) return [];
  try {
    const fm = JSON.parse(fmJson) as { links?: { type?: string; dir?: string; key?: string }[] };
    if (!Array.isArray(fm.links)) return [];
    return fm.links
      .filter((l) => l.dir === 'inward' && /block/i.test(l.type ?? ''))
      .map((l) => {
        const m = WIKILINK_VALUE.exec((l.key ?? '').trim());
        return m ? (m[1] as string).trim() : (l.key ?? '');
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeArr(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeObj(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'number') out[k] = val;
    return out;
  } catch {
    return {};
  }
}

/** Merge a patch into an issue's plan.* frontmatter. Shared with the projects calendar. */
const LEVELS = new Set(['low', 'medium', 'high']);
/** Largest effort a single issue may carry, in the capacity unit (a year of days). */
const MAX_EFFORT = 10_000;

const isDay = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(x) &&
  new Date(`${x}T00:00:00Z`).toISOString().startsWith(x);

/**
 * Values reach frontmatter verbatim, so every key gets a type check here:
 * a bad effort otherwise crashes the calendar for the whole vault, and a
 * date the parser cannot read pins a block to the last day of the grid.
 * Null always means "clear the field" and is accepted for every key.
 */
export function validatePlanValues(v: VaultService, patch: Record<string, unknown>): void {
  const bad = (k: string, want: string): never => throwHttp(400, `plan.${k} must be ${want}`);
  for (const [k, val] of Object.entries(patch)) {
    if (val === null) continue;
    switch (k) {
      case 'sprint': {
        const name = typeof val === 'string' ? val.trim() : '';
        if (!name) bad(k, 'a sprint name or Backlog');
        const known =
          name === 'Backlog' ||
          v.indexer.db.prepare('SELECT 1 FROM sprints WHERE name = ?').get(name) !== undefined;
        if (!known) throwHttp(400, `plan.sprint: unknown sprint "${name}"`);
        break;
      }
      case 'assignee':
      case 'bucket':
      case 'note':
      case 'project':
        if (typeof val !== 'string') bad(k, 'a string');
        break;
      case 'rank':
        if (typeof val !== 'number' || !Number.isFinite(val)) bad(k, 'a finite number');
        break;
      case 'effort':
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > MAX_EFFORT)
          bad(k, `a number between 0 and ${MAX_EFFORT}`);
        break;
      case 'risk':
      case 'confidence':
        if (typeof val !== 'string' || !LEVELS.has(val)) bad(k, 'low, medium or high');
        break;
      case 'blocked_on':
        if (!Array.isArray(val) || !val.every((x) => typeof x === 'string'))
          bad(k, 'a list of issue keys');
        break;
      case 'start':
        if (!isDay(val)) bad(k, 'a real YYYY-MM-DD date');
        break;
    }
  }
}

function throwHttp(status: number, message: string): never {
  throw new HttpError(status, message);
}

export function applyPlanPatch(
  v: VaultService,
  key: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const row = v.indexer.db.prepare('SELECT path FROM jira WHERE key = ?').get(key) as
    | { path: string }
    | undefined;
  if (!row) throw new HttpError(404, `unknown jira issue ${key}`);
  for (const k of Object.keys(patch)) {
    if (!(PLAN_KEYS as readonly string[]).includes(k))
      throw new HttpError(400, `unknown plan field: ${k}`);
  }
  validatePlanValues(v, patch);
  let plan: Record<string, unknown> = {};
  v.patchNote(row.path, (content) => {
    const fm = parseFrontmatter(content);
    plan = {
      ...(typeof fm.data.plan === 'object' && fm.data.plan && !Array.isArray(fm.data.plan)
        ? (fm.data.plan as Record<string, unknown>)
        : {}),
    };
    for (const [k, val] of Object.entries(patch)) {
      if (val === null) delete plan[k];
      else plan[k] = val;
    }
    return Object.keys(plan).length
      ? setFrontmatterKey(content, 'plan', plan)
      : deletePlan(content);
  });
  return plan;
}

export function planRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/board', (c) => c.json(buildBoard(v)));

  /** Problems in one sprint (default: the active one). */
  app.get('/health', (c) => {
    const board = buildBoard(v);
    const wanted = c.req.query('sprint');
    const sprint = wanted
      ? board.sprints.find((s) => s.name === wanted)
      : (board.sprints.find((s) => s.state === 'active') ?? board.sprints[0]);
    if (!sprint) throw new HttpError(404, 'no active or future sprint to check');
    return c.json(
      sprintHealth(
        { sprint, issues: board.issues, people: board.people, unit: board.unit },
        new Date(),
        v.config.health,
      ),
    );
  });

  /** vault-wide planning settings */
  app.put('/capacity-config', async (c) => {
    const body = (await c.req.json()) as { defaultCapacity?: number | null; unit?: string };
    const partial: Partial<typeof v.config.capacity> = {};
    if (body.defaultCapacity !== undefined) {
      if (body.defaultCapacity !== null && !(Number(body.defaultCapacity) > 0))
        throw new HttpError(400, 'defaultCapacity must be a positive number or null');
      partial.defaultCapacity = body.defaultCapacity === null ? null : Number(body.defaultCapacity);
    }
    if (body.unit && ['days', 'points', 'hours'].includes(body.unit))
      partial.unit = body.unit as typeof v.config.capacity.unit;
    if (Object.keys(partial).length) v.updateConfig('capacity', partial);
    const h = (body as { health?: Record<string, unknown> }).health;
    if (h) {
      const hp: Partial<typeof v.config.health> = {};
      for (const k of ['bigIssue', 'staleDays', 'underloadPct'] as const) {
        if (h[k] !== undefined) {
          const n = Number(h[k]);
          if (!(n > 0)) throw new HttpError(400, `health.${k} must be a positive number`);
          if (k === 'underloadPct' && n > 1)
            throw new HttpError(400, 'health.underloadPct is a fraction between 0 and 1');
          hp[k] = n;
        }
      }
      if (Object.keys(hp).length) v.updateConfig('health', hp);
    }
    return c.json({ ok: true, capacity: v.config.capacity, health: v.config.health });
  });

  /** PATCH plan fields of one issue. null clears a field; {} allowed. */
  app.put('/issue/:key', async (c) => {
    const key = c.req.param('key');
    const patch = (await c.req.json()) as Record<string, unknown>;
    const plan = applyPlanPatch(v, key, patch);
    return c.json({ ok: true, plan });
  });

  /** Saved views: planning/<slug>.md with type: view frontmatter. */
  app.get('/views', (c) => {
    const rows = v.indexer.db
      .prepare("SELECT path, title, frontmatter_json FROM notes WHERE type = 'view' ORDER BY title")
      .all() as { path: string; title: string; frontmatter_json: string }[];
    return c.json(
      rows.map((r) => {
        const fm = JSON.parse(r.frontmatter_json) as { filter?: unknown };
        return { path: r.path, title: r.title, filter: fm.filter ?? {} };
      }),
    );
  });

  app.post('/views', async (c) => {
    const body = (await c.req.json()) as { title?: string; filter?: Record<string, unknown> };
    const title = body.title?.trim();
    if (!title) throw new HttpError(400, 'title required');
    const slug = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '');
    const path = `${v.config.folders.planning}/${slug || 'view'}.md`;
    // Only the filter keys the UI knows, and only as strings: the frontmatter
    // is rendered by the YAML writer, never by string concatenation.
    const filter: Record<string, string> = {};
    for (const k of VIEW_FILTER_KEYS) {
      const val = body.filter?.[k];
      if (typeof val === 'string' && val.trim() !== '') filter[k] = val;
    }
    // Re-saving a view updates it; any other note at that path is left alone.
    const existing = v.indexer.db.prepare('SELECT type FROM notes WHERE path = ?').get(path) as
      | { type: string }
      | undefined;
    if (existing && existing.type !== 'view')
      throw new HttpError(409, `${path} exists and is not a view — pick another title`);
    const base = existing ? v.read(path).content : 'Saved planning view.\n';
    const content = patchFrontmatter(base, { type: 'view', title, filter });
    v.write(path, content);
    return c.json({ ok: true, path });
  });

  /** Update a person's capacity / per-sprint overrides / active flag. */
  app.put('/person', async (c) => {
    const body = (await c.req.json()) as {
      path?: string;
      capacity?: number | null;
      overrides?: Record<string, number>;
      loadOverrides?: Record<string, number>;
      active?: boolean;
      region?: string | null;
      team?: string | null;
      color?: string | null;
    };
    if (!body.path) throw new HttpError(400, 'path required');
    // only person notes carry capacity: the people folder, or type: person
    const note = v.indexer.db.prepare('SELECT type FROM notes WHERE path = ?').get(body.path) as
      | { type: string }
      | undefined;
    if (note?.type !== 'person') throw new HttpError(400, `${body.path} is not a person note`);
    const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
    const numberMap = (x: unknown, what: string): Record<string, number> => {
      if (!x || typeof x !== 'object' || Array.isArray(x))
        throw new HttpError(400, `${what} must be an object of sprint → number`);
      for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
        if (!finite(val) || val < 0)
          throw new HttpError(400, `${what}["${k}"] must be a non-negative number`);
      }
      return x as Record<string, number>;
    };
    if (
      body.capacity !== undefined &&
      body.capacity !== null &&
      !(finite(body.capacity) && body.capacity >= 0)
    )
      throw new HttpError(400, 'capacity must be a non-negative number or null');
    const overrides =
      body.overrides === undefined ? undefined : numberMap(body.overrides, 'overrides');
    const loadOverrides =
      body.loadOverrides === undefined ? undefined : numberMap(body.loadOverrides, 'loadOverrides');
    if (body.active !== undefined && typeof body.active !== 'boolean')
      throw new HttpError(400, 'active must be true or false');
    for (const k of ['region', 'team'] as const) {
      if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string')
        throw new HttpError(400, `${k} must be a string or null`);
    }
    if (body.color !== undefined && body.color && !/^#[0-9a-fA-F]{6}$/.test(body.color))
      throw new HttpError(400, 'color must be a #rrggbb hex value');

    v.patchNote(body.path, (content) => {
      let text = content;
      if (body.capacity !== undefined) {
        text =
          body.capacity === null
            ? deleteKey(text, 'capacity')
            : setFrontmatterKey(text, 'capacity', body.capacity);
      }
      if (overrides !== undefined) {
        text = Object.keys(overrides).length
          ? setFrontmatterKey(text, 'capacity_overrides', overrides)
          : deleteKey(text, 'capacity_overrides');
      }
      if (body.color !== undefined) {
        text = body.color ? setFrontmatterKey(text, 'color', body.color) : deleteKey(text, 'color');
      }
      if (loadOverrides !== undefined) {
        text = Object.keys(loadOverrides).length
          ? setFrontmatterKey(text, 'load_overrides', loadOverrides)
          : deleteKey(text, 'load_overrides');
      }
      if (body.active !== undefined) text = setFrontmatterKey(text, 'active', body.active);
      if (body.region !== undefined) {
        text = body.region
          ? setFrontmatterKey(text, 'region', body.region)
          : deleteKey(text, 'region');
      }
      if (body.team !== undefined) {
        text = body.team ? setFrontmatterKey(text, 'team', body.team) : deleteKey(text, 'team');
      }
      return text;
    });
    if (body.region !== undefined || body.team !== undefined) syncRegionParent(v, body.path);
    return c.json({ ok: true });
  });

  return app;
}

// small local helpers around core (avoid importing delete twice)
import { deleteFrontmatterKey } from '@corpobrain/core';

function deleteKey(text: string, key: string): string {
  return deleteFrontmatterKey(text, key);
}
function deletePlan(text: string): string {
  return deleteFrontmatterKey(text, 'plan');
}
