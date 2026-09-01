import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { VaultService } from '../src/vault-service.ts';
import {
  applyChanges,
  collectStaged,
  journalTail,
  previewChanges,
  undoItems,
  type WriteAdapter,
} from '../src/writeback.ts';

let root: string;
let vault: VaultService;

function jiraFile(key: string, extra: string): string {
  return `---\ntype: jira\nkey: ${key}\n${extra}url: https://j/browse/${key}\njira:\n  synced: 2026-08-31T00:00:00Z\n  profile: team\n---\n\n# ${key}\n\n<!-- jira:end -->\n\n## My notes\nkeep me\n`;
}

const SPRINT_NAMES: Record<number, string> = { 37: 'Sprint 37', 38: 'Sprint 38' };

class FakeWriteAdapter implements WriteAdapter {
  calls: string[] = [];
  liveUpdated: Record<string, string> = {};
  liveAssignee: Record<string, string | null> = {};
  liveSprint: Record<string, { id: number; name: string } | null> = {};
  /** simulate Jira silently ignoring a sprint move */
  ignoreSprintMoves = false;
  failOn: string | null = null;
  async issueSprint(key: string): Promise<{ id: number; name: string } | null> {
    return this.liveSprint[key] ?? null;
  }
  async issueFields(key: string): Promise<Record<string, unknown>> {
    return {
      updated: this.liveUpdated[key] ?? '2026-08-30T10:00:00Z',
      assignee: this.liveAssignee[key] !== undefined ? { name: this.liveAssignee[key] } : null,
    };
  }
  async setAssignee(key: string, assignee: string | null): Promise<void> {
    if (this.failOn === key) throw new Error('boom: no permission');
    this.calls.push(`assignee ${key} -> ${assignee}`);
    this.liveAssignee[key] = assignee;
  }
  async moveIssuesToSprint(sprintId: number, keys: string[]): Promise<void> {
    if (this.failOn && keys.includes(this.failOn)) throw new Error('boom: sprint move failed');
    this.calls.push(`sprint ${keys.join(',')} -> ${sprintId}`);
    if (this.ignoreSprintMoves) return;
    for (const k of keys)
      this.liveSprint[k] = { id: sprintId, name: SPRINT_NAMES[sprintId] ?? '?' };
  }
  async moveIssuesToBacklog(keys: string[]): Promise<void> {
    this.calls.push(`backlog ${keys.join(',')}`);
    for (const k of keys) this.liveSprint[k] = null;
  }
}

beforeEach(() => {
  root = join(tmpdir(), `cb-wb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'jira'), { recursive: true });
  mkdirSync(join(root, '.corpobrain', 'jira-cache'), { recursive: true });
  writeFileSync(
    join(root, '.corpobrain', 'jira-cache', 'sprints.json'),
    JSON.stringify([
      { id: 37, name: 'Sprint 37', state: 'active' },
      { id: 38, name: 'Sprint 38', state: 'future' },
    ]),
  );
  mkdirSync(join(root, 'planning'), { recursive: true });
  writeFileSync(
    join(root, 'planning', 'Local Sprint.md'),
    '---\ntype: sprint\ntitle: "Local Sprint"\nname: "Local Sprint"\nstate: future\n---\n',
  );
  writeFileSync(
    join(root, 'jira', 'EXEC-1.md'),
    jiraFile(
      'EXEC-1',
      'summary: One\nstatus: To Do\nstatus_category: new\nassignee: anna\nsprint: Sprint 37\nupdated: 2026-08-30T10:00:00Z\nplan:\n  sprint: Sprint 38\n  assignee: john\n  note: keep this note\n',
    ),
  );
  writeFileSync(
    join(root, 'jira', 'EXEC-2.md'),
    jiraFile(
      'EXEC-2',
      'summary: Two\nstatus: To Do\nstatus_category: new\nupdated: 2026-08-30T10:00:00Z\nplan:\n  sprint: Local Sprint\n',
    ),
  );
  vault = new VaultService(root, ':memory:');
  vault.indexer.loadSprints();
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('collectStaged', () => {
  it('finds sprint+assignee diffs; local-sprint targets are unwritable', () => {
    const staged = collectStaged(vault);
    expect(staged).toMatchObject([
      { key: 'EXEC-1', field: 'sprint', from: 'Sprint 37', to: 'Sprint 38', writable: true },
      { key: 'EXEC-1', field: 'assignee', from: 'anna', to: 'john', writable: true },
      { key: 'EXEC-2', field: 'sprint', from: 'Backlog', to: 'Local Sprint', writable: false },
    ]);
  });
});

describe('previewChanges', () => {
  it('flags issues changed in Jira since last sync', async () => {
    const adapter = new FakeWriteAdapter();
    adapter.liveUpdated['EXEC-1'] = '2026-08-31T09:00:00Z'; // newer than mirror
    const rows = await previewChanges(
      vault,
      adapter,
      collectStaged(vault).filter((s) => s.writable),
    );
    expect(rows.filter((r) => r.key === 'EXEC-1').every((r) => r.conflict)).toBe(true);
  });
});

describe('applyChanges', () => {
  it('dry-run journals intentions, sends nothing, keeps plan intact', async () => {
    const adapter = new FakeWriteAdapter();
    const items = collectStaged(vault)
      .filter((s) => s.writable)
      .map((s) => ({ key: s.key, field: s.field, to: s.to }));
    const report = await applyChanges(vault, adapter, items, { dryRun: true });
    expect(report.results.every((r) => r.status === 'dry-run')).toBe(true);
    expect(adapter.calls).toEqual([]);
    expect(readFileSync(join(root, 'jira', 'EXEC-1.md'), 'utf8')).toContain('sprint: Sprint 38');
    expect(journalTail(vault).every((e) => e.dryRun === true)).toBe(true);
  });

  it('real apply writes, verifies, clears only the applied plan fields, journals', async () => {
    const adapter = new FakeWriteAdapter();
    const report = await applyChanges(
      vault,
      adapter,
      [
        { key: 'EXEC-1', field: 'sprint', to: 'Sprint 38' },
        { key: 'EXEC-1', field: 'assignee', to: 'john' },
      ],
      { dryRun: false },
    );
    expect(report.results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(adapter.calls).toEqual(['sprint EXEC-1 -> 38', 'assignee EXEC-1 -> john']);
    const text = readFileSync(join(root, 'jira', 'EXEC-1.md'), 'utf8');
    expect(text).not.toContain('sprint: Sprint 38\n'); // plan.sprint cleared
    expect(text).not.toContain('assignee: john\n'); // plan.assignee cleared
    expect(text).toContain('note: keep this note'); // untouched plan fields stay
    expect(text).toContain('keep me'); // user region untouched
    const journal = journalTail(vault);
    expect(journal.filter((e) => e.ok && !e.dryRun)).toHaveLength(2);
  });

  it('conflicts are skipped; errors abort the rest of the batch', async () => {
    const adapter = new FakeWriteAdapter();
    adapter.liveUpdated['EXEC-1'] = '2026-08-31T09:00:00Z';
    const conflictReport = await applyChanges(
      vault,
      adapter,
      [{ key: 'EXEC-1', field: 'assignee', to: 'john' }],
      { dryRun: false },
    );
    expect(conflictReport.results[0]?.status).toBe('conflict');
    expect(adapter.calls).toEqual([]);

    adapter.liveUpdated = {};
    adapter.failOn = 'EXEC-1';
    const errReport = await applyChanges(
      vault,
      adapter,
      [
        { key: 'EXEC-1', field: 'assignee', to: 'john' },
        { key: 'EXEC-1', field: 'sprint', to: 'Sprint 38' },
      ],
      { dryRun: false },
    );
    expect(errReport.stopped).toBe(true);
    expect(errReport.results.map((r) => r.status)).toEqual(['error', 'not-run']);
  });

  it('undoItems derives the inverse of an applied batch', async () => {
    const adapter = new FakeWriteAdapter();
    const report = await applyChanges(
      vault,
      adapter,
      [
        { key: 'EXEC-1', field: 'sprint', to: 'Sprint 38' },
        { key: 'EXEC-1', field: 'assignee', to: 'john' },
      ],
      { dryRun: false },
    );
    const inverse = undoItems(vault, report.batchId);
    expect(inverse).toEqual([
      { key: 'EXEC-1', field: 'sprint', to: 'Sprint 37' },
      { key: 'EXEC-1', field: 'assignee', to: 'anna' },
    ]);
  });

  it('undo of an assignment from unassigned clears the assignee, and null is applied and verified', async () => {
    const adapter = new FakeWriteAdapter();
    // EXEC-2 has no assignee in the mirror
    const report = await applyChanges(
      vault,
      adapter,
      [{ key: 'EXEC-2', field: 'assignee', to: 'john' }],
      { dryRun: false },
    );
    expect(report.results[0]?.status).toBe('applied');
    const inverse = undoItems(vault, report.batchId);
    expect(inverse).toEqual([{ key: 'EXEC-2', field: 'assignee', to: null }]);
    const undo = await applyChanges(vault, adapter, inverse, { dryRun: false });
    expect(undo.results[0]?.status).toBe('applied');
    expect(adapter.calls).toContain('assignee EXEC-2 -> null');
  });

  it('a sprint move that Jira ignored fails verification instead of clearing the plan', async () => {
    const adapter = new FakeWriteAdapter();
    adapter.ignoreSprintMoves = true;
    const report = await applyChanges(
      vault,
      adapter,
      [{ key: 'EXEC-1', field: 'sprint', to: 'Sprint 38' }],
      { dryRun: false },
    );
    expect(report.results[0]?.status).toBe('error');
    expect(report.results[0]?.detail).toContain('verification failed');
    expect(readFileSync(join(root, 'jira', 'EXEC-1.md'), 'utf8')).toContain('sprint: Sprint 38');
  });
});

describe('route gating', () => {
  it('apply and preview are 403 while write-back is off', async () => {
    const app = createApp(vault);
    expect(
      (
        await app.request('/api/jira/writeback/apply', {
          method: 'POST',
          body: JSON.stringify({ items: [{ key: 'EXEC-1', field: 'sprint', to: 'Sprint 38' }] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/api/jira/writeback/preview', { method: 'POST', body: '{}' })).status,
    ).toBe(403);
    // staged listing is read-only and always available
    const staged = await app.request('/api/jira/writeback/staged');
    expect(staged.status).toBe(200);
    expect(existsSync(join(root, '.corpobrain', 'jira-writeback.log'))).toBe(false);
  });
});
