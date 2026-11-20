/**
 * The work log (core/work.ts) for the UI: the branches agents have reported
 * on, and the few fields the user changes from the app. Reports themselves
 * arrive as file writes from the CLI or the MCP server and reach open pages
 * through the vault watcher like any other edit.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyWorkPatch,
  isWorkStage,
  isWorkWaiting,
  WORK_STAGES,
  WORK_WAITING,
  WorkError,
  type WorkItem,
  type WorkPatch,
  workAgentInstructions,
  workItemFromFrontmatter,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

/** Every work note, from the index. */
export function listWork(v: VaultService): WorkItem[] {
  const rows = v.indexer.db
    .prepare(
      "SELECT path, title, frontmatter_json FROM notes WHERE type = 'work' AND protected = 0 ORDER BY path",
    )
    .all() as { path: string; title: string; frontmatter_json: string }[];
  return rows.map((r) => {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
    } catch {
      // a note whose properties cannot be read still shows, with defaults
    }
    return workItemFromFrontmatter(r.path, r.title, fm);
  });
}

const here = dirname(fileURLToPath(import.meta.url));
/** The CLI that sits beside this server: bundled in dist/, or the source file in a checkout. */
export function cliPath(): string {
  return basename(here) === 'dist'
    ? join(here, 'corpobrain-cli.js')
    : join(here, '..', '..', 'cli', 'src', 'index.ts');
}

export function workRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(listWork(v)));

  /** What to paste into a repository's agent instructions, with this machine's paths. */
  app.get('/instructions', (c) =>
    c.json({ text: workAgentInstructions(cliPath(), v.root), cli: cliPath(), vault: v.root }),
  );

  /** Stage, whose move it is, the next step and the target branches: the user's edits. */
  app.put('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.path !== 'string') throw new HttpError(400, 'path required');
    const path = v.safePath(body.path);
    const known = v.indexer.db.prepare('SELECT type FROM notes WHERE path = ?').get(path) as
      | { type: string }
      | undefined;
    if (!known) throw new HttpError(404, `no such note: ${path}`);
    if (known.type !== 'work') throw new HttpError(400, `${path} is not a work note`);
    const patch: WorkPatch = {};
    if (body.stage !== undefined) {
      if (!isWorkStage(body.stage))
        throw new HttpError(400, `stage must be one of: ${WORK_STAGES.join(', ')}`);
      patch.stage = body.stage;
    }
    if (body.waitingOn !== undefined) {
      if (!isWorkWaiting(body.waitingOn))
        throw new HttpError(400, `waitingOn must be one of: ${WORK_WAITING.join(', ')}`);
      patch.waitingOn = body.waitingOn;
    }
    for (const key of ['next', 'uatBranch', 'releaseBranch', 'pr'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (value !== null && typeof value !== 'string')
        throw new HttpError(400, `${key} must be text, or null to clear it`);
      patch[key] = value;
    }
    try {
      v.patchNote(path, (content) => applyWorkPatch(content, patch, new Date()));
    } catch (e) {
      if (e instanceof WorkError) throw new HttpError(409, e.message);
      throw e;
    }
    v.notifyPathsChanged([path]);
    const item = listWork(v).find((w) => w.path === path);
    return c.json(item ?? null);
  });

  return app;
}
