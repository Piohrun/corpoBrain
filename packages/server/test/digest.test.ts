import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { DigestResponse } from '../src/digest-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

const event = (at: string, key: string, kind: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    at,
    profile: 'team',
    key,
    kind,
    from: null,
    to: null,
    summary: `${key} summary`,
    assignee: 'anna',
    assigneeName: 'Anna',
    sprint: 'Sprint 37',
    statusCategory: 'new',
    ...extra,
  });

beforeEach(() => {
  root = join(tmpdir(), `cb-digest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'jira'), { recursive: true });
  mkdirSync(join(root, 'people'), { recursive: true });
  mkdirSync(join(root, '.corpobrain', 'jira-cache'), { recursive: true });
  writeFileSync(
    join(root, 'jira', 'EXEC-1.md'),
    '---\ntype: jira\nkey: EXEC-1\nsummary: One\nurl: https://j/browse/EXEC-1\n---\n\n<!-- jira:end -->\n',
  );
  writeFileSync(
    join(root, 'people', 'anna.md'),
    '---\ntype: person\ntitle: Anna\njira: anna\n---\n',
  );
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'digest.jsonl'),
    `${[
      event('2026-08-20T09:00:00Z', 'EXEC-1', 'created'),
      event('2026-08-31T09:00:00Z', 'EXEC-1', 'status'),
      event('2026-08-31T09:00:00Z', 'EXEC-2', 'assignee'),
      'not json at all',
      '',
    ].join('\n')}\n`,
  );
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'state.json'),
    JSON.stringify({ watermarks: {}, lastSyncAt: { team: '2026-08-31T09:00:00Z' } }),
  );
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

const get = async (q = ''): Promise<DigestResponse> =>
  (await (await app.request(`/api/digest${q}`)).json()) as DigestResponse;

describe('GET /api/digest', () => {
  it('defaults to the last refresh only, newest first', async () => {
    const body = await get();
    expect(body.range).toBe('last');
    expect(body.since).toBe('2026-08-31T09:00:00Z');
    expect(body.events).toHaveLength(2);
    expect(body.counts).toEqual({ status: 1, assignee: 1 });
  });

  it('returns everything, ignoring torn lines', async () => {
    const body = await get('?range=all');
    expect(body.events).toHaveLength(3);
    expect(body.events[0]?.at).toBe('2026-08-31T09:00:00Z');
  });

  it('filters by a time window', async () => {
    expect((await get('?range=30d')).events.length).toBeGreaterThanOrEqual(2);
    const today = await get('?range=today');
    expect(today.events.every((e) => e.at >= (today.since as string))).toBe(true);
  });

  it('groups refreshes and reports when each profile last synced', async () => {
    const body = await get('?range=all');
    expect(body.runs).toEqual([
      { at: '2026-08-31T09:00:00Z', count: 2 },
      { at: '2026-08-20T09:00:00Z', count: 1 },
    ]);
    expect(body.lastSync).toEqual([{ profile: 'team', at: '2026-08-31T09:00:00Z' }]);
  });

  it('resolves issue and person notes so rows are clickable', async () => {
    const body = await get('?range=all');
    expect(body.paths['EXEC-1']).toBe('jira/EXEC-1.md');
    expect(body.paths['EXEC-2']).toBeUndefined(); // not mirrored yet
    expect(body.people.anna).toEqual({ name: 'Anna', path: 'people/anna.md' });
  });

  it('is empty and harmless on a vault that has never synced', async () => {
    rmSync(join(root, '.corpobrain', 'jira-cache'), { recursive: true, force: true });
    const body = await get();
    expect(body.events).toEqual([]);
    expect(body.since).toBeNull();
    expect(body.lastSync).toEqual([]);
  });
});
