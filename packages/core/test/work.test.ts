import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.ts';
import {
  applyWorkPatch,
  applyWorkReport,
  findWorkNote,
  reportWork,
  WORK_MARKER,
  type WorkReport,
  workItemFromFrontmatter,
  workNotePath,
  workNoteRegions,
} from '../src/work.ts';

// local time, so the stamps in the log are the same on every machine
const at = (h: number, m: number) => new Date(2026, 10, 19, h, m);
const base: WorkReport = {
  repo: 'exec-gateway',
  branch: 'feature/EXEC-104-replication',
  summary: 'Added backoff to the retry loop and pushed 3 commits.',
};

describe('applyWorkReport', () => {
  it('starts a note: status in frontmatter, a readable status, a log line, room for the user', () => {
    const text = applyWorkReport(
      null,
      {
        ...base,
        state: '2 tests still failing in SnapshotTest.',
        next: 'Fix the ordering assumption.',
        chat: 'retry logic',
        issue: 'EXEC-104',
        waitingOn: 'agent',
        uatBranch: 'uat/2026-w47',
      },
      at(14, 10),
    );
    expect(text).toBe(
      [
        '---',
        'type: work',
        'title: feature/EXEC-104-replication',
        'repo: exec-gateway',
        'branch: feature/EXEC-104-replication',
        'state: 2 tests still failing in SnapshotTest.',
        'next: Fix the ordering assumption.',
        'chat: retry logic',
        `updated: ${at(14, 10).toISOString()}`,
        'stage: dev',
        'waiting_on: agent',
        'issue: "[[EXEC-104]]"',
        'uat_branch: uat/2026-w47',
        '---',
        '',
        '# feature/EXEC-104-replication',
        '',
        '**In development** · waiting on agent · updated 2026-11-19 14:10 · chat “retry logic”',
        '',
        '`exec-gateway` · `feature/EXEC-104-replication` · UAT branch `uat/2026-w47`',
        '',
        '**Stopped at:** 2 tests still failing in SnapshotTest.',
        '',
        '**Next:** Fix the ordering assumption.',
        '',
        '## Updates',
        '',
        '- 2026-11-19 14:10 · **retry logic** — Added backoff to the retry loop and pushed 3 commits. · _Stopped at:_ 2 tests still failing in SnapshotTest. · _Next:_ Fix the ordering assumption.',
        '',
        WORK_MARKER,
        '',
        '## My notes',
        '',
        '',
      ].join('\n'),
    );
  });

  it('a later report replaces the status, adds to the log, and leaves the user alone', () => {
    const first = applyWorkReport(null, { ...base, next: 'old next', chat: 'one' }, at(9, 0));
    const mine = `${first}Do not merge before Anna's schema change lands.\n\n- [ ] ask Anna\n`;
    const withKey = mine.replace('type: work\n', 'type: work\nowner: "[[Anna Kowalska]]"\n');
    const second = applyWorkReport(
      withKey,
      { ...base, summary: 'Tests green.', stage: 'in-uat-branch', title: 'ignored once set' },
      at(16, 40),
    );
    const fm = parseFrontmatter(second).data;
    expect(fm).toMatchObject({
      title: 'feature/EXEC-104-replication',
      stage: 'in-uat-branch',
      waiting_on: 'nobody',
      owner: '[[Anna Kowalska]]',
    });
    // a report describes the work as it is now: the old "next" and chat are gone
    expect(fm.next).toBeUndefined();
    expect(fm.chat).toBeUndefined();
    expect(second).toContain('**In the UAT branch** · updated 2026-11-19 16:40');
    expect(second).not.toContain('**Next:**');
    // newest first, the earlier entry kept word for word
    const log = second.split('\n').filter((l) => l.startsWith('- 2026'));
    expect(log).toEqual([
      '- 2026-11-19 16:40 — Tests green.',
      '- 2026-11-19 09:00 · **one** — Added backoff to the retry loop and pushed 3 commits. · _Next:_ old next',
    ]);
    expect(workNoteRegions(second).mine).toBe(
      "## My notes\n\nDo not merge before Anna's schema change lands.\n\n- [ ] ask Anna",
    );
    expect(
      second.endsWith(
        "## My notes\n\nDo not merge before Anna's schema change lands.\n\n- [ ] ask Anna\n",
      ),
    ).toBe(true);
  });

  it('agent text cannot become structure: one line, no marker, no links, clipped', () => {
    const text = applyWorkReport(
      null,
      {
        ...base,
        summary: `line one\n---\nline two ${WORK_MARKER} [[Secret plans]] <!-- x -->`,
        state: 'x'.repeat(900),
      },
      at(10, 0),
    );
    expect(text.split(WORK_MARKER)).toHaveLength(2);
    expect(text).not.toContain('[[Secret plans]]');
    const entry = text.split('\n').find((l) => l.startsWith('- 2026')) as string;
    expect(entry).toContain('line one --- line two <\\!-- work:end -->');
    expect(parseFrontmatter(text).error).toBeFalsy();
    expect((parseFrontmatter(text).data.state as string).length).toBe(600);
  });

  it('a note whose marker was deleted keeps all of its text below a new one', () => {
    const first = applyWorkReport(null, base, at(9, 0));
    const broken = first
      .replace(`${WORK_MARKER}\n`, '')
      .replace('## My notes\n\n', 'my own words\n');
    const again = applyWorkReport(broken, { ...base, summary: 'second' }, at(10, 0));
    expect(again.split(WORK_MARKER)).toHaveLength(2);
    expect(workNoteRegions(again).mine).toContain('my own words');
    // nothing the user could have written is dropped, old generated text included
    expect(workNoteRegions(again).mine).toContain('Added backoff to the retry loop');
  });

  it('rejects what it cannot file', () => {
    expect(() => applyWorkReport(null, { ...base, summary: ' ' }, at(9, 0))).toThrow('summary');
    expect(() => applyWorkReport(null, { ...base, branch: '' }, at(9, 0))).toThrow('branch');
    expect(() => applyWorkReport(null, { ...base, stage: 'shipped' as never }, at(9, 0))).toThrow(
      'stage must be one of',
    );
    expect(() => applyWorkReport('---\ntitle: [oops\n---\nbody', base, at(9, 0))).toThrow(
      'unreadable frontmatter',
    );
  });
});

describe('applyWorkPatch', () => {
  it('edits from the app update frontmatter and status; a stage change is logged', () => {
    const note = `${applyWorkReport(null, { ...base, next: 'old' }, at(9, 0))}mine\n`;
    const moved = applyWorkPatch(
      note,
      { stage: 'on-uat', waitingOn: 'tester', next: 'watch the UAT run', pr: null },
      at(11, 30),
    );
    expect(parseFrontmatter(moved).data).toMatchObject({
      stage: 'on-uat',
      waiting_on: 'tester',
      next: 'watch the UAT run',
    });
    expect(moved).toContain('**On UAT** · waiting on tester · updated 2026-11-19 11:30');
    expect(moved).toContain('- 2026-11-19 11:30 · **you** — moved to On UAT');
    expect(moved.endsWith('## My notes\n\nmine\n')).toBe(true);
    // clearing a field removes it; the same stage again is not logged twice
    const cleared = applyWorkPatch(moved, { stage: 'on-uat', next: null }, at(12, 0));
    expect(parseFrontmatter(cleared).data.next).toBeUndefined();
    expect(cleared.match(/moved to On UAT/g)).toHaveLength(1);
  });
});

describe('work notes on disk', () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `cb-work-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('file names hold any branch name', () => {
    expect(workNotePath('work', 'exec-gateway', 'feature/EXEC-104-replication')).toBe(
      'work/exec-gateway feature-EXEC-104-replication.md',
    );
    expect(workNotePath('work', 'a:b', 'x\\y?*<z>|"q"')).toBe('work/a-b x-y-z-q.md');
    expect(workNotePath('work', '..', '..')).toBe('work/work.md');
  });

  it('one note per repo and branch, found again after the user renames it', () => {
    const first = reportWork(root, 'work', base, at(9, 0));
    expect(first).toMatchObject({
      created: true,
      path: 'work/exec-gateway feature-EXEC-104-replication.md',
    });
    // the user gives the note a better name in the app: the file moves with it
    renameSync(join(root, first.path), join(root, 'work', 'Order-book replication.md'));
    const second = reportWork(root, 'work', { ...base, summary: 'more' }, at(10, 0));
    expect(second).toMatchObject({ created: false, path: 'work/Order-book replication.md' });
    expect(readFileSync(join(root, second.path), 'utf8').match(/^- 2026/gm)).toHaveLength(2);
    // another branch of the same repo is another note
    const other = reportWork(root, 'work', { ...base, branch: 'fix/typo' }, at(11, 0));
    expect(other.created).toBe(true);
    expect(findWorkNote(root, 'work', 'exec-gateway', 'fix/typo')?.path).toBe(other.path);
    expect(findWorkNote(root, 'work', 'other-repo', 'fix/typo')).toBeNull();
  });

  it('does not overwrite an unrelated note that already has the default name', () => {
    mkdirSync(join(root, 'work'));
    writeFileSync(join(root, 'work', 'r b.md'), '# something else\n');
    const made = reportWork(root, 'work', { repo: 'r', branch: 'b', summary: 's' }, at(9, 0));
    expect(made.path).toBe('work/r b 2.md');
    expect(readFileSync(join(root, 'work', 'r b.md'), 'utf8')).toBe('# something else\n');
  });

  it('reads items back for lists, tolerating hand edits', () => {
    expect(
      workItemFromFrontmatter('work/x.md', 'X', { repo: 'r', branch: 'b', stage: 'nonsense' }),
    ).toMatchObject({ stage: 'dev', waitingOn: 'nobody', next: null, issue: null });
    expect(
      workItemFromFrontmatter('work/x.md', 'X', { issue: '[[EXEC-1]]', stage: 'released' }),
    ).toMatchObject({ issue: 'EXEC-1', stage: 'released' });
  });
});
