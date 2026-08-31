import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChangeEvent,
  DigestStore,
  diffIssue,
  formatEvent,
  type IssueSnapshot,
  snapshotOf,
} from '../src/jira/digest.ts';
import type { NormalizedIssue } from '../src/jira/render.ts';

function snap(over: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    summary: 'Fix the gateway',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: 'anna',
    assigneeName: 'Anna',
    sprint: 'Sprint 37',
    estimate: 3,
    priority: 'High',
    issueType: 'Story',
    epic: 'EXEC-100',
    ...over,
  };
}

const meta = { at: '2026-08-31T09:00:00Z', profile: 'team', key: 'EXEC-1' };
const diff = (a: IssueSnapshot | null, b: IssueSnapshot) => diffIssue(a, b, meta);

describe('diffIssue', () => {
  it('reports a new issue once', () => {
    const e = diff(null, snap());
    expect(e).toHaveLength(1);
    expect(e[0]?.kind).toBe('created');
    expect(e[0]?.at).toBe(meta.at);
  });

  it('reports nothing when nothing changed', () => {
    expect(diff(snap(), snap())).toEqual([]);
  });

  it('distinguishes done, reopened and ordinary status moves', () => {
    expect(diff(snap(), snap({ status: 'Done', statusCategory: 'done' }))[0]?.kind).toBe('done');
    expect(diff(snap({ status: 'Done', statusCategory: 'done' }), snap())[0]?.kind).toBe(
      'reopened',
    );
    expect(diff(snap(), snap({ status: 'In Review' }))[0]?.kind).toBe('status');
  });

  it('reports assignee, sprint and estimate moves with readable endpoints', () => {
    const events = diff(
      snap(),
      snap({ assignee: 'bob', assigneeName: 'Bob', sprint: 'Sprint 38', estimate: 8 }),
    );
    const byKind = Object.fromEntries(events.map((e) => [e.kind, e]));
    expect(byKind.assignee?.from).toBe('Anna');
    expect(byKind.assignee?.to).toBe('Bob');
    expect(byKind.sprint?.to).toBe('Sprint 38');
    expect(byKind.estimate?.from).toBe('3');
    expect(byKind.estimate?.to).toBe('8');
  });

  it('carries issue context on every event for grouping', () => {
    const [e] = diff(snap(), snap({ estimate: 5 }));
    expect(e?.assigneeName).toBe('Anna');
    expect(e?.sprint).toBe('Sprint 37');
    expect(e?.summary).toBe('Fix the gateway');
  });

  it('renders one line per change', () => {
    const [e] = diff(snap(), snap({ status: 'Done', statusCategory: 'done' }));
    expect(formatEvent(e as ChangeEvent)).toBe('EXEC-1 done (In Progress → Done) (Anna)');
  });
});

describe('snapshotOf', () => {
  it('keeps only the fields worth diffing', () => {
    const issue = {
      key: 'EXEC-1',
      summary: 'Fix',
      status: 'Open',
      statusCategory: 'new',
      assignee: { id: 'anna', name: 'Anna' },
      sprint: { id: 7, name: 'Sprint 37' },
      estimate: 2,
      priority: 'High',
      issueType: 'Bug',
      epic: null,
      description: 'ignored',
      comments: [{ author: 'x', created: 'y', body: 'z' }],
    } as unknown as NormalizedIssue;
    expect(snapshotOf(issue)).toEqual({
      summary: 'Fix',
      status: 'Open',
      statusCategory: 'new',
      assignee: 'anna',
      assigneeName: 'Anna',
      sprint: 'Sprint 37',
      estimate: 2,
      priority: 'High',
      issueType: 'Bug',
      epic: null,
    });
  });
});

describe('DigestStore', () => {
  it('appends, reads newest-first, filters by time and groups runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-digest-'));
    try {
      const store = new DigestStore(dir);
      expect(store.read()).toEqual([]);
      const older = diffIssue(snap(), snap({ estimate: 5 }), {
        at: '2026-08-30T09:00:00Z',
        profile: 'team',
        key: 'EXEC-2',
      });
      store.append(older);
      store.append(diff(snap(), snap({ status: 'Done', statusCategory: 'done' })));
      const all = store.read();
      expect(all).toHaveLength(2);
      expect(all[0]?.key).toBe('EXEC-1'); // newest first
      expect(store.read({ since: '2026-08-31T00:00:00Z' })).toHaveLength(1);
      expect(store.read({ limit: 1 })).toHaveLength(1);
      expect(store.runs()).toEqual(['2026-08-31T09:00:00Z', '2026-08-30T09:00:00Z']);
      store.append([]); // no-op
      expect(store.read()).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
