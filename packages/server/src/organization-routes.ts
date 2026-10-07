import {
  buildOrganization,
  deleteFrontmatterKey,
  naturalCompare,
  ORG_KINDS,
  type OrgKind,
  type OrgModel,
  type OrgSource,
  orgSourceType,
  orgText,
  parseFrontmatter,
  setFrontmatterKey,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

const sourceCache = new WeakMap<VaultService, { version: number; sources: OrgSource[] }>();
const modelCache = new WeakMap<VaultService, { version: number; model: OrgModel }>();

/**
 * Person and organization notes (the only notes relationships can point at),
 * read once per index version. Callers must not mutate the result.
 */
export function organizationSources(v: VaultService): OrgSource[] {
  const hit = sourceCache.get(v);
  if (hit && hit.version === v.indexer.version) return hit.sources;
  const people = `${v.config.folders.people}/`;
  const templates = `${v.config.folders.templates}/`;
  const rows = v.indexer.db
    .prepare(
      `SELECT path, title, type, frontmatter_json FROM notes
       WHERE protected = 0
         AND (type IN ('person', 'org_unit') OR substr(path, 1, ?) = ?)
         AND substr(path, 1, ?) != ?
       ORDER BY title, path`,
    )
    .all(people.length, people, templates.length, templates) as {
    path: string;
    title: string;
    type: string;
    frontmatter_json: string;
  }[];
  rows.sort((a, b) => naturalCompare(a.title, b.title) || naturalCompare(a.path, b.path));
  const sources = rows.map((r) => {
    const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
    const source = { path: r.path, title: r.title, type: r.type, fm };
    return { ...source, type: orgSourceType(source, v.config.folders.people) };
  });
  sourceCache.set(v, { version: v.indexer.version, sources });
  return sources;
}

export function organizationModel(sources: OrgSource[]): OrgModel {
  return buildOrganization(sources);
}

/** The organization map for the current index, built once per version. */
function currentModel(v: VaultService): OrgModel {
  const hit = modelCache.get(v);
  if (hit && hit.version === v.indexer.version) return hit.model;
  const model = organizationModel(organizationSources(v));
  modelCache.set(v, { version: v.indexer.version, model });
  return model;
}

export const PERSON_ORG_FIELDS = new Set([
  'functional_manager',
  'entity_manager',
  'primary_pod',
  'secondary_pods',
  'country_lead_for',
  'region_lead_for',
]);
export const UNIT_ORG_FIELDS = new Set([
  'parent',
  'leads',
  'mandate',
  'status',
  'pod_kind',
  'headcount',
  'headcount_reporting',
  'headcount_functional_manager',
  'headcount_entity_manager',
  'headcount_groups',
]);
const LIST_FIELDS = new Set(['secondary_pods', 'leads', 'country_lead_for', 'region_lead_for']);

function patchContent(
  content: string,
  patch: Record<string, unknown>,
  allowed: Set<string>,
): string {
  let next = content;
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) throw new HttpError(400, `unsupported organization field: ${key}`);
    if (value !== null) {
      if (key === 'headcount') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
          throw new HttpError(400, 'headcount must be a non-negative whole number or null');
      } else if (key === 'headcount_groups') {
        if (
          !Array.isArray(value) ||
          value.some((group) => !group || typeof group !== 'object' || Array.isArray(group))
        )
          throw new HttpError(400, 'headcount_groups must be a list of counted groups');
        for (const group of value as Record<string, unknown>[]) {
          if (
            Object.keys(group).some(
              (field) =>
                !['id', 'count', 'country', 'functional_manager', 'entity_manager'].includes(field),
            )
          )
            throw new HttpError(400, 'unsupported counted group field');
          if (group.country != null && typeof group.country !== 'string')
            throw new HttpError(400, 'group country must be text');
        }
      } else if (LIST_FIELDS.has(key)) {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
          throw new HttpError(400, `${key} must be a list of strings`);
      } else if (typeof value !== 'string') {
        throw new HttpError(400, `${key} must be text or null`);
      }
    }
    if (key === 'pod_kind' && value && !['product', 'support'].includes(value as string))
      throw new HttpError(400, 'pod_kind must be product or support');
    next =
      value === null || value === ''
        ? deleteFrontmatterKey(next, key)
        : setFrontmatterKey(next, key, value);
  }
  return next;
}

export function validateOrganizationCandidate(
  sources: OrgSource[],
  path: string,
  content: string,
  fields: Set<string>,
): void {
  const fm = parseFrontmatter(content).data;
  const current = sources.find((s) => s.path === path);
  const candidate: OrgSource = {
    path,
    title: orgText(fm.title) || current?.title || path,
    type: current?.type ?? orgText(fm.type),
    fm,
  };
  const model = organizationModel([...sources.filter((s) => s.path !== path), candidate]);
  const problem = model.problems.find((p) => p.path === path && fields.has(p.field));
  if (problem) throw new HttpError(400, `${problem.field}: ${problem.message}`);
}

function readBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'an object body is required');
  return value as Record<string, unknown>;
}

export function organizationRoutes(v: VaultService): Hono {
  const app = new Hono();
  app.get('/', (c) => c.json(currentModel(v)));

  for (const [route, type, fields] of [
    ['/person', 'person', PERSON_ORG_FIELDS],
    ['/unit', 'org_unit', UNIT_ORG_FIELDS],
  ] as const) {
    app.put(route, async (c) => {
      const body = readBody(await c.req.json());
      const path = orgText(body.path);
      const patch = readBody(body.patch);
      const sources = organizationSources(v);
      if (!sources.some((s) => s.path === path && s.type === type))
        throw new HttpError(404, `not a ${type} note: ${path}`);
      const result = v.patchNote(path, (content) => {
        const next = patchContent(content, patch, fields);
        // A new primary POD must also be checked against existing secondary memberships.
        const changed = new Set(Object.keys(patch));
        if (changed.has('primary_pod')) changed.add('secondary_pods');
        if (changed.has('headcount')) changed.add('headcount_groups');
        validateOrganizationCandidate(sources, path, next, changed);
        return next;
      });
      if (result.changed) v.notifyPathsChanged([path]);
      return c.json({ ok: true, path });
    });
  }

  app.post('/units', async (c) => {
    const body = readBody(await c.req.json());
    const title = orgText(body.title);
    const kind = orgText(body.kind) as OrgKind;
    if (!title || title.length > 120 || /[\r\n]/.test(title))
      throw new HttpError(400, 'a title of 1–120 characters is required');
    if (!ORG_KINDS.includes(kind)) throw new HttpError(400, 'invalid organization kind');
    const slug =
      title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'unit';
    const sources = organizationSources(v);
    const existing = new Set(v.list().map((n) => n.path));
    let path = `${v.config.folders.organization}/${slug}.md`;
    for (let n = 2; existing.has(path); n++)
      path = `${v.config.folders.organization}/${slug}-${n}.md`;
    let content = `---\ntype: org_unit\ntitle: ${JSON.stringify(title)}\norg_kind: ${kind}\n---\n\n# ${title}\n\n## Mandate\n\n## Responsibilities\n\n## Working notes\n`;
    const patch = body.patch === undefined ? {} : readBody(body.patch);
    content = patchContent(content, patch, UNIT_ORG_FIELDS);
    validateOrganizationCandidate(
      sources,
      path,
      content,
      new Set([...UNIT_ORG_FIELDS, 'org_kind']),
    );
    v.create(path, title, content);
    v.notifyPathsChanged([path]);
    return c.json({ path }, 201);
  });
  return app;
}
