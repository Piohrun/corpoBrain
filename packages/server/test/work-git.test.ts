import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkItem } from '@corpobrain/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkGit, workGitFacts } from '../src/work-git.ts';

let root: string;
let clone: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const commit = (file: string, text: string, message: string) => {
  writeFileSync(join(clone, file), text);
  git(clone, 'add', file);
  git(clone, 'commit', '-q', '-m', message);
};
const item = (o: Partial<WorkItem> = {}): WorkItem => ({
  path: 'work/x.md',
  title: 'X',
  repo: 'r',
  branch: 'feature/x',
  stage: 'dev',
  waitingOn: 'nobody',
  state: null,
  next: null,
  chat: null,
  updated: null,
  issue: null,
  uatBranch: null,
  releaseBranch: null,
  pr: null,
  clone,
  ...o,
});

beforeEach(() => {
  root = join(tmpdir(), `cb-workgit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const remote = join(root, 'remote.git');
  clone = join(root, 'clone');
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, clone], { stdio: 'ignore' });
  git(clone, 'checkout', '-q', '-b', 'main');
  commit('a.txt', 'one\n', 'init');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  git(clone, 'checkout', '-q', '-b', 'feature/x');
  commit('b.txt', 'work\n', 'feature work');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('workGitFacts', () => {
  it('a branch that was never pushed: no upstream, last commit, nothing merged', async () => {
    const f = await workGitFacts(item());
    expect(f).toMatchObject({
      available: true,
      checkedOut: true,
      dirty: 0,
      upstream: null,
      ahead: null,
      mergedInto: [],
      inUat: null,
      inRelease: null,
    });
    expect(f.lastCommit?.subject).toBe('feature work');
  });

  it('counts unpushed commits and uncommitted files', async () => {
    git(clone, 'push', '-q', '-u', 'origin', 'feature/x');
    expect(await workGitFacts(item())).toMatchObject({
      upstream: 'origin/feature/x',
      ahead: 0,
      behind: 0,
      dirty: 0,
    });
    commit('c.txt', 'more\n', 'second');
    writeFileSync(join(clone, 'd.txt'), 'not committed\n');
    writeFileSync(join(clone, 'a.txt'), 'changed\n');
    expect(await workGitFacts(item())).toMatchObject({ ahead: 1, behind: 0, dirty: 2 });
    // another branch checked out: the worktree says nothing about this one
    git(clone, 'stash', '-q', '-u');
    git(clone, 'checkout', '-q', 'main');
    expect(await workGitFacts(item())).toMatchObject({ checkedOut: false, dirty: null, ahead: 1 });
  });

  it('says which branches already contain it, whatever they are called', async () => {
    git(clone, 'push', '-q', '-u', 'origin', 'feature/x');
    git(clone, 'checkout', '-q', '-b', 'weekly/47', 'main');
    git(clone, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature/x');
    git(clone, 'push', '-q', '-u', 'origin', 'weekly/47');
    const named = item({ uatBranch: 'weekly/47', releaseBranch: 'rel-2026.12' });
    const inUat = await workGitFacts(named);
    // one fact per branch although it exists locally and on the remote
    expect(inUat.mergedInto).toEqual(['origin/weekly/47']);
    expect(inUat).toMatchObject({ inUat: true, inRelease: false, checkedOut: false });
    git(clone, 'checkout', '-q', '-b', 'rel-2026.12', 'weekly/47');
    expect(await workGitFacts(named)).toMatchObject({
      mergedInto: ['origin/weekly/47', 'rel-2026.12'],
      inRelease: true,
    });
    // the branch deleted locally after the merge: the remote still has it
    git(clone, 'branch', '-q', '-D', 'feature/x');
    expect(await workGitFacts(named)).toMatchObject({
      available: true,
      upstream: null,
      inUat: true,
    });
  });

  it('explains what it cannot read instead of failing', async () => {
    const reason = async (o: Partial<WorkItem>) => (await workGitFacts(item(o))).reason;
    expect(await reason({ clone: null })).toBe('no local clone recorded');
    expect(await reason({ clone: join(root, 'gone') })).toBe('the clone is not on this machine');
    expect(await reason({ clone: 'relative/path' })).toBe('the clone path is not absolute');
    expect(await reason({ clone: root })).toBe('the clone is not a git repository any more');
    expect(await reason({ branch: 'no/such' })).toBe('the branch is not in the clone');
    expect(await reason({ branch: '--upload-pack=x' })).toBe('no branch recorded');
  });
});

describe('WorkGit', () => {
  it('asks git once a minute per branch, unless told to look again', async () => {
    let calls = 0;
    let clock = 0;
    const counting = new WorkGit(
      async (cwd, args) => {
        calls++;
        return git(cwd, ...args);
      },
      () => clock,
    );
    const first = await counting.all([item(), item({ path: 'work/y.md', branch: 'main' })]);
    expect(first.map((f) => f.available)).toEqual([true, true]);
    const after = calls;
    await counting.all([item()]);
    expect(calls).toBe(after);
    clock += 61_000;
    await counting.all([item()]);
    expect(calls).toBeGreaterThan(after);
    const again = calls;
    await counting.all([item()], true);
    expect(calls).toBeGreaterThan(again);
  });
});
