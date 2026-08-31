import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Note hierarchy (SPEC §3.5) and note-metadata edits (type/parent/order). */
import { deleteFrontmatterKey, parseFrontmatter, setFrontmatterKey } from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

export interface CategoryField {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'list';
  source: 'builtin' | 'template' | 'seen';
}

const FIELD_EXCLUDED = new Set([
  'id',
  'type',
  'title',
  'parent',
  'order',
  'tags',
  'created',
  'updated',
  'template',
  'aliases',
  'jira',
  'plan',
  'key',
  'capacity_overrides',
]);

function kindOf(v: unknown): CategoryField['kind'] {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'list';
  return 'text';
}

/** Suggested editable frontmatter fields for a category (folder). */
export function categoryFields(
  v: VaultService,
  category: string,
): { fields: CategoryField[]; sprintOverrides: string[] | null } {
  const fields = new Map<string, CategoryField>();
  const add = (
    key: string,
    kind: CategoryField['kind'],
    source: CategoryField['source'],
    force = false,
  ) => {
    if (!fields.has(key) && (force || !FIELD_EXCLUDED.has(key)))
      fields.set(key, { key, kind, source });
  };

  const isPeople = category === v.config.folders.people;
  if (isPeople) {
    add('jira', 'text', 'builtin', true); // person's Jira account id — a real field here
    add('role', 'text', 'builtin');
    add('region', 'text', 'builtin');
    add('team', 'text', 'builtin');
    add('capacity', 'number', 'builtin');
    add('active', 'boolean', 'builtin');
  }

  // the category's template frontmatter declares expected fields
  let mapped: string | null = null;
  try {
    mapped = typeForFolder(v, category);
  } catch {
    mapped = null;
  }
  for (const name of new Set([category, mapped].filter(Boolean) as string[])) {
    const tpl = join(v.root, v.config.folders.templates, `${name}.md`);
    if (!existsSync(tpl)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(tpl, 'utf8')).data;
      for (const [k, val] of Object.entries(fm)) add(k, kindOf(val), 'template');
    } catch {
      /* unreadable template */
    }
  }

  // keys already used by notes in this category
  const seen = v.indexer.db
    .prepare(
      `SELECT p.key, COUNT(*) AS n FROM properties p JOIN notes n ON n.path = p.path
       WHERE n.path LIKE ? AND n.protected = 0
       GROUP BY p.key ORDER BY n DESC LIMIT 12`,
    )
    .all(`${category}/%`) as { key: string }[];
  for (const row of seen) {
    const sample = v.indexer.db
      .prepare('SELECT value_json FROM properties WHERE key = ? AND path LIKE ? LIMIT 1')
      .get(row.key, `${category}/%`) as { value_json: string } | undefined;
    let kind: CategoryField['kind'] = 'text';
    try {
      kind = kindOf(JSON.parse(sample?.value_json ?? '""'));
    } catch {
      /* text */
    }
    add(row.key, kind, 'seen');
  }

  const sprintOverrides = isPeople
    ? (
        v.indexer.db
          .prepare(
            "SELECT name FROM sprints WHERE state IN ('active','future') ORDER BY state = 'future', start IS NULL, start, id",
          )
          .all() as { name: string }[]
      ).map((r) => r.name)
    : null;

  return { fields: [...fields.values()], sprintOverrides };
}

/** Category = top-level folder. Map a category/type name to its folder. */
export function folderForCategory(v: VaultService, category: string | null): string {
  const f = v.config.folders;
  const c = (category ?? '').trim().toLowerCase();
  if (c === '' || c === 'note' || c === f.notes) return f.notes;
  if (c === 'person' || c === f.people) return f.people;
  if (c === 'daily' || c === f.daily) return f.daily;
  if (c === 'template' || c === f.templates) return f.templates;
  if (c === 'view' || c === 'scenario' || c === f.planning) return f.planning;
  if (c === 'jira' || c === f.jira)
    throw new HttpError(400, 'the jira category is managed by sync');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c))
    throw new HttpError(400, 'category must be alphanumeric (dashes allowed)');
  return c;
}

/** The frontmatter type a note should carry in a given folder (null = none). */
export function typeForFolder(v: VaultService, folder: string): string | null {
  const f = v.config.folders;
  if (folder === f.people) return 'person';
  if (folder === f.notes || folder === f.daily || folder === f.templates || folder === f.planning)
    return null;
  return folder;
}

/**
 * Move a note into a category folder: file move (if needed), type sync, and
 * cross-category parent break. Returns the note's (possibly new) path.
 */
export function applyCategory(
  v: VaultService,
  path: string,
  category: string | null,
  opts: { keepParent?: boolean } = {},
): string {
  const folder = folderForCategory(v, category);
  const currentFolder = path.includes('/') ? (path.split('/')[0] as string) : '';
  let p = path;
  if (folder !== currentFolder) {
    const base = p.split('/').pop() as string;
    const target = `${folder}/${base}`;
    v.move(p, target);
    p = target;
  }
  const { content } = v.read(p);
  let text = content;
  const wanted = typeForFolder(v, folder);
  text = wanted ? setFrontmatterKey(text, 'type', wanted) : deleteFrontmatterKey(text, 'type');
  // Additive template: seed the category's expected fields as blank keys.
  // Existing properties are NEVER removed on a category change.
  const existingKeys = new Set(Object.keys(parseFrontmatter(text).data));
  for (const field of categoryFields(v, folder).fields) {
    if (existingKeys.has(field.key)) continue;
    text = setFrontmatterKey(text, field.key, null).replace(
      new RegExp(`^${field.key.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}: null$`, 'm'),
      `${field.key}:`,
    );
  }
  if (!opts.keepParent) {
    const fm = parseFrontmatter(text).data;
    const rawParent = typeof fm.parent === 'string' ? fm.parent : null;
    if (rawParent) {
      const m = /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/.exec(rawParent.trim());
      const resolved = v.resolve(m ? (m[1] as string).trim() : rawParent);
      const parentFolder = resolved.path.includes('/')
        ? (resolved.path.split('/')[0] as string)
        : '';
      if (!resolved.exists || parentFolder !== folder) {
        text = deleteFrontmatterKey(text, 'parent');
      }
    }
  }
  if (text !== content) v.write(p, text);
  return p;
}

// ------------------------------------------------------------- region hubs
// One source of truth: the person's `region:` property. The app maintains a
// hub note people/<REGION>.md (a note whose own region equals its title,
// active: false so it never appears as a planning row) and keeps person
// parent links pointing at it — so regions show as subfolders in the tree.

function personFm(v: VaultService, path: string): Record<string, unknown> | null {
  try {
    return parseFrontmatter(v.read(path).content).data;
  } catch {
    return null;
  }
}

function hubKind(v: VaultService, path: string): 'region' | 'team' | null {
  if (!path.startsWith(`${v.config.folders.people}/`)) return null;
  const fm = personFm(v, path);
  if (!fm) return null;
  const base = (path.split('/').pop() as string).replace(/\.md$/, '');
  const title = typeof fm.title === 'string' ? fm.title : base;
  const region = typeof fm.region === 'string' ? fm.region.trim() : '';
  const team = typeof fm.team === 'string' ? fm.team.trim() : '';
  if (region && title === region) return 'region';
  if (team && title === team) return 'team';
  return null;
}

export function isRegionHub(v: VaultService, path: string): boolean {
  return hubKind(v, path) === 'region';
}

function hubPath(v: VaultService, name: string): string {
  return `${v.config.folders.people}/${name.replace(/[\\/:*?"<>|]/g, '-')}.md`;
}

function ensureHub(v: VaultService, name: string, kind: 'region' | 'team'): string {
  const rel = hubPath(v, name);
  v.create(
    rel,
    name,
    `---\ntitle: ${JSON.stringify(name)}\n${kind}: ${JSON.stringify(name)}\nactive: false\n---\n\n# ${name}\n\n`,
  );
  return rel;
}

function parentHubOf(v: VaultService, fm: Record<string, unknown>): string | null {
  const rawParent = typeof fm.parent === 'string' ? fm.parent : null;
  if (!rawParent) return null;
  const m = /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/.exec(rawParent.trim());
  const resolved = v.resolve(m ? (m[1] as string).trim() : rawParent);
  if (!resolved.exists) return null;
  return hubKind(v, resolved.path) ? resolved.path : null;
}

/**
 * region/team properties → hub notes + parent links.
 * People nest under their team hub; team hubs nest under the region hub; a
 * person with a region but no team nests directly under the region hub.
 */
export function syncRegionParent(v: VaultService, path: string): void {
  const people = v.config.folders.people;
  if (!path.startsWith(`${people}/`)) return;
  const selfKind = hubKind(v, path);
  const fm = personFm(v, path);
  if (!fm) return;
  const region = typeof fm.region === 'string' ? fm.region.trim() : '';
  const team = typeof fm.team === 'string' ? fm.team.trim() : '';

  if (selfKind === 'region') return;
  if (selfKind === 'team') {
    // a team hub itself nests under its region hub when known
    const { content } = v.read(path);
    let text = content;
    if (region) {
      const regionHub = ensureHub(v, region, 'region');
      text = setFrontmatterKey(text, 'parent', `[[${regionHub.replace(/\.md$/, '')}]]`);
    }
    if (text !== content) v.write(path, text);
    return;
  }

  const { content } = v.read(path);
  let text = content;
  if (team) {
    const teamHub = ensureHub(v, team, 'team');
    // keep the team hub's region in sync so it nests under the region hub
    const hubFm = personFm(v, teamHub);
    if (region && hubFm?.region !== region) {
      const hubText = v.read(teamHub).content;
      let ht = setFrontmatterKey(hubText, 'region', region);
      const regionHub = ensureHub(v, region, 'region');
      ht = setFrontmatterKey(ht, 'parent', `[[${regionHub.replace(/\.md$/, '')}]]`);
      if (ht !== hubText) v.write(teamHub, ht);
    }
    text = setFrontmatterKey(text, 'parent', `[[${teamHub.replace(/\.md$/, '')}]]`);
  } else if (region) {
    const regionHub = ensureHub(v, region, 'region');
    text = setFrontmatterKey(text, 'parent', `[[${regionHub.replace(/\.md$/, '')}]]`);
  } else if (parentHubOf(v, fm)) {
    text = deleteFrontmatterKey(text, 'parent');
  }
  if (text !== content) v.write(path, text);
}

/** parent link → region/team properties (dropping a person onto a hub). */
export function adoptRegionFromParent(v: VaultService, path: string): void {
  const people = v.config.folders.people;
  if (!path.startsWith(`${people}/`) || hubKind(v, path)) return;
  const fm = personFm(v, path);
  if (!fm) return;
  const hub = parentHubOf(v, fm);
  if (!hub) return;
  const kind = hubKind(v, hub);
  const hubFm = personFm(v, hub);
  const { content } = v.read(path);
  let text = content;
  if (kind === 'team') {
    const team = typeof hubFm?.team === 'string' ? hubFm.team.trim() : '';
    if (team && fm.team !== team) text = setFrontmatterKey(text, 'team', team);
    const region = typeof hubFm?.region === 'string' ? hubFm.region.trim() : '';
    if (region && fm.region !== region) text = setFrontmatterKey(text, 'region', region);
  } else if (kind === 'region') {
    const region = typeof hubFm?.region === 'string' ? hubFm.region.trim() : '';
    if (region && fm.region !== region) text = setFrontmatterKey(text, 'region', region);
    // dropped directly on a region = out of any team
    if (typeof fm.team === 'string' && fm.team.trim()) text = deleteFrontmatterKey(text, 'team');
  }
  if (text !== content) v.write(path, text);
}

export interface TreeNode {
  path: string;
  title: string;
  type: string;
  order: number | null;
  children: TreeNode[];
}

export interface TreeModel {
  /** top-level folder → root nodes inside it */
  folders: { folder: string; roots: TreeNode[] }[];
}

interface Row {
  path: string;
  title: string;
  type: string;
  frontmatter_json: string;
}

export function buildTree(v: VaultService): TreeModel {
  const db = v.indexer.db;
  const jiraFolder = `${v.config.folders.jira}/`;
  const rows = (
    db
      .prepare(
        `SELECT path, title, type, frontmatter_json FROM notes
         WHERE protected = 0 ORDER BY path`,
      )
      .all() as unknown as Row[]
  ).filter((r) => !r.path.startsWith(jiraFolder) && r.type !== 'jira');

  // parent resolution reuses the links table: kind='property' rows exist for
  // every wikilink-valued property; we need specifically the `parent` key,
  // so resolve from frontmatter through the same resolver the vault uses.
  const nodes = new Map<string, TreeNode & { parentTarget: string | null }>();
  for (const r of rows) {
    const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
    const rawParent = typeof fm.parent === 'string' ? fm.parent : null;
    const m = rawParent ? /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/.exec(rawParent.trim()) : null;
    nodes.set(r.path, {
      path: r.path,
      title: r.title,
      type: r.type,
      order: typeof fm.order === 'number' ? fm.order : null,
      children: [],
      parentTarget: m ? (m[1] as string).trim() : rawParent,
    });
  }

  // attach children; cycle-safe (a cycle participant becomes a root)
  const parentOf = new Map<string, string>();
  for (const [path, node] of nodes) {
    if (!node.parentTarget) continue;
    const resolved = v.resolve(node.parentTarget);
    if (!resolved.exists || !nodes.has(resolved.path) || resolved.path === path) continue;
    parentOf.set(path, resolved.path);
  }
  const isAncestorOf = (candidate: string, of: string): boolean => {
    let cur: string | undefined = of;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === candidate) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  const roots: TreeNode[] = [];
  for (const [path, node] of nodes) {
    const parent = parentOf.get(path);
    if (parent && !isAncestorOf(path, parent)) {
      (nodes.get(parent) as TreeNode).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: TreeNode[]): void => {
    list.sort(
      (a, b) =>
        (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
        a.title.localeCompare(b.title),
    );
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  // group roots by their top-level folder for the sidebar
  const byFolder = new Map<string, TreeNode[]>();
  for (const r of roots) {
    const folder = r.path.includes('/') ? (r.path.split('/')[0] as string) : '';
    const arr = byFolder.get(folder) ?? [];
    arr.push(r);
    byFolder.set(folder, arr);
  }
  return {
    folders: [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, list]) => ({ folder, roots: list })),
  };
}

export function treeRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(buildTree(v)));

  /**
   * Edit note metadata: type (any string), parent (note path/title/null),
   * order. Guards against parenting a note under its own descendant.
   */
  app.put('/meta', async (c) => {
    const body = (await c.req.json()) as {
      path?: string;
      type?: string | null;
      parent?: string | null;
      order?: number | null;
      /** full replacement of frontmatter tags; [] or null clears the key */
      tags?: string[] | null;
      /** generic frontmatter property writes; null deletes a key */
      set?: Record<string, unknown>;
    };
    if (!body.path) throw new HttpError(400, 'path required');
    let workingPath = v.read(body.path).path;
    if (body.type !== undefined) {
      workingPath = applyCategory(v, workingPath, body.type);
    }
    const { content, path } = v.read(workingPath);
    let text = content;

    if (body.parent !== undefined) {
      if (body.parent === null || body.parent === '') {
        text = deleteFrontmatterKey(text, 'parent');
      } else {
        const target = v.resolve(body.parent);
        if (!target.exists) throw new HttpError(404, `parent not found: ${body.parent}`);
        if (target.path === path) throw new HttpError(400, 'a note cannot be its own parent');
        if (isDescendant(v, target.path, path))
          throw new HttpError(400, 'cannot move a note under its own descendant');
        const parentTitle = (
          v.indexer.db.prepare('SELECT title FROM notes WHERE path = ?').get(target.path) as
            | { title: string }
            | undefined
        )?.title;
        text = setFrontmatterKey(text, 'parent', `[[${parentTitle ?? target.path}]]`);
      }
    }

    if (body.tags !== undefined) {
      const cleaned = [
        ...new Set(
          (body.tags ?? [])
            .map((t) => String(t).trim().replace(/^#/, ''))
            .filter((t) => /^[A-Za-z0-9_/-]+$/.test(t)),
        ),
      ];
      text = cleaned.length
        ? setFrontmatterKey(text, 'tags', cleaned)
        : deleteFrontmatterKey(text, 'tags');
    }

    if (body.set !== undefined) {
      const inPeople = path.startsWith(`${v.config.folders.people}/`);
      for (const [key, value] of Object.entries(body.set)) {
        const reserved = RESERVED_PROP_KEYS.has(key) && !(inPeople && key === 'jira');
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || reserved)
          throw new HttpError(400, `cannot set property: ${key}`);
        if (!isPlainValue(value)) throw new HttpError(400, `unsupported value for ${key}`);
        text =
          value === null ? deleteFrontmatterKey(text, key) : setFrontmatterKey(text, key, value);
      }
    }

    if (body.order !== undefined) {
      text =
        body.order === null
          ? deleteFrontmatterKey(text, 'order')
          : setFrontmatterKey(text, 'order', body.order);
    }

    if (text !== content) v.write(path, text);
    if (body.set && ('region' in body.set || 'team' in body.set)) syncRegionParent(v, path);
    if (body.parent !== undefined) adoptRegionFromParent(v, path);
    const fm = parseFrontmatter(v.read(path).content).data;
    return c.json({ ok: true, path, type: fm.type ?? 'note', parent: fm.parent ?? null });
  });

  /**
   * Place a note at a position: under a parent note (nesting) or as a root of
   * a folder group (optionally moving the file into that folder), at `index`
   * among its new siblings. Siblings are renumbered (order = 10, 20, …) so the
   * position sticks.
   */
  app.post('/place', async (c) => {
    const body = (await c.req.json()) as {
      path?: string;
      parent?: string | null; // parent note PATH (not title), or null for root
      folder?: string | null; // required when parent is null
      index?: number;
    };
    if (!body.path) throw new HttpError(400, 'path required');
    const tree = buildTree(v);
    const moving = findNode(tree, body.path);
    if (!moving) throw new HttpError(404, `not in tree: ${body.path}`);
    let path = body.path;

    let siblings: TreeNode[];
    if (body.parent) {
      const parent = findNode(tree, body.parent);
      if (!parent) throw new HttpError(404, `parent not in tree: ${body.parent}`);
      if (parent.path === path) throw new HttpError(400, 'a note cannot be its own parent');
      if (isDescendant(v, parent.path, path))
        throw new HttpError(400, 'cannot move a note under its own descendant');
      siblings = parent.children;
      // no cross-category hierarchy: the child follows the parent's folder
      const parentFolder = parent.path.includes('/') ? (parent.path.split('/')[0] as string) : '';
      path = applyCategory(v, path, parentFolder, { keepParent: true });
      const title = (
        v.indexer.db.prepare('SELECT title FROM notes WHERE path = ?').get(parent.path) as
          | { title: string }
          | undefined
      )?.title;
      const { content } = v.read(path);
      v.write(path, setFrontmatterKey(content, 'parent', `[[${title ?? parent.path}]]`));
      adoptRegionFromParent(v, path);
    } else {
      const folder = body.folder ?? (path.includes('/') ? (path.split('/')[0] as string) : '');
      const group = tree.folders.find((f) => f.folder === folder);
      siblings = group?.roots ?? [];
      // cross-folder drop → move into that category (type synced, parent broken)
      path = applyCategory(v, path, folder || null);
    }

    // renumber: siblings minus the moved note, insert at index
    const list = siblings.filter((s) => s.path !== body.path && s.path !== path);
    const idx = Math.max(0, Math.min(body.index ?? list.length, list.length));
    const ordered = [
      ...list.slice(0, idx).map((n) => n.path),
      path,
      ...list.slice(idx).map((n) => n.path),
    ];
    const orderOf = new Map(siblings.map((n) => [n.path, n.order]));
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i] as string;
      const want = (i + 1) * 10;
      if (orderOf.get(p) === want) continue;
      const { content } = v.read(p);
      v.write(p, setFrontmatterKey(content, 'order', want));
    }
    return c.json({ ok: true, path, index: idx });
  });

  return app;
}

/** Is `candidate` a descendant of `of` in the current tree? */
function isDescendant(v: VaultService, candidate: string, of: string): boolean {
  const walk = (node: TreeNode): boolean => node.path === candidate || node.children.some(walk);
  const start = findNode(buildTree(v), of);
  return start ? start.children.some(walk) : false;
}

function findNode(tree: TreeModel, path: string): TreeNode | null {
  const stack = tree.folders.flatMap((f) => f.roots);
  while (stack.length) {
    const n = stack.pop() as TreeNode;
    if (n.path === path) return n;
    stack.push(...n.children);
  }
  return null;
}

const RESERVED_PROP_KEYS = new Set([
  'id',
  'type',
  'title',
  'parent',
  'order',
  'tags',
  'created',
  'updated',
  'template',
  'aliases',
  'jira',
  'plan',
  'key',
]);

/** scalars, arrays of scalars, or flat records of scalars */
function isPlainValue(v: unknown): boolean {
  const scalar = (x: unknown) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
  if (scalar(v)) return true;
  if (Array.isArray(v)) return v.every(scalar);
  if (typeof v === 'object' && v !== null) return Object.values(v).every(scalar);
  return false;
}
