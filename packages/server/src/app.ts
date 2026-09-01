import { SPEC_VERSION } from '@corpobrain/core';
import { Hono } from 'hono';
import { availabilityRoutes } from './availability-routes.ts';
import { digestRoutes } from './digest-routes.ts';
import { gitFor } from './git-service.ts';
import { jiraRoutes } from './jira-routes.ts';
import { objectRoutes, taskRoutes } from './object-routes.ts';
import { personRoutes } from './person-routes.ts';
import { planRoutes } from './plan-routes.ts';
import { privateRoutes } from './private-routes.ts';
import { projectRoutes } from './project-routes.ts';
import { treeRoutes } from './tree-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * Local-only guard. The server binds to 127.0.0.1, but a browser will still
 * happily send a cross-site POST there from any web page (Hono's `c.req.json()`
 * does not care about Content-Type, so the request is a "simple" one and needs
 * no CORS preflight). Reject anything that is not clearly our own page:
 *  - the request URL's host must be a loopback name (defeats DNS rebinding);
 *  - if the browser sent an Origin, it must be loopback too;
 *  - if the browser flagged the fetch as cross-site, refuse it.
 */
function isTrustedRequest(c: { req: { url: string; header: (n: string) => string | undefined } }): {
  ok: boolean;
  reason?: string;
} {
  let host: string;
  try {
    host = new URL(c.req.url).hostname;
  } catch {
    return { ok: false, reason: 'bad url' };
  }
  if (!isLoopbackHost(host)) return { ok: false, reason: `host ${host} is not loopback` };
  const origin = c.req.header('origin');
  if (origin) {
    try {
      if (!isLoopbackHost(new URL(origin).hostname))
        return { ok: false, reason: `origin ${origin} is not loopback` };
    } catch {
      return { ok: false, reason: `origin ${origin} is not a url` };
    }
  }
  const site = c.req.header('sec-fetch-site');
  if (site === 'cross-site') return { ok: false, reason: 'cross-site request' };
  return { ok: true };
}

export function createApp(vault?: VaultService) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const trust = isTrustedRequest(c);
    if (!trust.ok) return c.json({ error: `forbidden: ${trust.reason}` }, 403);
    await next();
  });

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
    const tagRows = v.indexer.db
      .prepare('SELECT tag FROM tags WHERE path = ? ORDER BY tag')
      .all(note.path) as { tag: string }[];
    // resolution per link target: resolved = points at a note that EXISTS
    // (a Jira key always gets a dst_path, so check the notes table too)
    const linkRows = v.indexer.db
      .prepare(
        `SELECT DISTINCT l.dst_target AS target,
                (l.dst_path IS NOT NULL AND n.path IS NOT NULL) AS resolved
         FROM links l LEFT JOIN notes n ON n.path = l.dst_path
         WHERE l.src_path = ? AND l.dst_target != ''`,
      )
      .all(note.path) as { target: string; resolved: number }[];
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
      tags: tagRows.map((t) => t.tag),
      links: linkRows.map((l) => ({ target: l.target, resolved: l.resolved === 1 })),
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
        `SELECT t.path, t.line, t.text, t.done, t.due, t.kind, n.title
         FROM tasks t JOIN notes n ON n.path = t.path
         ${done === undefined ? '' : 'WHERE t.done = ?'}
         ORDER BY t.due IS NULL, t.due, t.path, t.line`,
      )
      .all(...(done === undefined ? [] : [done === 'true' ? 1 : 0]));
    return c.json(rows);
  });

  app.get('/api/unresolved', (c) => c.json(v.indexer.unresolved()));

  app.get('/api/history', async (c) => {
    return c.json(await gitFor(v.root).log(Number(c.req.query('limit') ?? 20)));
  });

  app.get('/api/git/status', async (c) => {
    const git = gitFor(v.root);
    return c.json({
      ...(await git.status()),
      autoCommit: v.config.git.autoCommit,
      intervalMinutes: v.config.git.intervalMinutes,
    });
  });

  /** Initialize the vault repo (if needed) and commit everything now. */
  app.post('/api/git/commit', async (c) => {
    const git = gitFor(v.root);
    const ok = await git.ensureRepo();
    if (!ok) throw new HttpError(502, git.lastError ?? 'git is not available');
    const hash = await git.commitAll('vault: manual commit');
    if (git.lastError) throw new HttpError(502, git.lastError);
    return c.json({ ok: true, hash });
  });

  app.route('/api/jira', jiraRoutes(v));
  app.route('/api/plan', planRoutes(v));
  app.route('/api/digest', digestRoutes(v));
  app.route('/api/availability', availabilityRoutes(v));
  app.route('/api/projects', projectRoutes(v));
  app.route('/api/person', personRoutes(v));
  app.route('/api/objects', objectRoutes(v));
  app.route('/api/private', privateRoutes(v).app);
  app.route('/api/tree', treeRoutes(v));
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
