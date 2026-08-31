/** Change digest: what moved in Jira since the last refresh. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ChangeEvent, DigestStore } from '@corpobrain/core';
import { Hono } from 'hono';
import type { VaultService } from './vault-service.ts';

export interface DigestResponse {
  range: string;
  since: string | null;
  lastSync: { profile: string; at: string }[];
  runs: { at: string; count: number }[];
  counts: Record<string, number>;
  events: ChangeEvent[];
  /** jira key → vault path, so a row can open the mirrored note */
  paths: Record<string, string>;
  /** jira account id → person note */
  people: Record<string, { name: string; path: string }>;
}

function cutoff(range: string, now: Date): string | null {
  const d = new Date(now);
  switch (range) {
    case 'today':
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    case '7d':
      d.setDate(d.getDate() - 7);
      return d.toISOString();
    case '30d':
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    default:
      return null;
  }
}

export function digestRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const cacheDir = join(v.root, '.corpobrain', 'jira-cache');
    const store = new DigestStore(cacheDir);
    const all = store.read();
    const range = c.req.query('range') ?? 'last';

    const runCounts = new Map<string, number>();
    for (const e of all) runCounts.set(e.at, (runCounts.get(e.at) ?? 0) + 1);
    const runs = [...runCounts.entries()].map(([at, count]) => ({ at, count })).slice(0, 30);

    let since: string | null = null;
    let events: ChangeEvent[];
    if (range === 'last') {
      since = runs[0]?.at ?? null;
      events = since ? all.filter((e) => e.at === since) : [];
    } else if (range === 'all') {
      events = all;
    } else {
      since = cutoff(range, new Date());
      events = since ? all.filter((e) => e.at >= (since as string)) : all;
    }
    events = events.slice(0, 2000);

    let lastSync: { profile: string; at: string }[] = [];
    try {
      const state = JSON.parse(readFileSync(join(cacheDir, 'state.json'), 'utf8')) as {
        lastSyncAt?: Record<string, string>;
      };
      lastSync = Object.entries(state.lastSyncAt ?? {}).map(([profile, at]) => ({ profile, at }));
    } catch {
      /* no state yet: never synced */
    }

    const counts: Record<string, number> = {};
    for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;

    const paths: Record<string, string> = {};
    const keys = [...new Set(events.map((e) => e.key))];
    if (keys.length) {
      const rows = v.indexer.db
        .prepare(`SELECT key, path FROM jira WHERE key IN (${keys.map(() => '?').join(',')})`)
        .all(...keys) as { key: string; path: string }[];
      for (const r of rows) paths[r.key] = r.path;
    }

    const people: Record<string, { name: string; path: string }> = {};
    for (const p of v.indexer.db
      .prepare('SELECT path, name, jira_id FROM people WHERE jira_id IS NOT NULL')
      .all() as { path: string; name: string; jira_id: string }[]) {
      for (const id of parseIds(p.jira_id)) people[id] = { name: p.name, path: p.path };
    }

    const body: DigestResponse = { range, since, lastSync, runs, counts, events, paths, people };
    return c.json(body);
  });

  return app;
}

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* plain string id */
  }
  return [raw];
}
