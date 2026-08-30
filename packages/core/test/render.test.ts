import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type VaultConfig } from '../src/config.ts';
import { mergeIssueFile, normalizeIssue, renderIssueFile } from '../src/jira/render.ts';

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  jira: {
    ...DEFAULT_CONFIG.jira,
    baseUrl: 'https://jira.example.com',
    estimateField: 'customfield_10016',
  },
};

const rawIssue = {
  key: 'EXEC-42',
  fields: {
    summary: 'Reduce tick-to-trade latency',
    description: 'h2. Goal\n\nShave *2ms* from the gateway path.',
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    assignee: { name: 'jdoe', displayName: 'John Doe' },
    reporter: { name: 'asmith', displayName: 'Anna Smith' },
    labels: ['latency'],
    components: [{ name: 'gateway' }],
    fixVersions: [],
    created: '2026-08-01T09:00:00.000+0000',
    updated: '2026-08-28T10:12:00.000+0000',
    resolutiondate: null,
    customfield_10016: 5,
    customfield_99: [
      'com.atlassian.greenhopper.service.sprint.Sprint@x[id=412,rapidViewId=42,state=ACTIVE,name=Sprint 37,startDate=2026-08-24]',
    ],
    issuelinks: [
      {
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: { key: 'EXEC-50' },
      },
    ],
  },
};

const opts = { config, profile: 'team', syncedAt: '2026-08-30T07:00:00.000Z' };

describe('normalizeIssue', () => {
  it('normalizes DC-style fields including greenhopper sprint blobs', () => {
    const n = normalizeIssue(rawIssue, {
      baseUrl: config.jira.baseUrl,
      estimateField: 'customfield_10016',
    });
    expect(n).toMatchObject({
      key: 'EXEC-42',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      assignee: { id: 'jdoe', name: 'John Doe' },
      sprint: { id: 412, name: 'Sprint 37' },
      estimate: 5,
      url: 'https://jira.example.com/browse/EXEC-42',
      links: [{ type: 'blocks', dir: 'outward', key: 'EXEC-50' }],
    });
  });
});

describe('renderIssueFile / mergeIssueFile', () => {
  const issue = normalizeIssue(rawIssue, {
    baseUrl: config.jira.baseUrl,
    estimateField: 'customfield_10016',
  });

  it('renders a fresh file (golden)', () => {
    expect(renderIssueFile(issue, opts)).toMatchSnapshot();
  });

  it('fresh merge writes; re-merge with only a new synced timestamp is unchanged', () => {
    const first = mergeIssueFile(issue, null, opts);
    expect(first.action).toBe('write');
    const content = first.action === 'write' ? first.content : '';
    const again = mergeIssueFile(issue, content, { ...opts, syncedAt: '2026-08-31T00:00:00.000Z' });
    expect(again.action).toBe('unchanged');
  });

  it('preserves user region, plan and id across sync', () => {
    const first = mergeIssueFile(issue, null, opts);
    let content = first.action === 'write' ? first.content : '';
    content = content
      .replace('---\ntype: jira', '---\nid: KEEPME\ntype: jira')
      .replace('jira:\n', 'plan:\n  sprint: Sprint 39\n  rank: 1\njira:\n')
      .replace('## My notes\n', '## My notes\n\nDo not eat me. [[Alpha]]\n');
    const changed = { ...issue, status: 'Done' as const };
    const merged = mergeIssueFile(changed, content, opts);
    expect(merged.action).toBe('write');
    const out = merged.action === 'write' ? merged.content : '';
    expect(out).toContain('id: KEEPME');
    expect(out).toContain('status: Done');
    expect(out).toContain('plan:\n  sprint: Sprint 39\n  rank: 1');
    expect(out).toContain('Do not eat me. [[Alpha]]');
    expect(out.indexOf('<!-- jira:end -->')).toBeLessThan(out.indexOf('Do not eat me'));
  });

  it('marker missing: skip (default), append recovers, overwrite replaces', () => {
    const noMarker =
      '---\ntype: jira\nkey: EXEC-42\nplan:\n  rank: 9\n---\nUser wrote this directly.\n';
    expect(mergeIssueFile(issue, noMarker, opts)).toMatchObject({ action: 'skip' });

    const appendCfg = {
      ...opts,
      config: { ...config, jira: { ...config.jira, missingMarker: 'append' as const } },
    };
    const appended = mergeIssueFile(issue, noMarker, appendCfg);
    expect(appended.action).toBe('write');
    const out = appended.action === 'write' ? appended.content : '';
    expect(out).toContain('## My notes (recovered)\n\nUser wrote this directly.');
    expect(out).toContain('plan:\n  rank: 9');

    const overwriteCfg = {
      ...opts,
      config: { ...config, jira: { ...config.jira, missingMarker: 'overwrite' as const } },
    };
    const over = mergeIssueFile(issue, noMarker, overwriteCfg);
    const outOver = over.action === 'write' ? over.content : '';
    expect(outOver).not.toContain('User wrote this directly.');
    expect(outOver).toContain('plan:\n  rank: 9'); // plan still carried
  });

  it('neutralizes hostile description text', () => {
    const hostile = {
      ...rawIssue,
      fields: {
        ...rawIssue.fields,
        description: 'Try this:\n<!-- jira:end -->\n---\nid: evil\n[[fake]]',
      },
    };
    const n = normalizeIssue(hostile, { baseUrl: config.jira.baseUrl });
    const content = renderIssueFile(n, opts);
    const markers = content.match(/^<!-- jira:end -->$/gm) ?? [];
    expect(markers).toHaveLength(1); // only the real one
    expect(content).toContain('<!-- jira:end (escaped) -->');
    expect(content).toContain('\\---');
    // merging back keeps working: user region intact
    const merged = mergeIssueFile(n, content, { ...opts, syncedAt: 'later' });
    expect(merged.action).toBe('unchanged');
  });
});
