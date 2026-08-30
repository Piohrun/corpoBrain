import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type VaultConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import type { JiraSprint, RawIssue } from '../src/jira/adapter.ts';
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
  async search(jql: string): Promise<RawIssue[]> {
    this.jqls.push(jql);
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
    });
    const one = readFileSync(join(root, 'jira/EXEC-1.md'), 'utf8');
    expect(one).toContain('key: EXEC-1');
    expect(one).toContain('sprint: Sprint 37'); // from agile API membership
    expect(one).toContain('## My notes');
    const person = readFileSync(join(root, 'people/anna.md'), 'utf8');
    expect(person).toContain('jira: "anna"');
    const state = JSON.parse(readFileSync(join(root, '.corpobrain/jira-cache/state.json'), 'utf8'));
    expect(state.watermarks.team).toBe('2026/08/30 11:55'); // 5 min overlap
    expect(adapter.jqls[0]).toBe('project = EXEC');
  });

  it('second run is incremental and idempotent; user notes survive', async () => {
    adapter.issues = [issue('EXEC-1', 'First thing')];
    await sync.run();
    // user adds notes below the marker
    const p = join(root, 'jira/EXEC-1.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('## My notes\n', '## My notes\n\nMINE.\n'));
    const [r2] = await sync.run();
    expect(adapter.jqls[1]).toContain('AND updated >= "2026/08/30 11:55"');
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
