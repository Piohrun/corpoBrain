/** Person overview: derived panels for type:person notes (workload, issues,
 *  dated backlink trail, tasks that mention them). Read-only composition of
 *  data the index already holds. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { type BoardIssue, type BoardPerson, buildBoard } from './plan-routes.ts';
import { HttpError, type VaultService } from './vault-service.ts';

export interface PersonMention {
  srcPath: string;
  srcTitle: string;
  mtime: number;
  line: number;
  snippet: string;
}

export interface PersonOverview {
  person: BoardPerson;
  unit: string;
  columns: string[];
  issues: BoardIssue[];
  mentions: PersonMention[];
  tasks: { path: string; line: number; text: string; due: string | null; title: string }[];
}

export function personOverview(v: VaultService, path: string): PersonOverview {
  const board = buildBoard(v);
  const person = board.people.find((p) => p.path === path);
  if (!person) throw new HttpError(404, `not a person note: ${path}`);

  const ids = new Set(person.jiraIds);
  const issues = board.issues.filter(
    (i) => i.effectiveAssignee !== null && ids.has(i.effectiveAssignee),
  );

  const db = v.indexer.db;
  const rows = db
    .prepare(
      `SELECT l.src_path AS srcPath, n.title AS srcTitle, n.mtime, MIN(l.line) AS line
       FROM links l JOIN notes n ON n.path = l.src_path
       WHERE l.dst_path = ? AND l.src_path != ?
       GROUP BY l.src_path ORDER BY n.mtime DESC LIMIT 30`,
    )
    .all(path, path) as { srcPath: string; srcTitle: string; mtime: number; line: number }[];
  const mentions: PersonMention[] = rows.map((r) => {
    let snippet = '';
    try {
      const lines = readFileSync(join(v.root, r.srcPath), 'utf8').split('\n');
      snippet = (lines[r.line - 1] ?? '').trim().slice(0, 160);
    } catch {
      /* unreadable */
    }
    return { ...r, snippet };
  });

  const tasks = db
    .prepare(
      `SELECT DISTINCT t.path, t.line, t.text, t.due, n.title
       FROM tasks t
       JOIN links l ON l.src_path = t.path AND l.line = t.line
       JOIN notes n ON n.path = t.path
       WHERE l.dst_path = ? AND t.done = 0
       ORDER BY t.due IS NULL, t.due LIMIT 20`,
    )
    .all(path) as { path: string; line: number; text: string; due: string | null; title: string }[];

  return { person, unit: board.unit, columns: board.columns, issues, mentions, tasks };
}

export function personRoutes(v: VaultService): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'path required');
    return c.json(personOverview(v, path));
  });
  return app;
}
