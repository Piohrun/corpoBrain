import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../src/git-service.ts';

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `cb-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('GitService', () => {
  it('init, commit, no-op commit, log', async () => {
    const git = new GitService(root);
    expect(await git.available()).toBe(true);
    writeFileSync(join(root, 'a.md'), 'one\n');
    expect(await git.ensureRepo()).toBe(true);
    expect(await git.isRepo()).toBe(true);
    // nothing changed → null
    expect(await git.commitAll('vault: nothing')).toBeNull();
    writeFileSync(join(root, 'a.md'), 'two\n');
    const hash = await git.commitAll('vault: change');
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    const log = await git.log();
    expect(log[0]?.message).toBe('vault: change');
    expect(log[1]?.message).toBe('vault: initial commit');
  });

  it('auto-commit tick skips git entirely while the change counter is still', async () => {
    const git = new GitService(root);
    writeFileSync(join(root, 'a.md'), 'one\n');
    expect(await git.ensureRepo()).toBe(true);
    let seq = 0;
    const state = { lastSeq: null as number | null };
    const { autoCommitTick } = await import('../src/git-service.ts');
    // first tick always looks (something may be dirty from before this process)
    writeFileSync(join(root, 'a.md'), 'two\n');
    expect(await autoCommitTick(git, state, () => seq)).toMatch(/^[0-9a-f]{7,}$/);
    // nothing written since: git is not even asked
    writeFileSync(join(root, 'a.md'), 'three\n'); // an edit the counter did not see
    expect(autoCommitTick(git, state, () => seq)).toBeNull();
    expect((await git.log())[0]?.message).toContain('auto-commit');
    expect((await git.log()).length).toBe(2);
    // the counter moves: the pending edit gets committed
    seq++;
    expect(await autoCommitTick(git, state, () => seq)).toMatch(/^[0-9a-f]{7,}$/);
    expect((await git.log()).length).toBe(3);
  });

  it('is harmless without a repo when git dir is a plain folder', async () => {
    const git = new GitService(root);
    expect(await git.isRepo()).toBe(false);
    expect(await git.log()).toEqual([]);
  });
});

describe('git status and error tracking', () => {
  it('status reports repo state, head, dirty count; errors are recorded', async () => {
    const { gitFor } = await import('../src/git-service.ts');
    const git = gitFor(root);
    expect((await git.status()).isRepo).toBe(false);
    writeFileSync(join(root, 'a.md'), 'x\n');
    await git.ensureRepo();
    const st = await git.status();
    expect(st.isRepo).toBe(true);
    expect(st.head?.message).toContain('initial commit');
    expect(st.lastError).toBeNull();
    writeFileSync(join(root, 'b.md'), 'y\n');
    expect((await git.status()).dirtyFiles).toBe(1);
    await git.commitAll('vault: change');
    expect(git.lastCommit?.message).toBe('vault: change');
  });
});

describe('nested vault safety', () => {
  it('a vault inside a parent repo is not "a repo" and gets its own on ensureRepo', async () => {
    const parent = new GitService(root);
    writeFileSync(join(root, 'outer.md'), 'outer\n');
    await parent.ensureRepo();
    const vaultDir = join(root, 'my-vault');
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, 'note.md'), 'inner\n');
    const vaultGit = new GitService(vaultDir);
    expect(await vaultGit.isRepo()).toBe(false); // nested ≠ own repo
    expect(await vaultGit.ensureRepo()).toBe(true);
    expect(await vaultGit.isRepo()).toBe(true);
    const log = await vaultGit.log();
    expect(log).toHaveLength(1); // its own history, not the parent's
    expect((await parent.log()).length).toBe(1);
  });
});
