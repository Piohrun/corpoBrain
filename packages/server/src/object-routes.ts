/** Typed-object views and task roll-up (Phase 5). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '@corpobrain/core';
import { Hono } from 'hono';
import { typeForFolder } from './tree-routes.ts';
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
  const add = (key: string, kind: CategoryField['kind'], source: CategoryField['source']) => {
    if (!fields.has(key) && !FIELD_EXCLUDED.has(key)) fields.set(key, { key, kind, source });
  };

  const isPeople = category === v.config.folders.people;
  if (isPeople) {
    add('jira', 'text', 'builtin');
    add('role', 'text', 'builtin');
    add('region', 'text', 'builtin');
    add('team', 'text', 'builtin');
    add('capacity', 'number', 'builtin');
    add('active', 'boolean', 'builtin');
  }

  // template frontmatter defines the category's fields
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

export function objectRoutes(v: VaultService): Hono {
  const app = new Hono();

  /** Editable field suggestions for a category (Organize panel schema). */
  app.get('/fields', (c) => {
    const category = c.req.query('category');
    if (!category) throw new HttpError(400, 'category required');
    return c.json(categoryFields(v, category));
  });

  /** Distinct types with counts (excluding plumbing types). */
  app.get('/types', (c) =>
    c.json(
      v.indexer.db
        .prepare(
          `SELECT type, COUNT(*) AS count FROM notes
           WHERE protected = 0 AND type NOT IN ('view')
           GROUP BY type ORDER BY count DESC, type`,
        )
        .all(),
    ),
  );

  /** All notes of a type, with parsed frontmatter for table columns. */
  app.get('/list', (c) => {
    const type = c.req.query('type');
    if (!type) throw new HttpError(400, 'type required');
    const rows = v.indexer.db
      .prepare(
        `SELECT path, title, mtime, frontmatter_json FROM notes
         WHERE type = ? AND protected = 0 ORDER BY title COLLATE NOCASE`,
      )
      .all(type) as { path: string; title: string; mtime: number; frontmatter_json: string }[];
    return c.json(
      rows.map((r) => ({
        path: r.path,
        title: r.title,
        mtime: r.mtime,
        frontmatter: JSON.parse(r.frontmatter_json) as Record<string, unknown>,
      })),
    );
  });

  return app;
}

export function taskRoutes(v: VaultService): Hono {
  const app = new Hono();

  /** Toggle a task checkbox in place, verified against the expected text. */
  app.post('/toggle', async (c) => {
    const body = (await c.req.json()) as { path?: string; line?: number };
    if (!body.path || !body.line) throw new HttpError(400, 'path and line required');
    const { content } = v.read(body.path);
    const lines = content.split(/(?<=\n)/); // keep line endings
    const idx = body.line - 1;
    const line = lines[idx];
    if (line === undefined) throw new HttpError(409, 'line out of range — note changed?');
    const m = /^(\s*[-*+] \[)( |x|X)(\] )/.exec(line);
    if (!m) throw new HttpError(409, 'not a task line — note changed?');
    lines[idx] = line.replace(/^(\s*[-*+] \[)( |x|X)(\] )/, `$1${m[2] === ' ' ? 'x' : ' '}$3`);
    v.write(body.path, lines.join(''));
    return c.json({ ok: true, done: m[2] === ' ' });
  });

  return app;
}
