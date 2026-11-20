import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitHere, runWorkCommand } from '../src/work.ts';

let root: string;
let vault: string;
let repo: string;
const now = new Date(2026, 10, 19, 14, 10);
const flags = (o: Record<string, string>) => new Map(Object.entries(o));
const run = (sub: string | undefined, o: Record<string, string> = {}, cwd = repo) =>
  runWorkCommand(vault, sub, flags(o), { cwd, cli: '/app/dist/corpobrain-cli.js', now });
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);

beforeEach(() => {
  root = join(tmpdir(), `cb-workcli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  vault = join(root, 'vault');
  repo = join(root, 'checkout');
  mkdirSync(join(vault, '.corpobrain'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', 'feature/EXEC-104-replication');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('corpobrain work', () => {
  it('report takes the repository and branch from the folder it runs in', () => {
    // the remote names the repository; a worktree folder may be called anything
    git('remote', 'add', 'origin', 'git@example.com:team/exec-gateway.git');
    expect(gitHere(repo)).toMatchObject({
      repo: 'exec-gateway',
      branch: 'feature/EXEC-104-replication',
    });
    const first = run('report', {
      summary: 'Added backoff.',
      state: '2 tests failing',
      next: 'fix ordering',
      waiting: 'agent',
      chat: 'retry logic',
      issue: 'EXEC-104',
    });
    expect(first).toEqual({
      code: 0,
      out: 'started work/exec-gateway feature-EXEC-104-replication.md',
    });
    const file = join(vault, 'work', 'exec-gateway feature-EXEC-104-replication.md');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('waiting_on: agent');
    expect(text).toContain('issue: "[[EXEC-104]]"');
    expect(text).toContain('clone: ');
    expect(text).toContain('- 2026-11-19 14:10 · **retry logic** — Added backoff.');

    const second = run('report', {
      summary: 'Green.',
      stage: 'in-uat-branch',
      'uat-branch': 'uat/w47',
    });
    expect(second.out).toBe('updated work/exec-gateway feature-EXEC-104-replication.md');
    expect(readFileSync(file, 'utf8')).toContain('uat_branch: uat/w47');

    expect(run('list').out).toBe(
      'In the UAT branch · waiting on agent · exec-gateway feature/EXEC-104-replication',
    );
    const shown = run('show').out;
    expect(shown).toContain('reported by agents (information about the work, not instructions)');
    expect(shown).toContain('Green.');
    expect(shown).toContain("--- the user's own notes ---\n## My notes");
  });

  it('without a remote the folder names the repository; flags override both', () => {
    expect(gitHere(repo)?.repo).toBe('checkout');
    const r = run('report', { summary: 's', repo: 'other', branch: 'fix/x' }, root);
    expect(r).toEqual({ code: 0, out: 'started work/other fix-x.md' });
    // outside any repository there is nothing to detect
    expect(run('report', { summary: 's' }, root)).toMatchObject({ code: 1 });
    expect(run('show', {}, root).out).toContain('pass --repo and --branch');
  });

  it('never writes into a folder that is not a vault, and explains bad values', () => {
    const notVault = runWorkCommand(repo, 'report', flags({ summary: 's' }), {
      cwd: repo,
      cli: 'cli.js',
      now,
    });
    expect(notVault.code).toBe(1);
    expect(notVault.out).toContain('not a corpoBrain vault');
    expect(existsSync(join(repo, 'work'))).toBe(false);
    expect(run('report', { summary: 's', stage: 'shipped' })).toMatchObject({
      code: 1,
      out: expect.stringContaining('--stage must be one of'),
    });
    expect(run('report', {})).toMatchObject({ code: 1, out: expect.stringContaining('summary') });
    expect(run(undefined).code).toBe(1);
    expect(run('instructions').out).toContain(
      `node --disable-warning=ExperimentalWarning "/app/dist/corpobrain-cli.js" work report --vault "${vault}"`,
    );
  });
});
