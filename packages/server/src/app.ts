import { SPEC_VERSION } from '@corpobrain/core';
import { Hono } from 'hono';
import { GitService } from './git-service.ts';
import { jiraRoutes } from './jira-routes.ts';
import { objectRoutes, taskRoutes } from './object-routes.ts';
import { planRoutes } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

export function createApp(vault?: VaultService) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/api/health', (c) =>
    c.json({ ok: true, spec: SPEC_VERSION, vault: vault ? vault.root : null }),
  );

  if (!vault) return app;
  const v = vault;

  app.get('/api/notes', (c) => c.json(v.list()));

  app.get('/api/note', (c) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'path required');
    const note = v.read(path);
    const meta = v.indexer.db
      .prepare('SELECT id, type, title, frontmatter_json FROM notes WHERE path = ?')
      .get(note.path) as Record<string, unknown> | undefined;
    return c.json({
      ...note,
      meta: meta
        ? {
            id: meta.id,
            type: meta.type,
            title: meta.title,
            frontmatter: JSON.parse(meta.frontmatter_json as string),
          }
        : null,
      backlinks: v.indexer.backlinks(note.path),
    });
  });

  app.put('/api/note', async (c) => {
    const { path, content } = (await c.req.json()) as { path?: string; content?: string };
    if (!path || typeof content !== 'string') throw new HttpError(400, 'path and content required');
    const summary = v.write(path, content);
    return c.json({ ok: true, idsAssigned: summary.idsAssigned });
  });

  app.post('/api/note', async (c) => {
    const { path, title, type } = (await c.req.json()) as {
      path?: string;
      title?: string;
      type?: string;
    };
    if (!path) throw new HttpError(400, 'path required');
    return c.json(
      v.create(path, title ?? path.replace(/^.*\//, '').replace(/\.md$/, ''), undefined, type),
    );
  });

  app.delete('/api/note', (c) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'path required');
    v.delete(path);
    return c.json({ ok: true });
  });

  app.get('/api/resolve', (c) => {
    const target = c.req.query('target');
    if (!target) throw new HttpError(400, 'target required');
    return c.json(v.resolve(target));
  });

  app.post('/api/daily', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { date?: string };
    return c.json(v.openDaily(body.date));
  });

  app.get('/api/search', (c) => {
    const q = c.req.query('q') ?? '';
    return c.json(v.indexer.search(q, Number(c.req.query('limit') ?? 20)));
  });

  app.get('/api/backlinks', (c) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'path required');
    return c.json(v.indexer.backlinks(path));
  });

  app.get('/api/tags', (c) =>
    c.json(
      v.indexer.db
        .prepare('SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag')
        .all(),
    ),
  );

  app.get('/api/tag', (c) => {
    const tag = c.req.query('tag');
    if (!tag) throw new HttpError(400, 'tag required');
    return c.json(
      v.indexer.db
        .prepare(
          `SELECT t.path, n.title FROM tags t JOIN notes n ON n.path = t.path
           WHERE t.tag = ? ORDER BY t.path`,
        )
        .all(tag.toLowerCase()),
    );
  });

  app.get('/api/tasks', (c) => {
    const done = c.req.query('done');
    const rows = v.indexer.db
      .prepare(
        `SELECT t.path, t.line, t.text, t.done, t.due, n.title
         FROM tasks t JOIN notes n ON n.path = t.path
         ${done === undefined ? '' : 'WHERE t.done = ?'}
         ORDER BY t.due IS NULL, t.due, t.path, t.line`,
      )
      .all(...(done === undefined ? [] : [done === 'true' ? 1 : 0]));
    return c.json(rows);
  });

  app.get('/api/unresolved', (c) => c.json(v.indexer.unresolved()));

  app.get('/api/history', async (c) => {
    const git = new GitService(v.root);
    return c.json(await git.log(Number(c.req.query('limit') ?? 20)));
  });

  app.route('/api/jira', jiraRoutes(v));
  app.route('/api/plan', planRoutes(v));
  app.route('/api/objects', objectRoutes(v));
  app.route('/api/task', taskRoutes(v));

  // Server-sent events: notify the UI when files change externally.
  app.get('/api/events', () => {
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (paths: string[]) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ paths })}\n\n`));
        controller.enqueue(enc.encode(': connected\n\n'));
        const off = v.onChange(send);
        const ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 30000);
        cleanup = () => {
          off();
          clearInterval(ping);
        };
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}
