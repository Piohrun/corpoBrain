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

  it('is harmless without a repo when git dir is a plain folder', async () => {
    const git = new GitService(root);
    expect(await git.isRepo()).toBe(false);
    expect(await git.log()).toEqual([]);
  });
});
