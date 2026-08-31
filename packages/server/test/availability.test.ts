import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { AvailabilityResponse } from '../src/availability-routes.ts';
import { buildBoard } from '../src/plan-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

const TABLE = `---
type: availability
---

# Availability

| Person | From | To | Type | Note |
| --- | --- | --- | --- | --- |
| [[Anna]] | 2026-08-31 | 2026-09-04 | ooo | leave |
| [[Bob]] | 2026-08-31 | 2026-09-11 | support | L2 rota |
| [[Nobody At All]] | 2026-09-01 | 2026-09-02 | ooo | |

## Prose that must survive
`;

beforeEach(() => {
  root = join(tmpdir(), `cb-avail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const d of ['jira', 'people', 'planning', '.corpobrain/jira-cache']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'sprints.json'),
    JSON.stringify([
      { id: 2, name: 'Sprint 37', state: 'active', startDate: '2026-08-31', endDate: '2026-09-11' },
      { id: 3, name: 'Sprint 38', state: 'future', startDate: '2026-09-14', endDate: '2026-09-25' },
    ]),
  );
  writeFileSync(join(root, 'planning', 'availability.md'), TABLE);
  writeFileSync(
    join(root, 'people', 'anna.md'),
    '---\ntype: person\ntitle: Anna\njira: anna\ncapacity: 10\n---\n',
  );
  writeFileSync(
    join(root, 'people', 'bob.md'),
    '---\ntype: person\ntitle: Bob\njira: bob\ncapacity: 10\n---\n',
  );
  writeFileSync(
    join(root, 'jira', 'EXEC-1.md'),
    '---\ntype: jira\nkey: EXEC-1\nsummary: One\nstatus: To Do\nstatus_category: new\nassignee: anna\nsprint: Sprint 37\nestimate: 8\nurl: https://j/browse/EXEC-1\n---\n\n<!-- jira:end -->\n',
  );
  vault = new VaultService(root, ':memory:');
  vault.indexer.loadSprints();
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

const get = async (): Promise<AvailabilityResponse> =>
  (await (await app.request('/api/availability')).json()) as AvailabilityResponse;

describe('GET /api/availability', () => {
  it('reports absence per person per sprint', async () => {
    const body = await get();
    const anna = body.rows.find((r) => r.name === 'Anna' && r.sprint === 'Sprint 37');
    expect(anna).toMatchObject({ ooo: 5, support: 0, total: 10, available: 5, adjusted: 5 });
    const bob = body.rows.find((r) => r.name === 'Bob');
    expect(bob).toMatchObject({ ooo: 0, support: 10, available: 0, adjusted: 0 });
    expect(body.sprints).toEqual(['Sprint 37', 'Sprint 38']);
  });

  it('warns about names that match no person note', async () => {
    const body = await get();
    expect(body.warnings.join(' ')).toContain('Nobody At All');
    expect(body.rows.some((r) => r.name.includes('Nobody'))).toBe(false);
  });
});

describe('bandwidth from availability', () => {
  it('reduces the board capacity for the sprints someone is away', () => {
    const board = buildBoard(vault, new Date('2026-09-01T00:00:00Z'));
    const anna = board.people.find((p) => p.name === 'Anna');
    expect(anna?.capacity).toBe(10); // the base is untouched
    expect(anna?.suggested['Sprint 37']).toBe(5); // half the sprint away
    expect(anna?.suggested['Sprint 38']).toBeUndefined();
    expect(anna?.absence['Sprint 37']).toMatchObject({ ooo: 5, total: 10 });
  });

  it('drives the sprint-health overload check and explains why', async () => {
    const res = await app.request('/api/plan/health?sprint=Sprint%2037');
    const report = (await res.json()) as {
      problems: { kind: string; personName: string | null; detail: string; limit: number | null }[];
    };
    const over = report.problems.find((p) => p.kind === 'overloaded' && p.personName === 'Anna');
    // 8 days of work against 5 days of bandwidth, not the nominal 10
    expect(over?.limit).toBe(5);
    expect(over?.detail).toContain('out of office');
  });

  it('lets a manual per-sprint override win over the suggestion, both ways', async () => {
    const overload = async () => {
      const res = await app.request('/api/plan/health?sprint=Sprint%2037');
      const report = (await res.json()) as { problems: { kind: string; limit: number | null }[] };
      return report.problems.find((p) => p.kind === 'overloaded');
    };
    const setOverride = (n: number) =>
      app.request('/api/plan/person', {
        method: 'PUT',
        body: JSON.stringify({ path: 'people/anna.md', overrides: { 'Sprint 37': n } }),
      });

    // above the 8 days assigned: the person is no longer over, despite the leave
    await setOverride(9);
    expect(await overload()).toBeUndefined();
    // below it: the override, not the 5-day suggestion, is the bar
    await setOverride(4);
    expect((await overload())?.limit).toBe(4);
  });
});

describe('PUT /api/availability', () => {
  it('rewrites the table and leaves the rest of the note alone', async () => {
    const res = await app.request('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({
        entries: [{ person: 'Anna', from: '2026-09-21', to: '2026-09-25', kind: 'ooo', note: 'x' }],
      }),
    });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'planning', 'availability.md'), 'utf8');
    expect(text).toContain('## Prose that must survive');
    expect(text).toContain('| [[Anna]] | 2026-09-21 | 2026-09-25 | ooo | x |');
    expect(text).not.toContain('L2 rota');
    const body = await get();
    expect(body.entries).toHaveLength(1);
    expect(body.rows.find((r) => r.sprint === 'Sprint 38')?.ooo).toBe(5);
  });

  it('creates the note when the vault has none', async () => {
    rmSync(join(root, 'planning', 'availability.md'));
    vault.indexer.rebuild();
    const res = await app.request('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({
        entries: [{ person: 'Bob', from: '2026-09-07', to: '2026-09-07', kind: 'support' }],
      }),
    });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'planning', 'availability.md'), 'utf8');
    expect(text).toContain('type: availability');
    expect(text).toContain('| [[Bob]] | 2026-09-07 | 2026-09-07 | support |');
  });

  it('rejects rows that are not usable', async () => {
    for (const entries of [
      [{ person: '', from: '2026-09-01' }],
      [{ person: 'Anna', from: 'whenever' }],
      [{ person: 'Anna', from: '2026-09-10', to: '2026-09-01' }],
    ]) {
      const res = await app.request('/api/availability', {
        method: 'PUT',
        body: JSON.stringify({ entries }),
      });
      expect(res.status).toBe(400);
    }
    const bad = await app.request('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({ entries: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/availability/archive', () => {
  it('moves old entries into per-year notes and keeps the rest', async () => {
    // add stale entries from two years to the live table
    await app.request('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({
        entries: [
          { person: 'Anna', from: '2024-12-23', to: '2024-12-31', kind: 'ooo', note: 'xmas' },
          { person: 'Bob', from: '2025-03-03', to: '2025-03-07', kind: 'support', note: '' },
          { person: 'Anna', from: '2026-08-31', to: '2026-09-04', kind: 'ooo', note: 'recent' },
        ],
      }),
    });
    const res = await app.request('/api/availability/archive', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: number; files: string[] };
    expect(body.archived).toBe(2);
    expect(body.files.sort()).toEqual([
      'planning/availability-2024.md',
      'planning/availability-2025.md',
    ]);
    const main = readFileSync(join(root, 'planning', 'availability.md'), 'utf8');
    expect(main).toContain('recent');
    expect(main).not.toContain('xmas');
    const y2024 = readFileSync(join(root, 'planning', 'availability-2024.md'), 'utf8');
    expect(y2024).toContain('type: availability-archive');
    expect(y2024).toContain('| [[Anna]] | 2024-12-23 | 2024-12-31 | ooo | xmas |');
    // archiving again is a no-op and does not duplicate rows
    const again = (await (
      await app.request('/api/availability/archive', { method: 'POST', body: '{}' })
    ).json()) as { archived: number };
    expect(again.archived).toBe(0);
  });

  it('merges into an existing archive note without duplicating', async () => {
    await app.request('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({
        entries: [{ person: 'Anna', from: '2025-01-06', to: '2025-01-10', kind: 'ooo', note: 'a' }],
      }),
    });
    await app.request('/api/availability/archive', { method: 'POST', body: '{}' });
    await app.request('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({
        entries: [
          { person: 'Anna', from: '2025-01-06', to: '2025-01-10', kind: 'ooo', note: 'a' },
          { person: 'Bob', from: '2025-06-02', to: '2025-06-06', kind: 'ooo', note: 'b' },
        ],
      }),
    });
    await app.request('/api/availability/archive', { method: 'POST', body: '{}' });
    const y2025 = readFileSync(join(root, 'planning', 'availability-2025.md'), 'utf8');
    expect((y2025.match(/2025-01-06/g) ?? []).length).toBe(1);
    expect(y2025).toContain('2025-06-02');
  });

  it('validates the months parameter', async () => {
    const res = await app.request('/api/availability/archive', {
      method: 'POST',
      body: JSON.stringify({ months: -1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('country bank holidays', () => {
  it('reduce bandwidth for everyone in that country and show up everywhere', async () => {
    writeFileSync(
      join(root, 'people', 'anna.md'),
      '---\ntype: person\ntitle: Anna\njira: anna\ncapacity: 10\ncountry: Poland\n---\n',
    );
    writeFileSync(
      join(root, 'planning', 'holidays.md'),
      '---\ntype: holidays\n---\n\n| Country | From | To | Name |\n| --- | --- | --- | --- |\n| polska | 2026-09-08 | 2026-09-09 | Test Holiday |\n| UK | 2026-09-03 |  | Not Anna |\n',
    );
    vault.indexer.rebuild();
    const body = await get();
    const anna = body.rows.find((r) => r.name === 'Anna' && r.sprint === 'Sprint 37');
    // 5d ooo (existing table) + 2d holiday outside it (alias 'polska' → Poland)
    expect(anna).toMatchObject({ ooo: 5, holiday: 2, available: 3, adjusted: 3 });
    expect(body.holidays).toHaveLength(2);
    // bob has no country: untouched by holidays
    const bob = body.rows.find((r) => r.name === 'Bob');
    expect(bob?.holiday).toBe(0);
  });

  it('seeds the built-in set without duplicating on a second run', async () => {
    const first = (await (
      await app.request('/api/availability/holidays/seed', { method: 'POST' })
    ).json()) as { added: number; file: string };
    expect(first.added).toBeGreaterThan(60);
    expect(readFileSync(join(root, first.file), 'utf8')).toContain('National Day');
    const second = (await (
      await app.request('/api/availability/holidays/seed', { method: 'POST' })
    ).json()) as { added: number };
    expect(second.added).toBe(0);
  });

  it('PUT /holidays rewrites the table and validates rows', async () => {
    const res = await app.request('/api/availability/holidays', {
      method: 'PUT',
      body: JSON.stringify({
        entries: [{ country: 'Poland', from: '2026-11-11', name: 'Independence Day' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'planning', 'holidays.md'), 'utf8')).toContain(
      '| Poland | 2026-11-11 | 2026-11-11 | Independence Day |',
    );
    const bad = await app.request('/api/availability/holidays', {
      method: 'PUT',
      body: JSON.stringify({ entries: [{ country: '', from: '2026-01-01' }] }),
    });
    expect(bad.status).toBe(400);
  });
});
