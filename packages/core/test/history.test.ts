import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';
import { JiraAdapter } from '../src/jira/adapter.ts';
import { normalizeHistory, normalizeIssue, renderIssueFile } from '../src/jira/render.ts';

const histories = [
  {
    id: '3',
    created: '2026-09-03T09:00:00.000+0000',
    author: { name: 'anna', displayName: 'Anna K' },
    items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '5', toString: 'Done' }],
  },
  {
    id: '1',
    created: '2026-09-01T08:00:00.000+0000',
    author: { accountId: 'abc', displayName: 'Bob' },
    items: [
      { field: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' },
      { field: 'description', fromString: 'old', toString: 'new' },
      { field: 'Story Points', fieldId: 'customfield_10016', fromString: '3', toString: '5' },
      { field: 'Sprint', from: '', fromString: null, to: '37', toString: 'Sprint 37' },
    ],
  },
  {
    id: '2',
    created: '2026-09-02T08:00:00.000+0000',
    items: [{ field: 'assignee', from: null, fromString: null, to: 'anna', toString: 'Anna K' }],
  },
];

describe('normalizeHistory', () => {
  it('keeps status/assignee/sprint/estimate changes, sorted oldest first, drops the rest', () => {
    const t = normalizeHistory(histories, 'customfield_10016');
    expect(
      t.map((x) => `${x.at.slice(0, 10)} ${x.field}: ${x.from} → ${x.to} (${x.author})`),
    ).toEqual([
      '2026-09-01 status: To Do → In Progress (Bob)',
      '2026-09-01 estimate: 3 → 5 (Bob)',
      '2026-09-01 sprint: null → Sprint 37 (Bob)',
      '2026-09-02 assignee: null → Anna K (null)',
      '2026-09-03 status: In Progress → Done (Anna K)',
    ]);
    // estimate recognised by name when no field id is configured
    expect(normalizeHistory(histories).filter((x) => x.field === 'estimate')).toHaveLength(1);
    expect(normalizeHistory(undefined)).toEqual([]);
  });

  it('renders a History section above the marker', () => {
    const issue = normalizeIssue(
      { key: 'EXEC-1', fields: { summary: 'x' }, changelog: { histories } },
      { baseUrl: 'https://j', estimateField: 'customfield_10016' },
    );
    const text = renderIssueFile(issue, {
      config: DEFAULT_CONFIG,
      profile: 'team',
      syncedAt: '2026-09-04T00:00:00.000Z',
    });
    const history = text.slice(text.indexOf('## History'), text.indexOf('<!-- jira:end -->'));
    expect(history).toContain('- 2026-09-01 08:00 status: To Do → In Progress (Bob)');
    expect(history).toContain('- 2026-09-03 09:00 status: In Progress → Done (Anna K)');
    expect(history).not.toContain('description');
  });
});

describe('transitions in the index', () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `cb-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, 'jira'), { recursive: true });
    mkdirSync(join(root, '.corpobrain', 'jira-cache', 'issues'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('come from the cached raw issue and follow the note in and out of the index', () => {
    writeFileSync(
      join(root, 'jira', 'EXEC-1.md'),
      '---\ntype: jira\nkey: EXEC-1\nstatus: Done\n---\n# EXEC-1\n<!-- jira:end -->\n',
    );
    writeFileSync(
      join(root, '.corpobrain', 'jira-cache', 'issues', 'EXEC-1.json'),
      JSON.stringify({ key: 'EXEC-1', fields: {}, changelog: { histories } }),
    );
    const idx = new Indexer(root, structuredClone(DEFAULT_CONFIG), openDb(':memory:'));
    idx.update();
    const rows = idx.db
      .prepare('SELECT field, from_value, to_value FROM transitions WHERE key = ? ORDER BY at')
      .all('EXEC-1') as { field: string; to_value: string }[];
    expect(rows.map((r) => `${r.field}:${r.to_value}`)).toEqual([
      'status:In Progress',
      'estimate:5',
      'sprint:Sprint 37',
      'assignee:Anna K',
      'status:Done',
    ]);
    rmSync(join(root, 'jira', 'EXEC-1.md'));
    idx.updatePaths(['jira/EXEC-1.md']);
    expect(idx.db.prepare('SELECT count(*) AS n FROM transitions').get()).toEqual({ n: 0 });
  });
});

describe('adapter changelog fetching', () => {
  const fetchOf = (routes: Record<string, unknown>, calls: string[]) =>
    (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      return new Response(JSON.stringify(hit ? hit[1] : {}), {
        status: hit ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

  it('asks DC for the changelog with the search and completes truncated ones per issue', async () => {
    const calls: string[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'bearer', token: 't' },
      'datacenter',
      fetchOf(
        {
          '/rest/api/2/search': {
            total: 2,
            startAt: 0,
            issues: [
              { key: 'EXEC-1', fields: {}, changelog: { total: 1, histories: [histories[2]] } },
              { key: 'EXEC-2', fields: {}, changelog: { total: 3, histories: [histories[2]] } },
            ],
          },
          '/rest/api/2/issue/EXEC-2': { key: 'EXEC-2', changelog: { histories } },
        },
        calls,
      ),
    );
    const issues = await a.search('project = EXEC');
    expect(calls[0]).toContain('expand=changelog');
    expect(issues[0]?.changelog?.histories).toHaveLength(1);
    expect(issues[1]?.changelog?.histories).toHaveLength(3);
    expect(
      calls.some((u) => u.includes('/rest/api/2/issue/EXEC-2') && u.includes('expand=changelog')),
    ).toBe(true);
    expect(calls.some((u) => u.includes('/rest/api/2/issue/EXEC-1'))).toBe(false);
  });

  it('pages the Cloud changelog sub-resource', async () => {
    const calls: string[] = [];
    const a = new JiraAdapter(
      'https://j',
      { mode: 'basic', token: 't', email: 'e' },
      'cloud',
      fetchOf(
        {
          'changelog?startAt=0': { values: [histories[0], histories[1]], isLast: false },
          'changelog?startAt=2': { values: [histories[2]], isLast: true },
        },
        calls,
      ),
    );
    expect(await a.issueChangelog('EXEC-9')).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });
});
