/** Typed-object views and task roll-up (Phase 5). */
import { Hono } from 'hono';
import { categoryFields } from './tree-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

export type { CategoryField } from './tree-routes.ts';
export { categoryFields } from './tree-routes.ts';

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
    // `- [ ]`, `- j[ ]` (jira to create), and the `- [j]` shorthand
    const m = /^(\s*[-*+] [jJ]?\[)( |x|X)(\] )/.exec(line);
    if (m) {
      lines[idx] = line.replace(
        /^(\s*[-*+] [jJ]?\[)( |x|X)(\] )/,
        `$1${m[2] === ' ' ? 'x' : ' '}$3`,
      );
      v.write(body.path, lines.join(''));
      return c.json({ ok: true, done: m[2] === ' ' });
    }
    const alt = /^(\s*[-*+] )\[[jJ]\](\s)/.exec(line);
    if (!alt) throw new HttpError(409, 'not a task line — note changed?');
    // ticking the shorthand normalises it to the canonical jira form
    lines[idx] = line.replace(/^(\s*[-*+] )\[[jJ]\](\s)/, '$1j[x]$2');
    v.write(body.path, lines.join(''));
    return c.json({ ok: true, done: true });
  });

  return app;
}
