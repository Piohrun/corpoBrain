import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type JiraProfile, type VaultConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import type { JiraSprint, RawIssue } from '../src/jira/adapter.ts';
import { DigestStore } from '../src/jira/digest.ts';
import { type AdapterLike, JiraSync, jqlDate } from '../src/jira/sync.ts';

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  jira: {
    ...DEFAULT_CONFIG.jira,
    baseUrl: 'https://jira.example.com',
    projectKeys: ['EXEC'],
    profiles: [
      {
        name: 'team',
        jql: 'project = EXEC',
        folder: 'jira',
        intervalMinutes: 15,
        boards: [7],
        futureSprints: 2,
      },
    ],
  },
};

function issue(key: string, summary: string, assignee?: string): RawIssue {
  return {
    key,
    fields: {
      summary,
      description: null,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { name: 'Story' },
      ...(assignee ? { assignee: { name: assignee, displayName: assignee.toUpperCase() } } : {}),
    },
  };
}

class FakeAdapter implements AdapterLike {
  issues: RawIssue[] = [];
  jqls: string[] = [];
  detectSprintField?: () => Promise<string | null>;
  async search(
    jql: string,
    _extraFields?: string[],
    onPage?: (fetched: number, total: number) => void,
  ): Promise<RawIssue[]> {
    this.jqls.push(jql);
    // simulate two pages
    if (this.issues.length > 1) onPage?.(Math.ceil(this.issues.length / 2), this.issues.length);
    onPage?.(this.issues.length, this.issues.length);
    return this.issues;
  }
  async sprints(boardId: number): Promise<JiraSprint[]> {
    return [
      { id: 1, name: 'Sprint 36', state: 'closed', originBoardId: boardId },
      { id: 2, name: 'Sprint 37', state: 'active', originBoardId: boardId },
      { id: 3, name: 'Sprint 38', state: 'future', originBoardId: boardId },
    ];
  }
  async sprintIssueKeys(sprintId: number): Promise<string[]> {
    if (sprintId === 2) return ['EXEC-1'];
    if (sprintId === 3) return ['EXEC-2'];
    return [];
  }
}

let root: string;
let adapter: FakeAdapter;
let sync: JiraSync;

beforeEach(() => {
  root = join(tmpdir(), `cb-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  adapter = new FakeAdapter();
  sync = new JiraSync(root, config, adapter, () => new Date('2026-08-30T12:00:00Z'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('JiraSync', () => {
  it('creates files, people, caches, and a watermark', async () => {
    adapter.issues = [issue('EXEC-1', 'First thing', 'anna'), issue('EXEC-2', 'Second thing')];
    const [report] = await sync.run();
    expect(report).toMatchObject({
      fetched: 2,
      created: ['EXEC-1', 'EXEC-2'],
      unchanged: 0,
      skipped: [],
      peopleCreated: ['people/anna.md'],
      sprints: 3,
      warnings: [],
    });
    const one = readFileSync(join(root, 'jira/EXEC-1.md'), 'utf8');
    expect(one).toContain('key: EXEC-1');
    expect(one).toContain('sprint: Sprint 37'); // from agile API membership
    expect(one).toContain('## My notes');
    const person = readFileSync(join(root, 'people/anna.md'), 'utf8');
    expect(person).toContain('jira: "anna"');
    const state = JSON.parse(readFileSync(join(root, '.corpobrain/jira-cache/state.json'), 'utf8'));
    expect(state.lastSyncAt.team).toBe('2026-08-30T12:00:00.000Z');
    expect(adapter.jqls[0]).toBe('project = EXEC');
  });

  it('sizes the incremental window from the last run, in minutes, timezone-free', async () => {
    adapter.issues = [issue('EXEC-1', 'x')];
    await sync.run();
    let t = new Date('2026-08-30T14:30:00Z');
    const later = new JiraSync(root, config, adapter, () => t);
    await later.run();
    expect(adapter.jqls[1]).toBe('(project = EXEC) AND updated >= -155m'); // 150 + 5
    // a state.json from before lastSyncAt existed still works via the legacy watermark
    const file = join(root, '.corpobrain/jira-cache/state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.lastSyncAt = undefined;
    state.watermarks.team = '2026/08/30 14:00';
    writeFileSync(file, JSON.stringify(state));
    t = new Date('2026-08-30T15:00:00Z');
    await later.run();
    expect(adapter.jqls[2]).toBe('(project = EXEC) AND updated >= -60m'); // 14:05 → 15:00, +5
  });

  it('a full pass reports mirrored issues the JQL no longer returns, without touching them', async () => {
    adapter.issues = [issue('EXEC-1', 'stays'), issue('EXEC-2', 'moves away')];
    await sync.run();
    const p = join(root, 'jira/EXEC-2.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('## My notes\n', '## My notes\n\nMINE.\n'));
    adapter.issues = [issue('EXEC-1', 'stays')];
    const [incremental] = await sync.run();
    expect(incremental?.gone).toEqual([]); // an incremental pass cannot know
    const [full] = await sync.run(undefined, { full: true });
    expect(full?.gone).toEqual(['EXEC-2']);
    expect(full?.warnings.some((w) => w.includes('EXEC-2'))).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('MINE.');
  });

  it("keeps another board's sprints in the cache when a profile syncs", async () => {
    adapter.issues = [issue('EXEC-1', 'x')];
    await sync.run();
    const file = join(root, '.corpobrain/jira-cache/sprints.json');
    const mine = JSON.parse(readFileSync(file, 'utf8')) as { id: number; originBoardId: number }[];
    expect(mine.map((s) => s.originBoardId)).toEqual([7, 7, 7]);
    const other: VaultConfig = {
      ...config,
      jira: {
        ...config.jira,
        profiles: [{ ...(config.jira.profiles[0] as JiraProfile), name: 'other', boards: [9] }],
      },
    };
    const otherAdapter = new FakeAdapter();
    otherAdapter.sprints = async (boardId: number) => [
      { id: 90, name: 'Ops 5', state: 'active', originBoardId: boardId },
    ];
    await new JiraSync(root, other, otherAdapter, () => new Date('2026-08-30T12:00:00Z')).run();
    const merged = JSON.parse(readFileSync(file, 'utf8')) as {
      id: number;
      originBoardId: number;
    }[];
    expect(merged.map((s) => s.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 90]);
    // re-running the first profile replaces only board 7's sprints
    await sync.run(undefined, { full: true });
    const again = JSON.parse(readFileSync(file, 'utf8')) as { id: number }[];
    expect(again.map((s) => s.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 90]);
  });

  it('second run is incremental and idempotent; user notes survive', async () => {
    adapter.issues = [issue('EXEC-1', 'First thing')];
    await sync.run();
    // user adds notes below the marker
    const p = join(root, 'jira/EXEC-1.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('## My notes\n', '## My notes\n\nMINE.\n'));
    const [r2] = await sync.run();
    expect(adapter.jqls[1]).toBe('(project = EXEC) AND updated >= -5m'); // 0 min + overlap
    expect(r2).toMatchObject({ created: [], updated: [], unchanged: 1 });
    // now the issue actually changes
    adapter.issues = [issue('EXEC-1', 'Renamed thing')];
    const [r3] = await sync.run();
    expect(r3.updated).toEqual(['EXEC-1']);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('Renamed thing');
    expect(text).toContain('MINE.');
  });

  it('existing person with the id is not recreated', async () => {
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(
      join(root, 'people/anna-k.md'),
      '---\ntype: person\ntitle: Anna K\njira: anna\n---\n',
    );
    adapter.issues = [issue('EXEC-1', 'x', 'anna')];
    const [report] = await sync.run();
    expect(report.peopleCreated).toEqual([]);
  });

  it('indexer loads the sprints cache', async () => {
    adapter.issues = [issue('EXEC-1', 'First thing')];
    await sync.run();
    const indexer = new Indexer(root, config, openDb(':memory:'));
    indexer.rebuild();
    const sprints = indexer.db.prepare('SELECT id, name, state FROM sprints ORDER BY id').all();
    expect(sprints).toEqual([
      { id: 1, name: 'Sprint 36', state: 'closed' },
      { id: 2, name: 'Sprint 37', state: 'active' },
      { id: 3, name: 'Sprint 38', state: 'future' },
    ]);
  });
});

describe('jqlDate', () => {
  it('formats UTC', () => {
    expect(jqlDate(new Date('2026-01-05T09:07:00Z'))).toBe('2026/01/05 09:07');
  });
});

describe('sync progress', () => {
  it('emits phases with counts through a full run', async () => {
    adapter.issues = [
      issue('EXEC-1', 'a'),
      issue('EXEC-2', 'b'),
      issue('EXEC-3', 'c'),
      issue('EXEC-4', 'd'),
      issue('EXEC-5', 'e'),
    ];
    const events: string[] = [];
    sync.onProgress = (p) => events.push(`${p.phase}:${p.current}/${p.total}`);
    await sync.run();
    expect(events[0]).toBe('search:0/0');
    expect(events).toContain('search:3/5'); // per-page progress
    expect(events).toContain('search:5/5');
    expect(events).toContain('sprints:1/1');
    expect(events.some((e) => e.startsWith('membership:'))).toBe(true);
    expect(events).toContain('issues:5/5');
    expect(events[events.length - 1]).toBe('done:5/5');
  });
});

describe('sync warnings', () => {
  it('warns when a profile has no boards and when a board fails', async () => {
    adapter.issues = [issue('EXEC-1', 'x')];
    const noBoards = new JiraSync(
      root,
      {
        ...config,
        jira: { ...config.jira, profiles: config.jira.profiles.map((p) => ({ ...p, boards: [] })) },
      },
      adapter,
      () => new Date('2026-08-31T12:00:00Z'),
    );
    const [r1] = await noBoards.run();
    expect(r1?.warnings.some((w) => w.includes('NOT fetched'))).toBe(true);

    adapter.sprints = async () => {
      throw new Error('The board does not support sprints');
    };
    const [r2] = await sync.run();
    expect(r2?.warnings.some((w) => w.includes('Kanban'))).toBe(true);
    // issues still synced despite the board failure (created on first run → unchanged here)
    expect((r2?.created.length ?? 0) + (r2?.unchanged ?? 0)).toBeGreaterThan(0);
  });
});

describe('multi-sprint mapping', () => {
  function multiSprintIssue(key: string, blobs: string[]): RawIssue {
    return {
      key,
      fields: {
        summary: `multi ${key}`,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        customfield_99: blobs,
      },
    };
  }
  const blob = (id: number, name: string, state: string) =>
    `com.atlassian.greenhopper.service.sprint.Sprint@x[id=${id},rapidViewId=7,state=${state},name=${name},startDate=2026-08-01]`;

  it('issue carried across sprints maps to its active sprint from the field', async () => {
    adapter.detectSprintField = async () => 'customfield_99';
    adapter.issues = [
      multiSprintIssue('EXEC-9', [blob(1, 'Sprint 36', 'CLOSED'), blob(2, 'Sprint 37', 'ACTIVE')]),
      // future-planned issue, absent from any membership list
      multiSprintIssue('EXEC-10', [blob(1, 'Sprint 36', 'CLOSED'), blob(9, 'Sprint 41', 'FUTURE')]),
    ];
    await sync.run();
    const nine = readFileSync(join(root, 'jira/EXEC-9.md'), 'utf8');
    expect(nine).toContain('sprint: Sprint 37');
    const ten = readFileSync(join(root, 'jira/EXEC-10.md'), 'utf8');
    expect(ten).toContain('sprint: Sprint 41'); // field-derived, no membership needed
    // detection is cached in state.json
    const state = JSON.parse(readFileSync(join(root, '.corpobrain/jira-cache/state.json'), 'utf8'));
    expect(state.sprintField).toBe('customfield_99');
  });

  it('membership still fills in when the sprint field is unavailable', async () => {
    adapter.detectSprintField = async () => null;
    adapter.issues = [issue('EXEC-1', 'plain')]; // membership says Sprint 37
    await sync.run();
    expect(readFileSync(join(root, 'jira/EXEC-1.md'), 'utf8')).toContain('sprint: Sprint 37');
  });
});

describe('latest-sprint rule', () => {
  it('an issue in both the active and a future sprint maps to the future (latest) one', async () => {
    adapter.detectSprintField = async () => 'customfield_99';
    const blob = (id: number, name: string, state: string) =>
      `com.atlassian.greenhopper.service.sprint.Sprint@x[id=${id},rapidViewId=7,state=${state},name=${name},startDate=x]`;
    adapter.issues = [
      {
        key: 'EXEC-20',
        fields: {
          summary: 'rolled forward',
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          customfield_99: [blob(2, 'Sprint 37', 'ACTIVE'), blob(3, 'Sprint 38', 'FUTURE')],
        },
      },
    ];
    await sync.run();
    expect(readFileSync(join(root, 'jira/EXEC-20.md'), 'utf8')).toContain('sprint: Sprint 38');
  });
});

describe('full re-sync', () => {
  it('ignores the watermark and re-detects the sprint field', async () => {
    adapter.issues = [issue('EXEC-1', 'x')];
    await sync.run();
    expect(adapter.jqls[0]).toBe('project = EXEC');
    await sync.run(); // incremental
    expect(adapter.jqls[1]).toContain('updated >=');
    await sync.run(undefined, { full: true });
    expect(adapter.jqls[2]).toBe('project = EXEC'); // watermark ignored
    // and the watermark is refreshed afterwards for the next incremental
    await sync.run();
    expect(adapter.jqls[3]).toContain('updated >=');
  });

  it('records a change digest from the second sync onwards', async () => {
    adapter.issues = [issue('EXEC-1', 'First thing', 'anna')];
    const [first] = await sync.run();
    // nothing to compare against on the first pass: baseline only
    expect(first?.changes).toBe(0);
    expect(existsSync(join(root, '.corpobrain/jira-cache/digest.jsonl'))).toBe(false);

    const moved = issue('EXEC-1', 'First thing renamed', 'bob');
    (moved.fields as Record<string, unknown>).status = {
      name: 'Done',
      statusCategory: { key: 'done' },
    };
    adapter.issues = [moved, issue('EXEC-3', 'Brand new')];
    const [second] = await sync.run();
    expect(second?.changes).toBeGreaterThan(0);

    const events = new DigestStore(join(root, '.corpobrain/jira-cache')).read();
    const forOne = events.filter((e) => e.key === 'EXEC-1');
    // no phantom 'sprint' move: EXEC-1's sprint comes from board membership,
    // which is not in the cached raw issue but is in the mirrored file
    expect(forOne.map((e) => e.kind).sort()).toEqual(['assignee', 'done', 'summary']);
    expect(forOne.find((e) => e.kind === 'assignee')?.to).toBe('BOB');
    expect(events.find((e) => e.key === 'EXEC-3')?.kind).toBe('created');
    // every event from one refresh shares the run timestamp
    expect(new Set(events.map((e) => e.at)).size).toBe(1);

    const state = JSON.parse(readFileSync(join(root, '.corpobrain/jira-cache/state.json'), 'utf8'));
    expect(state.lastSyncAt.team).toBe('2026-08-30T12:00:00.000Z');
  });
});
