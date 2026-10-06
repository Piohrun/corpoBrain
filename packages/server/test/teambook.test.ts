import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TeambookSnapshot } from '@corpobrain/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { type StoredPlan, TeambookService } from '../src/teambook-service.ts';
import { VaultService } from '../src/vault-service.ts';

const SNAPSHOT: TeambookSnapshot = {
  version: 1,
  fetchedAt: '2026-10-06T10:00:00Z',
  rootId: 'D1',
  pods: [
    {
      id: 'D1',
      name: 'Trading Technology',
      parentId: null,
      kind: 'department',
      status: null,
      mandate: null,
    },
    {
      id: 'P-EXE',
      name: 'Execution Services',
      parentId: 'D1',
      kind: 'pod',
      status: 'active',
      mandate: 'Their words',
    },
    {
      id: 'P-MD',
      name: 'Market Data',
      parentId: 'D1',
      kind: 'pod',
      status: 'active',
      mandate: null,
    },
  ],
  users: [
    {
      id: 'U-ANNA',
      name: 'Anna Kowalska',
      email: 'anna@bank.com',
      role: 'Engineering Manager',
      country: 'PL',
      active: true,
    },
    {
      id: 'U-NINA',
      name: 'Nina New',
      email: 'nina@bank.com',
      role: null,
      country: null,
      active: true,
    },
  ],
  memberships: [
    { podId: 'P-EXE', userId: 'U-ANNA', primary: true, lead: true },
    { podId: 'P-MD', userId: 'U-NINA', primary: true, lead: false },
  ],
};

const FILES: Record<string, string> = {
  'organization/trading.md':
    '---\ntype: org_unit\ntitle: Trading Technology\norg_kind: department\n---\n# Trading\n',
  'organization/execution.md':
    '---\ntype: org_unit\ntitle: Execution Services\norg_kind: pod\nparent: "[[organization/trading]]"\nmandate: My own words\n---\n# Execution\n\nKeep me.\n',
  'people/anna.md':
    '---\ntype: person\ntitle: Anna Kowalska\nemail: anna@bank.com\nrole: Lead\n---\nNotes.\n',
};

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const write = (p: string, text: string) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};

beforeEach(() => {
  root = join(tmpdir(), `cb-tb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [p, text] of Object.entries(FILES)) write(p, text);
  write('.corpobrain/teambook-cache/fixture.json', JSON.stringify(SNAPSHOT));
  vault = new VaultService(root, ':memory:');
  vault.indexer.rebuild();
  app = createApp(vault);
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const json = async (res: Response) => {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
};
const post = (path: string, body: unknown = {}) =>
  app.request(`/api/teambook${path}`, { method: 'POST', body: JSON.stringify(body) });

async function preview(service: TeambookService, source: 'api' | 'fixture' = 'fixture') {
  await service.preview(source).completion;
  return service.currentPlan() as StoredPlan;
}
const selected = (stored: StoredPlan) =>
  stored.plan.changes.filter((c) => c.selected).map((c) => c.id);

describe('Teambook import', () => {
  it('previews without touching notes, applies a selection, and re-imports as a no-op', async () => {
    const service = new TeambookService(vault);
    const original = Object.keys(FILES).map(read);
    const stored = await preview(service);
    expect(Object.keys(FILES).map(read)).toEqual(original);
    expect(service.history[0]).toMatchObject({
      outcome: 'success',
      reports: [{ pods: 3, people: 2, source: 'fixture' }],
    });
    expect(Object.fromEntries(stored.plan.changes.map((c) => [c.id, c.status]))).toEqual({
      'unit:D1:link': 'link',
      'unit:P-EXE:link': 'link',
      'unit:P-EXE:leads': 'add',
      'unit:P-EXE:status': 'fill',
      'unit:P-EXE:mandate': 'conflict',
      'unit:P-MD:create': 'new',
      'person:U-ANNA:link': 'link',
      'person:U-ANNA:role': 'conflict',
      'person:U-ANNA:country': 'fill',
      'person:U-ANNA:primary_pod': 'fill',
      'person:U-NINA:create': 'new',
    });

    const result = await service.apply(stored.id, selected(stored), ['person:U-ANNA:role']);
    expect(result.skipped).toEqual([]);
    const execution = read('organization/execution.md');
    expect(execution).toContain(
      'mandate: My own words\nteambook_id: P-EXE\nleads:\n  - "[[people/anna]]"\nstatus: active\n---\n# Execution\n\nKeep me.\n',
    );
    expect(read('people/anna.md')).toContain('role: Lead\n');
    expect(read('people/nina-new.md')).toContain('primary_pod: "[[organization/market-data]]"');
    // the organization map sees the imported structure
    const org = await json(await app.request('/api/organization'));
    expect((org.problems as unknown[]).length).toBe(0);

    // the same Teambook data again: nothing left to do but the conflict you kept
    const again = await preview(service);
    expect(selected(again)).toEqual([]);
    expect(again.plan.changes.map((c) => [c.id, c.status])).toEqual([
      ['unit:P-EXE:mandate', 'conflict'],
      ['person:U-ANNA:role', 'dismissed'],
    ]);
  });

  it('undoes an import, except for notes edited since', async () => {
    const original = Object.fromEntries(Object.keys(FILES).map((p) => [p, read(p)]));
    const service = new TeambookService(vault);
    const stored = await preview(service);
    const { id } = await service.apply(stored.id, selected(stored), []);
    write(
      'organization/execution.md',
      `${read('organization/execution.md')}\nAdded after import.\n`,
    );
    const undo = service.undo(id);
    expect(undo.kept).toEqual([
      { path: 'organization/execution.md', reason: 'edited since the import' },
    ]);
    expect(undo.restored.sort()).toEqual([
      'organization/market-data.md',
      'organization/trading.md',
      'people/anna.md',
      'people/nina-new.md',
    ]);
    expect(read('people/anna.md')).toBe(original['people/anna.md']);
    expect(existsSync(join(root, 'people/nina-new.md'))).toBe(false); // in .trash
    expect(service.baseline()).toEqual({ version: 1, unit: {}, person: {}, dismissed: {} });
    expect(() => service.undo(id)).toThrow('already undone');
  });

  it('writes nothing when the result would break the organization map', async () => {
    // Market Data already exists, tied to another Teambook id, and someone links it by title.
    write(
      'organization/md-old.md',
      '---\ntype: org_unit\ntitle: Market Data\norg_kind: pod\nteambook_id: OLD-MD\n---\n',
    );
    write(
      'people/zoe.md',
      '---\ntype: person\ntitle: Zoe\nsecondary_pods: ["[[Market Data]]"]\n---\n',
    );
    vault.indexer.rebuild();
    const service = new TeambookService(vault);
    const stored = await preview(service);
    const before = Object.keys(FILES).map(read);
    await expect(service.apply(stored.id, selected(stored), [])).rejects.toThrow(
      /Nothing was written.*people\/zoe\.md secondary_pods/,
    );
    expect(Object.keys(FILES).map(read)).toEqual(before);
    expect(existsSync(join(root, 'organization/market-data.md'))).toBe(false);
    // deselecting the create (and what depends on it) goes through
    const rest = selected(stored).filter(
      (id) => !['unit:P-MD:create', 'person:U-NINA:create'].includes(id),
    );
    expect((await service.apply(stored.id, rest, [])).written.length).toBeGreaterThan(0);
  });

  it('refuses a stale preview and keeps the token out of errors', async () => {
    const service = new TeambookService(vault, async () => {
      throw new Error('GET /pods?token=S3CRET failed');
    });
    await expect(service.apply('nope', [], [])).rejects.toThrow('out of date');
    write('.corpobrain/secrets.json', JSON.stringify({ teambookToken: 'S3CRET' }));
    await expect(service.preview('api').completion).rejects.toThrow();
    expect(service.history[0]?.error).toBe('GET /pods?token=[redacted] failed');
  });

  it('says plainly when the adapter is not completed yet', async () => {
    const res = await app.request('/api/teambook/config', {
      method: 'PUT',
      body: JSON.stringify({
        baseUrl: 'https://teambook.example.com/api/',
        rootPodId: 'D1',
        token: 'T',
      }),
    });
    expect(await json(res)).toMatchObject({
      baseUrl: 'https://teambook.example.com/api',
      rootPodId: 'D1',
      tokenSet: true,
      adapterReady: false,
      fixtureFound: true,
    });
    expect(JSON.stringify(JSON.parse(read('.corpobrain/config.json')))).not.toContain('"token"');
    await json(await post('/preview', { source: 'api' }));
    const service = new TeambookService(vault);
    await vi.waitFor(() => expect(service.history[0]?.outcome).toBe('failed'));
    expect(service.history[0]?.error).toContain('Teambook adapter not completed');
    expect(
      (await app.request('/api/teambook/config', { method: 'PUT', body: '{"baseUrl":"ftp://x"}' }))
        .status,
    ).toBe(400);
  });
});
