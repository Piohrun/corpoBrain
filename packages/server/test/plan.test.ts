import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { buildBoard } from '../src/plan-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

function jiraFile(key: string, extra: string, user = ''): string {
  return `---\ntype: jira\nkey: ${key}\n${extra}url: https://j/browse/${key}\njira:\n  synced: 2026-08-30T00:00:00Z\n  profile: team\n---\n\n# ${key}\n\n<!-- jira:end -->\n\n## My notes\n${user}`;
}

beforeEach(() => {
  root = join(tmpdir(), `cb-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'jira'), { recursive: true });
  mkdirSync(join(root, 'people'), { recursive: true });
  mkdirSync(join(root, '.corpobrain', 'jira-cache'), { recursive: true });
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'sprints.json'),
    JSON.stringify([
      { id: 2, name: 'Sprint 37', state: 'active', startDate: '2026-08-24', endDate: '2026-09-04' },
      { id: 3, name: 'Sprint 38', state: 'future' },
      { id: 1, name: 'Sprint 36', state: 'closed' },
    ]),
  );
  writeFileSync(
    join(root, 'jira', 'EXEC-1.md'),
    jiraFile(
      'EXEC-1',
      'summary: One\nstatus: In Progress\nstatus_category: indeterminate\nassignee: anna\nsprint: Sprint 37\nestimate: 4\nupdated: 2026-08-29T00:00:00Z\n',
    ),
  );
  writeFileSync(
    join(root, 'jira', 'EXEC-2.md'),
    jiraFile(
      'EXEC-2',
      'summary: Two\nstatus: To Do\nstatus_category: new\nupdated: 2026-08-01T00:00:00Z\npriority: High\nplan:\n  sprint: Sprint 38\n  assignee: john\n  effort: 3\n  blocked_on: ["[[EXEC-1]]"]\n  rank: 1\n',
      'keep me\n',
    ),
  );
  writeFileSync(
    join(root, 'people', 'anna.md'),
    '---\ntype: person\ntitle: Anna\njira: anna\ncapacity: 8\nregion: EMEA\nteam: Gateway\ncapacity_overrides:\n  Sprint 38: 4\n---\n',
  );
  writeFileSync(
    join(root, 'people', 'john.md'),
    '---\ntype: person\ntitle: John\njira: john\ncapacity: 10\n---\n',
  );
  vault = new VaultService(root, ':memory:');
  vault.indexer.loadSprints();
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('buildBoard', () => {
  it('computes columns, effective values, loads, risks', () => {
    const board = buildBoard(vault, new Date('2026-08-30T12:00:00Z'));
    expect(board.unit).toBe('days');
    expect(board.columns).toEqual(['Sprint 37', 'Sprint 38', 'Backlog']);
    const one = board.issues.find((i) => i.key === 'EXEC-1');
    expect(one).toMatchObject({
      effectiveSprint: 'Sprint 37',
      effectiveAssignee: 'anna',
      effectiveEffort: 4, // pointsPerDay=1
      overridden: { sprint: false, assignee: false },
      riskFlags: [],
    });
    const two = board.issues.find((i) => i.key === 'EXEC-2');
    expect(two).toMatchObject({
      effectiveSprint: 'Sprint 38',
      effectiveAssignee: 'john',
      effectiveEffort: 3,
      overridden: { sprint: true, assignee: true },
    });
    expect(two?.riskFlags).toContain('stale');
    expect(two?.riskFlags).toContain('blocked'); // EXEC-1 not done
    expect(two?.riskFlags).toContain('high-priority-stale');
    expect(board.loads['people/anna.md']).toEqual({ 'Sprint 37': 4 });
    expect(board.loads['people/john.md']).toEqual({ 'Sprint 38': 3 });
    const anna = board.people.find((p) => p.name === 'Anna');
    expect(anna).toMatchObject({
      capacity: 8,
      overrides: { 'Sprint 38': 4 },
      region: 'EMEA',
      team: 'Gateway',
    });
  });
});

describe('plan writes', () => {
  it('PUT /api/plan/issue/:key patches plan frontmatter and preserves user region', async () => {
    const res = await app.request('/api/plan/issue/EXEC-2', {
      method: 'PUT',
      body: JSON.stringify({ sprint: 'Sprint 37', rank: 5, note: 'moved forward' }),
    });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'jira', 'EXEC-2.md'), 'utf8');
    expect(text).toContain('sprint: Sprint 37');
    expect(text).toContain('note: moved forward');
    expect(text).toContain('keep me');
    expect(text).toContain('blocked_on:'); // untouched fields survive
    const board = buildBoard(vault);
    expect(board.issues.find((i) => i.key === 'EXEC-2')?.effectiveSprint).toBe('Sprint 37');
  });

  it('clearing all plan fields removes the plan block', async () => {
    await app.request('/api/plan/issue/EXEC-2', {
      method: 'PUT',
      body: JSON.stringify({
        sprint: null,
        assignee: null,
        effort: null,
        blocked_on: null,
        rank: null,
      }),
    });
    const text = readFileSync(join(root, 'jira', 'EXEC-2.md'), 'utf8');
    expect(text).not.toContain('plan:');
    expect(text).toContain('keep me');
  });

  it('rejects unknown fields and unknown keys', async () => {
    expect(
      (
        await app.request('/api/plan/issue/EXEC-2', {
          method: 'PUT',
          body: JSON.stringify({ evil: 1 }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/api/plan/issue/NOPE-1', {
          method: 'PUT',
          body: JSON.stringify({ rank: 1 }),
        })
      ).status,
    ).toBe(404);
  });

  it('PUT /api/plan/person updates capacity and overrides', async () => {
    const res = await app.request('/api/plan/person', {
      method: 'PUT',
      body: JSON.stringify({ path: 'people/john.md', capacity: 6, overrides: { 'Sprint 37': 0 } }),
    });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'people', 'john.md'), 'utf8');
    expect(text).toContain('capacity: 6');
    expect(text).toContain('Sprint 37: 0');
    const board = buildBoard(vault);
    expect(board.people.find((p) => p.name === 'John')).toMatchObject({
      capacity: 6,
      overrides: { 'Sprint 37': 0 },
    });
  });
});

describe('dependencies and saved views', () => {
  it('derives dependsOn from plan.blocked_on and jira inward block links', () => {
    writeFileSync(
      join(root, 'jira', 'EXEC-3.md'),
      jiraFile(
        'EXEC-3',
        'summary: Three\nstatus: To Do\nstatus_category: new\nupdated: 2026-08-29T00:00:00Z\nlinks:\n  - { type: is blocked by, dir: inward, key: "[[EXEC-1]]" }\n  - { type: blocks, dir: outward, key: "[[EXEC-2]]" }\n',
      ),
    );
    vault.indexer.update();
    const board = buildBoard(vault, new Date('2026-08-30T12:00:00Z'));
    const three = board.issues.find((i) => i.key === 'EXEC-3');
    expect(three?.dependsOn).toEqual(['EXEC-1']);
    expect(three?.blockedBy).toEqual(['EXEC-1']); // EXEC-1 not done
    expect(three?.riskFlags).toContain('blocked');
    const two = board.issues.find((i) => i.key === 'EXEC-2');
    expect(two?.dependsOn).toEqual(['EXEC-1']); // from plan.blocked_on
  });

  it('saves and lists views', async () => {
    const res = await app.request('/api/plan/views', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Sprint 38 risks',
        filter: { text: 'gateway', flag: 'blocked', sprint: 'Sprint 38' },
      }),
    });
    expect(res.status).toBe(200);
    const views = (await (await app.request('/api/plan/views')).json()) as {
      title: string;
      filter: Record<string, unknown>;
    }[];
    expect(views).toMatchObject([
      {
        title: 'Sprint 38 risks',
        filter: { text: 'gateway', flag: 'blocked', sprint: 'Sprint 38' },
      },
    ]);
  });
});

describe('local sprints', () => {
  it('POST /api/jira/sprints creates a sprint note that becomes a board column', async () => {
    const res = await app.request('/api/jira/sprints', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Sprint 40 (draft)',
        start: '2026-10-05',
        end: '2026-10-16',
        goal: 'Q4 kickoff',
      }),
    });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'planning', 'Sprint 40 (draft).md'), 'utf8');
    expect(text).toContain('type: sprint');
    expect(text).toContain('state: future');
    const sprints = (await (await app.request('/api/jira/sprints')).json()) as {
      name: string;
      source: string;
    }[];
    const local = sprints.find((s) => s.name === 'Sprint 40 (draft)');
    expect(local).toMatchObject({ source: 'local' });
    expect(sprints.find((s) => s.name === 'Sprint 37')).toMatchObject({ source: 'jira' });
    const board = buildBoard(vault);
    expect(board.columns).toContain('Sprint 40 (draft)');
    expect(board.sprints.find((s) => s.name === 'Sprint 40 (draft)')?.source).toBe('local');
    // duplicate name rejected
    expect(
      (
        await app.request('/api/jira/sprints', {
          method: 'POST',
          body: JSON.stringify({ name: 'Sprint 40 (draft)' }),
        })
      ).status,
    ).toBe(409);
    // deleting the note removes the sprint
    await app.request(`/api/note?path=${encodeURIComponent('planning/Sprint 40 (draft).md')}`, {
      method: 'DELETE',
    });
    const after = (await (await app.request('/api/jira/sprints')).json()) as { name: string }[];
    expect(after.find((s) => s.name === 'Sprint 40 (draft)')).toBeUndefined();
  });
});

describe('used-load overrides', () => {
  it('round-trips load_overrides through the person endpoint and board', async () => {
    const res = await app.request('/api/plan/person', {
      method: 'PUT',
      body: JSON.stringify({ path: 'people/anna.md', loadOverrides: { 'Sprint 37': 6.5 } }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'people', 'anna.md'), 'utf8')).toContain('Sprint 37: 6.5');
    const board = buildBoard(vault);
    expect(board.people.find((p) => p.name === 'Anna')?.loadOverrides).toEqual({
      'Sprint 37': 6.5,
    });
    // clearing removes the key
    await app.request('/api/plan/person', {
      method: 'PUT',
      body: JSON.stringify({ path: 'people/anna.md', loadOverrides: {} }),
    });
    expect(readFileSync(join(root, 'people', 'anna.md'), 'utf8')).not.toContain('load_overrides');
  });
});

describe('hub colors', () => {
  it('color round-trips through the person endpoint and board; bad hex rejected', async () => {
    writeFileSync(
      join(root, 'people', 'EMEA.md'),
      '---\ntitle: "EMEA"\nregion: "EMEA"\nactive: false\n---\n\n# EMEA\n',
    );
    vault.indexer.update();
    const res = await app.request('/api/plan/person', {
      method: 'PUT',
      body: JSON.stringify({ path: 'people/EMEA.md', color: '#e04455' }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'people', 'EMEA.md'), 'utf8')).toContain('color: "#e04455"');
    const board = buildBoard(vault);
    expect(board.people.find((p) => p.name === 'EMEA')?.color).toBe('#e04455');
    expect(
      (
        await app.request('/api/plan/person', {
          method: 'PUT',
          body: JSON.stringify({ path: 'people/EMEA.md', color: 'red' }),
        })
      ).status,
    ).toBe(400);
  });
});

describe('person overview', () => {
  it('composes issues, dated mentions with snippets, and linked tasks', async () => {
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(
      join(root, 'notes', 'oneonone.md'),
      '---\nid: OO1\ntitle: 1:1 notes\n---\nTalked with [[Anna]] about the gateway.\n- [ ] follow up with [[Anna]] 📅 2026-09-10\n- [ ] unrelated task\n',
    );
    vault.indexer.update();
    const { personOverview } = await import('../src/person-routes.ts');
    const o = personOverview(vault, 'people/anna.md');
    expect(o.person.name).toBe('Anna');
    expect(o.issues.map((i) => i.key)).toEqual(['EXEC-1']); // effective assignee anna
    const mention = o.mentions.find((m) => m.srcPath === 'notes/oneonone.md');
    expect(mention?.snippet).toContain('about the gateway');
    // only the task line that links to her — not the unrelated one
    expect(o.tasks).toMatchObject([{ text: 'follow up with [[Anna]]', due: '2026-09-10' }]);
    const app2 = createApp(vault);
    expect((await app2.request('/api/person?path=people/anna.md')).status).toBe(200);
    expect((await app2.request('/api/person?path=notes/oneonone.md')).status).toBe(404);
  });
});

describe('default capacity', () => {
  it('fills in for people without explicit capacity; explicit wins; persists', async () => {
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(
      join(root, 'people', 'nocap.md'),
      '---\ntype: person\ntitle: NoCap\njira: nocap\n---\n',
    );
    vault.indexer.update();
    // before: null
    expect(buildBoard(vault).people.find((p) => p.name === 'NoCap')?.capacity).toBeNull();
    const res = await app.request('/api/plan/capacity-config', {
      method: 'PUT',
      body: JSON.stringify({ defaultCapacity: 7.5 }),
    });
    expect(res.status).toBe(200);
    const board = buildBoard(vault);
    expect(board.defaultCapacity).toBe(7.5);
    expect(board.people.find((p) => p.name === 'NoCap')?.capacity).toBe(7.5);
    expect(board.people.find((p) => p.name === 'Anna')?.capacity).toBe(8); // explicit wins
    expect(board.people.find((p) => p.name === 'NoCap')?.capacityIsDefault).toBe(true);
    expect(board.people.find((p) => p.name === 'Anna')?.capacityIsDefault).toBe(false);
    // persisted to config.json
    const onDisk = JSON.parse(readFileSync(join(root, '.corpobrain', 'config.json'), 'utf8'));
    expect(onDisk.capacity.defaultCapacity).toBe(7.5);
    expect(
      (
        await app.request('/api/plan/capacity-config', {
          method: 'PUT',
          body: JSON.stringify({ defaultCapacity: -1 }),
        })
      ).status,
    ).toBe(400);
  });
});

describe('sprint health', () => {
  it('reports the problems in the active sprint', async () => {
    const res = await app.request('/api/plan/health');
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      sprint: string;
      counts: Record<string, number>;
      problems: { kind: string; issueKey: string | null; personName: string | null }[];
      totals: { issues: number; effort: number };
    };
    expect(report.sprint).toBe('Sprint 37');
    // EXEC-1 (4 days) sits in Sprint 37 against Anna's 8 days: room to spare
    expect(report.problems.map((p) => p.kind)).toContain('underloaded');
    expect(report.totals.issues).toBe(1);
    expect(report.totals.effort).toBe(4);
  });

  it('checks a named sprint and flags unassigned, unestimated work', async () => {
    writeFileSync(
      join(root, 'jira', 'EXEC-9.md'),
      jiraFile(
        'EXEC-9',
        'summary: Nine\nstatus: To Do\nstatus_category: new\nsprint: Sprint 37\nestimate: 13\nupdated: 2026-08-29T00:00:00Z\n',
      ),
    );
    vault.indexer.rebuild();
    const res = await app.request('/api/plan/health?sprint=Sprint%2037');
    const report = (await res.json()) as { counts: Record<string, number> };
    expect(report.counts['no-assignee']).toBe(1);
    expect(report.counts.oversized).toBe(1); // 13 points ≥ the default threshold of 8
  });

  it('404s when the sprint is unknown', async () => {
    const res = await app.request('/api/plan/health?sprint=Nope');
    expect(res.status).toBe(404);
  });

  it('stores health thresholds through the planning settings route', async () => {
    const res = await app.request('/api/plan/capacity-config', {
      method: 'PUT',
      body: JSON.stringify({ health: { bigIssue: 5 } }),
    });
    expect(res.status).toBe(200);
    expect(vault.config.health.bigIssue).toBe(5);
    const onDisk = JSON.parse(readFileSync(join(root, '.corpobrain', 'config.json'), 'utf8')) as {
      health: { bigIssue: number };
    };
    expect(onDisk.health.bigIssue).toBe(5);
    const bad = await app.request('/api/plan/capacity-config', {
      method: 'PUT',
      body: JSON.stringify({ health: { staleDays: -1 } }),
    });
    expect(bad.status).toBe(400);
  });
});
