import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { ProjectSummary, TimelineModel } from '../src/project-routes.ts';
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
    expect(p.forecastSprint).toBe('Sprint 37');
    expect(p.forecastDate).toMatch(/^2026-09-\d\d$/);
    expect(p.violations).toBe(0);
  });
});

describe('GET /api/projects/timeline', () => {
  const timeline = async (path = 'projects/falcon.md') =>
    (await (
      await app.request(`/api/projects/timeline?path=${encodeURIComponent(path)}`)
    ).json()) as TimelineModel;

  it('lays out the plan per person and sprint', async () => {
    const t = await timeline();
    expect(t.sprints.map((s) => s.name)).toEqual(['Sprint 37', 'Sprint 38']);
    expect(t.rows.map((r) => r.name)).toEqual(['Anna', 'Bob']);
    const anna = t.rows.find((r) => r.name === 'Anna');
    expect(anna?.capacityDays['Sprint 37']).toBe(8);
    const plan = Object.fromEntries(t.planBlocks.map((b) => [b.key, b]));
    expect(plan['EXEC-1']).toMatchObject({ sprint: 'Sprint 37', offsetDays: 0, days: 3 });
    expect(plan['EXEC-3']).toMatchObject({ sprint: 'Sprint 38', days: 5 });
    expect(plan['EXEC-1']?.summary).toBe('Epic member');
    expect(plan['EXEC-1']?.path).toBe('jira/EXEC-1.md');
  });

  it('forecasts blocks against dependencies and capacity', async () => {
    const t = await timeline();
    const f = Object.fromEntries(t.forecastBlocks.map((b) => [b.key, b]));
    // EXEC-3 depends on EXEC-1 (3 days), so it cannot start before day 3
    expect(f['EXEC-3']?.offsetDays).toBe(3);
    expect(f['EXEC-3']?.sprint).toBe('Sprint 37'); // forecast pulls it earlier than the plan
    expect(t.forecast.finishSprint).toBe('Sprint 37');
    expect(t.forecast.violations).toEqual([]);
  });

  it('keeps backlog work off the calendar but in the model', async () => {
    jira(
      'EXEC-4',
      'summary: Not scheduled\nstatus: To Do\nstatus_category: new\nepic: EXEC-100\nestimate: 1\n',
    );
    vault.indexer.rebuild();
    const t = await timeline();
    expect(t.backlog.map((b) => b.key)).toEqual(['EXEC-4']);
    expect(t.planBlocks.map((b) => b.key)).not.toContain('EXEC-4');
  });

  it('404s for an unknown project', async () => {
    const res = await app.request('/api/projects/timeline?path=projects/nope.md');
    expect(res.status).toBe(404);
    const bad = await app.request('/api/projects/timeline');
    expect(bad.status).toBe(400);
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
