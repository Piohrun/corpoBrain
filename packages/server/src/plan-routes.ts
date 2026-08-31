/** Planning workbench API: board model, plan writes, person capacity. */
import {
  convertEffort,
  type EffortUnit,
  issueRiskFlags,
  parseFrontmatter,
  type RiskFlag,
  setFrontmatterKey,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { syncRegionParent } from './tree-routes.ts';
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
}

export interface BoardModel {
  unit: string;
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
] as const;

export function buildBoard(v: VaultService, now = new Date()): BoardModel {
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

  const people = (
    db
      .prepare(
        'SELECT path, jira_id, name, capacity, overrides_json, active, region, team, load_overrides_json, color FROM people ORDER BY name',
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
  }));

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
              p.bucket AS p_bucket, p.blocked_on_json AS p_blocked, p.note AS p_note
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

export function planRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/board', (c) => c.json(buildBoard(v)));

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
    if (Object.keys(partial).length) v.updateCapacityConfig(partial);
    return c.json({ ok: true, capacity: v.config.capacity });
  });

  /** PATCH plan fields of one issue. null clears a field; {} allowed. */
  app.put('/issue/:key', async (c) => {
    const key = c.req.param('key');
    const row = v.indexer.db.prepare('SELECT path FROM jira WHERE key = ?').get(key) as
      | { path: string }
      | undefined;
    if (!row) throw new HttpError(404, `unknown jira issue ${key}`);
    const patch = (await c.req.json()) as Record<string, unknown>;
    for (const k of Object.keys(patch)) {
      if (!(PLAN_KEYS as readonly string[]).includes(k))
        throw new HttpError(400, `unknown plan field: ${k}`);
    }
    const { content } = v.read(row.path);
    const fm = parseFrontmatter(content);
    const plan = {
      ...(typeof fm.data.plan === 'object' && fm.data.plan && !Array.isArray(fm.data.plan)
        ? (fm.data.plan as Record<string, unknown>)
        : {}),
    };
    for (const [k, val] of Object.entries(patch)) {
      if (val === null) delete plan[k];
      else plan[k] = val;
    }
    const updated = Object.keys(plan).length
      ? setFrontmatterKey(content, 'plan', plan)
      : deletePlan(content);
    v.write(row.path, updated);
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
    if (!body.title?.trim()) throw new HttpError(400, 'title required');
    const slug = body.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '');
    const path = `${v.config.folders.planning}/${slug || 'view'}.md`;
    const content = `---\ntype: view\ntitle: ${JSON.stringify(body.title.trim())}\nfilter:\n${Object.entries(
      body.filter ?? {},
    )
      .filter(([, val]) => val !== null && val !== undefined && val !== '')
      .map(([k, val]) => `  ${k}: ${JSON.stringify(val)}`)
      .join('\n')}\n---\n\nSaved planning view.\n`;
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
    const { content } = v.read(body.path);
    let text = content;
    if (body.capacity !== undefined) {
      text =
        body.capacity === null
          ? deleteKey(text, 'capacity')
          : setFrontmatterKey(text, 'capacity', body.capacity);
    }
    if (body.overrides !== undefined) {
      text = Object.keys(body.overrides).length
        ? setFrontmatterKey(text, 'capacity_overrides', body.overrides)
        : deleteKey(text, 'capacity_overrides');
    }
    if (body.color !== undefined) {
      if (body.color && !/^#[0-9a-fA-F]{6}$/.test(body.color))
        throw new HttpError(400, 'color must be a #rrggbb hex value');
      text = body.color ? setFrontmatterKey(text, 'color', body.color) : deleteKey(text, 'color');
    }
    if (body.loadOverrides !== undefined) {
      text = Object.keys(body.loadOverrides).length
        ? setFrontmatterKey(text, 'load_overrides', body.loadOverrides)
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
    v.write(body.path, text);
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
