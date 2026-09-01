import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

const day = (d: number, h = 9) =>
  `2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000+0000`;
const status = (at: string, from: string, to: string) => ({
  created: at,
  author: { displayName: 'Anna K' },
  items: [{ field: 'status', fromString: from, toString: to }],
});
const sprintMove = (at: string, from: string | null, to: string) => ({
  created: at,
  author: { displayName: 'Bob' },
  items: [{ field: 'Sprint', fromString: from, toString: to }],
});
const estimate = (at: string, from: string, to: string) => ({
  created: at,
  author: { displayName: 'Bob' },
  items: [{ field: 'Story Points', fromString: from, toString: to }],
});

function issue(key: string, fm: Record<string, string>, histories: unknown[]): void {
  const lines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(
    join(root, 'jira', `${key}.md`),
    `---\ntype: jira\nkey: ${key}\n${lines}\n---\n# ${key}\n<!-- jira:end -->\n`,
  );
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'issues', `${key}.json`),
    JSON.stringify({ key, fields: {}, changelog: { histories } }),
  );
}

beforeEach(() => {
  root = join(tmpdir(), `cb-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const d of ['jira', 'people', '.corpobrain/jira-cache/issues'])
    mkdirSync(join(root, d), { recursive: true });
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'sprints.json'),
    JSON.stringify([
      { id: 37, name: 'Sprint 37', state: 'active', startDate: day(1), endDate: day(11, 17) },
    ]),
  );
  writeFileSync(
    join(root, 'people', 'anna.md'),
    '---\ntype: person\ntitle: Anna K\njira: anna\n---\n',
  );
  // done in the sprint: created 25 Aug, started 2 Sep, done 6 Sep
  issue(
    'EXEC-1',
    {
      status: 'Done',
      status_category: 'done',
      issue_type: 'Story',
      assignee: 'anna',
      sprint: 'Sprint 37',
      created: '2026-07-25T09:00:00.000+0000',
    },
    [
      status(day(2), 'To Do', 'In Progress'),
      status(day(4), 'In Progress', 'Review'),
      status(day(6), 'Review', 'Done'),
    ],
  );
  // open and aging: started 3 Sep, still in review
  issue(
    'EXEC-2',
    {
      status: 'Review',
      status_category: 'indeterminate',
      issue_type: 'Story',
      assignee: 'anna',
      sprint: 'Sprint 37',
      created: day(1),
    },
    [
      status(day(3), 'To Do', 'In Progress'),
      status(day(5), 'In Progress', 'Review'),
      sprintMove(day(3, 10), null, 'Sprint 37'),
      estimate(day(7), '2', '5'),
    ],
  );
  // never started
  issue(
    'EXEC-3',
    {
      status: 'To Do',
      status_category: 'new',
      issue_type: 'Bug',
      sprint: 'Sprint 37',
      created: day(1),
    },
    [],
  );
  // pulled out mid-sprint
  issue('EXEC-4', { status: 'To Do', status_category: 'new', issue_type: 'Bug', created: day(1) }, [
    sprintMove('2026-07-28T09:00:00.000+0000', null, 'Sprint 37'),
    sprintMove(day(8), 'Sprint 37', 'Sprint 38'),
  ]);
  vault = new VaultService(root, ':memory:');
  vault.indexer.loadSprints();
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/flow', () => {
  it('sprint: aging open work, finished work with cycle times, reference percentiles, churn', async () => {
    const res = await app.request('/api/flow/sprint');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sprint: { name: string; start: string; end: string };
      open: {
        key: string;
        times: { ageDays: number | null; inStatusDays: number };
        bands: { status: string }[];
      }[];
      done: { key: string; times: { cycleDays: number; leadDays: number } }[];
      reference: { cycle: { n: number; p50: number }; timeInStatus: { status: string }[] };
      churn: {
        added: { key: string }[];
        removed: { key: string; to: string }[];
        reestimated: { key: string }[];
      };
      people: null;
    };
    expect(body.sprint).toMatchObject({
      name: 'Sprint 37',
      start: '2026-08-01',
      end: '2026-08-11',
    });
    expect(body.done.map((d) => d.key)).toEqual(['EXEC-1']);
    expect(body.done[0]?.times).toMatchObject({ cycleDays: 4, leadDays: 12 });
    expect(body.open.map((o) => o.key)).toEqual(['EXEC-2', 'EXEC-3']); // aging first
    expect(body.open[0]?.times.ageDays).toBeGreaterThan(0);
    expect(body.open[0]?.bands.map((b) => b.status)).toEqual(['To Do', 'In Progress', 'Review']);
    expect(body.open[1]?.times.ageDays).toBeNull();
    expect(body.reference.cycle).toMatchObject({ n: 1, p50: 4 });
    expect(body.reference.timeInStatus.map((t) => t.status)).toContain('Review');
    expect(body.churn.added.map((a) => a.key)).toEqual(['EXEC-2']);
    expect(body.churn.removed).toEqual([
      expect.objectContaining({ key: 'EXEC-4', to: 'Sprint 38' }),
    ]);
    expect(body.churn.reestimated.map((r) => r.key)).toEqual(['EXEC-2']);
    expect(body.people).toBeNull();
  });

  it('per-person breakdown only on request; stats by type; single issue timeline', async () => {
    const withPeople = (await (await app.request('/api/flow/sprint?byPerson=1')).json()) as {
      people: { name: string; done: number }[];
    };
    expect(withPeople.people).toEqual([expect.objectContaining({ name: 'Anna K', done: 1 })]);
    const stats = (await (await app.request('/api/flow/stats?days=30')).json()) as {
      byType: { issueType: string; cycle: { n: number } }[];
    };
    expect(stats.byType).toEqual([
      expect.objectContaining({ issueType: 'Story', cycle: expect.objectContaining({ n: 1 }) }),
    ]);
    const one = (await (await app.request('/api/flow/issue?key=EXEC-1')).json()) as {
      transitions: unknown[];
      times: { perStatus: Record<string, number> };
    };
    expect(one.transitions).toHaveLength(3);
    expect(one.times.perStatus.Review).toBe(2);
    expect((await app.request('/api/flow/issue?key=NOPE-1')).status).toBe(404);
  });
});
