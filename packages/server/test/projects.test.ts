import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { CalendarModel, ProjectSummary } from '../src/project-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

function jira(key: string, extra: string): void {
  writeFileSync(
    join(root, 'jira', `${key}.md`),
    `---\ntype: jira\nkey: ${key}\n${extra}url: https://j/browse/${key}\n---\n\n# ${key}\n\n<!-- jira:end -->\n`,
  );
}

beforeEach(() => {
  root = join(tmpdir(), `cb-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const d of ['jira', 'people', 'projects', '.corpobrain/jira-cache']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'sprints.json'),
    JSON.stringify([
      { id: 2, name: 'Sprint 37', state: 'active', startDate: '2026-08-31', endDate: '2026-09-11' },
      { id: 3, name: 'Sprint 38', state: 'future', startDate: '2026-09-14', endDate: '2026-09-25' },
    ]),
  );
  writeFileSync(
    join(root, 'projects', 'falcon.md'),
    '---\ntype: project\ntitle: Falcon\nstatus: active\ncolor: "#c0392b"\ntarget: 2026-09-30\nepics: [EXEC-100]\nlabels: [falcon]\n---\n\n## Goal\n',
  );
  // in the project by epic, by label, and by explicit tag; one outside it
  jira(
    'EXEC-1',
    'summary: Epic member\nstatus: In Progress\nstatus_category: indeterminate\nassignee: anna\nsprint: Sprint 37\nestimate: 3\nepic: EXEC-100\n',
  );
  jira(
    'EXEC-2',
    'summary: Label member\nstatus: To Do\nstatus_category: new\nassignee: bob\nsprint: Sprint 37\nestimate: 2\nlabels: ["falcon"]\n',
  );
  jira(
    'EXEC-3',
    'summary: Tagged by hand\nstatus: To Do\nstatus_category: new\nassignee: anna\nsprint: Sprint 38\nestimate: 5\nplan:\n  project: Falcon\n  blocked_on: ["EXEC-1"]\n',
  );
  jira('EXEC-9', 'summary: Nothing to do with it\nstatus: To Do\nstatus_category: new\n');
  writeFileSync(
    join(root, 'people', 'anna.md'),
    '---\ntype: person\ntitle: Anna\njira: anna\ncapacity: 8\n---\n',
  );
  writeFileSync(
    join(root, 'people', 'bob.md'),
    '---\ntype: person\ntitle: Bob\njira: bob\ncapacity: 8\n---\n',
  );
  vault = new VaultService(root, ':memory:');
  vault.indexer.loadSprints();
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/projects', () => {
  it('rolls up membership from epics, labels and explicit tags', async () => {
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: ProjectSummary[]; untagged: number };
    expect(body.projects).toHaveLength(1);
    const p = body.projects[0] as ProjectSummary;
    expect(p).toMatchObject({
      title: 'Falcon',
      status: 'active',
      issues: 3,
      done: 0,
      inProgress: 1,
      effort: 10,
      target: '2026-09-30',
    });
    expect(p.people.map((x) => x.assignee).sort()).toEqual(['anna', 'bob']);
    expect(body.untagged).toBe(1); // EXEC-9
  });

  it('forecasts a finish sprint and date', async () => {
    const body = (await (await app.request('/api/projects')).json()) as {
      projects: ProjectSummary[];
    };
    const p = body.projects[0] as ProjectSummary;
    expect(p.forecastDate).toMatch(/^2026-09-\d\d$/);
    expect(p.lateDeps).toBe(0);
    expect(p.conflicts).toBe(0);
  });
});

describe('GET /api/projects/timeline', () => {
  const timeline = async (path = 'projects/falcon.md') =>
    (await (
      await app.request(`/api/projects/timeline?path=${encodeURIComponent(path)}`)
    ).json()) as CalendarModel;

  it('builds a workday axis with sprint and month spans', async () => {
    const t = await timeline();
    expect(t.days[0]).toBe('2026-08-31');
    expect(t.days).toContain('2026-09-25');
    expect(t.days).not.toContain('2026-09-05'); // a Saturday
    const s37 = t.sprints.find((s) => s.name === 'Sprint 37');
    expect(s37).toMatchObject({ from: 0, span: 10 });
    expect(t.sprints.find((s) => s.name === 'Sprint 38')).toMatchObject({ from: 10, span: 10 });
    expect(t.months[0]?.label).toContain('Aug');
  });

  it('lays blocks on the day grid: pinned by plan.start, the rest flowing per sprint', async () => {
    const t = await timeline();
    const byKey = Object.fromEntries(t.blocks.map((b) => [b.key, b]));
    // EXEC-1 (3d) and EXEC-2 flow into Sprint 37 on different rows
    expect(byKey['EXEC-1']).toMatchObject({ start: 0, span: 3, workDays: 3, pinned: false });
    expect(byKey['EXEC-2']).toMatchObject({ start: 0, span: 2 });
    // EXEC-3 flows into Sprint 38 (day 10)
    expect(byKey['EXEC-3']).toMatchObject({ start: 10, span: 5 });
    expect(byKey['EXEC-1']?.summary).toBe('Epic member');
  });

  it('pins an issue once plan.start is set and derives conflicts', async () => {
    await app.request('/api/plan/issue/EXEC-3', {
      method: 'PUT',
      body: JSON.stringify({ start: '2026-09-02' }),
    });
    const t = await timeline();
    const three = t.blocks.find((b) => b.key === 'EXEC-3');
    expect(three).toMatchObject({ start: 2, pinned: true });
    // it now overlaps EXEC-1 (anna, days 0-2)? EXEC-1 flows AFTER pinned blocks, so no overlap
    expect(t.blocks.find((b) => b.key === 'EXEC-1')?.conflict).toBe(false);
    // and its blocker EXEC-1 no longer finishes first
    expect(three?.lateDeps).toEqual(['EXEC-1']);
    expect(t.warnings.join(' ')).toContain('EXEC-3 starts before its blocker');
  });

  it('lists roster people as rows even with no issues', async () => {
    writeFileSync(
      join(root, 'people', 'carol.md'),
      '---\ntype: person\ntitle: Carol\njira: carol\ncapacity: 8\n---\n',
    );
    vault.indexer.rebuild();
    const res = await app.request('/api/projects/roster', {
      method: 'PUT',
      body: JSON.stringify({ path: 'projects/falcon.md', people: ['Carol'] }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'projects', 'falcon.md'), 'utf8')).toContain('Carol');
    const t = await timeline();
    expect(t.rows[0]).toMatchObject({ name: 'Carol', inRoster: true });
    expect(t.rows.at(-1)?.name).toBe('Unassigned');
    const bad = await app.request('/api/projects/roster', {
      method: 'PUT',
      body: JSON.stringify({ path: 'projects/falcon.md', people: ['Nobody Real'] }),
    });
    expect(bad.status).toBe(400);
  });

  it('gives a roster person without a Jira id a row instead of dropping them', async () => {
    writeFileSync(
      join(root, 'people', 'newbie.md'),
      '---\ntype: person\ntitle: Newbie\ncapacity: 8\n---\n',
    );
    vault.indexer.rebuild();
    await app.request('/api/projects/roster', {
      method: 'PUT',
      body: JSON.stringify({ path: 'projects/falcon.md', people: ['Newbie'] }),
    });
    const t = await timeline();
    const row = t.rows.find((r) => r.name === 'Newbie');
    expect(row).toMatchObject({
      inRoster: true,
      jiraId: null,
      assignee: 'person:people/newbie.md',
    });
  });

  it('marks away days on rows and stretches blocks over them', async () => {
    mkdirSync(join(root, 'planning'), { recursive: true });
    writeFileSync(
      join(root, 'planning', 'availability.md'),
      '---\ntype: availability\n---\n\n| Person | From | To | Type |\n| --- | --- | --- | --- |\n| Anna | 2026-09-01 | 2026-09-02 | ooo |\n',
    );
    vault.indexer.rebuild();
    const t = await timeline();
    const anna = t.rows.find((r) => r.name === 'Anna');
    expect(anna?.ooo).toEqual([1, 2]);
    // EXEC-1: 3 working days for anna, days 1-2 away → spans 0..4
    expect(t.blocks.find((b) => b.key === 'EXEC-1')).toMatchObject({
      span: 5,
      workDays: 3,
      awayDays: 2,
    });
  });

  it('predicts a finish date and keeps Backlog work on the rail', async () => {
    jira(
      'EXEC-4',
      'summary: Someday\nstatus: To Do\nstatus_category: new\nepic: EXEC-100\nestimate: 2\n',
    );
    vault.indexer.rebuild();
    const t = await timeline();
    expect(t.rail.map((r) => r.key)).toEqual(['EXEC-4']);
    expect(t.rail[0]?.days).toBe(2);
    expect(t.finishDate).toMatch(/^2026-09-/);
  });

  it('404s for an unknown project', async () => {
    const res = await app.request('/api/projects/timeline?path=projects/nope.md');
    expect(res.status).toBe(404);
    const bad = await app.request('/api/projects/timeline');
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/projects/arrange', () => {
  it('pins every scheduled issue to its computed start day', async () => {
    const res = await app.request('/api/projects/arrange', {
      method: 'POST',
      body: JSON.stringify({ path: 'projects/falcon.md' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pinned: number; finishDate: string | null };
    expect(body.pinned).toBe(3);
    expect(body.finishDate).toMatch(/^2026-09-/);
    // EXEC-3 depends on EXEC-1 (3 days from 31 Aug) → starts 3 Sep, pulled into Sprint 37
    const three = readFileSync(join(root, 'jira', 'EXEC-3.md'), 'utf8');
    expect(three).toContain('start: 2026-09-03');
    expect(three).toContain('sprint: Sprint 37');
    const t = (await (
      await app.request('/api/projects/timeline?path=projects%2Ffalcon.md')
    ).json()) as CalendarModel;
    expect(t.blocks.every((b) => b.pinned)).toBe(true);
    expect(t.blocks.every((b) => !b.conflict && b.lateDeps.length === 0)).toBe(true);
  });
});

describe('POST /api/projects', () => {
  it('creates a project note with the rules scaffolded', async () => {
    const res = await app.request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title: 'Atlas Migration' }),
    });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path).toBe('projects/atlas-migration.md');
    const text = readFileSync(join(root, path), 'utf8');
    expect(text).toContain('type: project');
    expect(text).toContain('epics: []');
    const list = (await (await app.request('/api/projects')).json()) as {
      projects: ProjectSummary[];
    };
    expect(list.projects.map((p) => p.title).sort()).toEqual(['Atlas Migration', 'Falcon']);
  });

  it('rejects a project with no title', async () => {
    const res = await app.request('/api/projects', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

describe('tagging an issue to a project', () => {
  it('goes through the existing plan patch and never touches Jira fields', async () => {
    const res = await app.request('/api/plan/issue/EXEC-9', {
      method: 'PUT',
      body: JSON.stringify({ project: 'Falcon' }),
    });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'jira', 'EXEC-9.md'), 'utf8');
    expect(text).toContain('project: Falcon');
    const body = (await (await app.request('/api/projects')).json()) as {
      projects: ProjectSummary[];
      untagged: number;
    };
    expect(body.projects[0]?.issues).toBe(4);
    expect(body.untagged).toBe(0);
  });
});
