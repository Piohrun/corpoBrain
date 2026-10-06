import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type VaultWatcher, watchVault } from '../src/watch.ts';

let root: string;
let watcher: VaultWatcher | null = null;
beforeEach(() => {
  root = join(tmpdir(), `cb-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'notes', 'deep'), { recursive: true });
  mkdirSync(join(root, '.corpobrain'), { recursive: true });
});
afterEach(() => {
  watcher?.close();
  rmSync(root, { recursive: true, force: true });
});

describe.each([
  ['one watcher per folder', true],
  ['native recursive', false],
])('watchVault (%s)', (_name, perFolder) => {
  it('reports edits in existing, new and recreated folders, and ignores tool files', async () => {
    const seen = new Set<string>();
    watcher = watchVault(
      root,
      (paths) => {
        for (const p of paths) seen.add(p);
      },
      20,
      { perFolder },
    );
    const touch = (rel: string) => writeFileSync(join(root, rel), `${rel}\n`);
    touch('notes/a.md');
    touch('notes/deep/b.md');
    touch('.corpobrain/config.md');
    touch('notes/ignored.txt');
    await vi.waitFor(() => expect(seen).toEqual(new Set(['notes/a.md', 'notes/deep/b.md'])));

    mkdirSync(join(root, 'projects', 'q4'), { recursive: true });
    await new Promise((r) => setTimeout(r, 50));
    touch('projects/q4/plan.md');
    await vi.waitFor(() => expect(seen.has('projects/q4/plan.md')).toBe(true));

    // a folder of notes moved in at once: its notes are reported too
    const outside = `${root}-outside`;
    mkdirSync(join(outside, 'archive'), { recursive: true });
    writeFileSync(join(outside, 'archive', 'old.md'), 'old\n');
    renameSync(join(outside, 'archive'), join(root, 'archive'));
    rmSync(outside, { recursive: true });
    await vi.waitFor(() => expect(seen.has('archive/old.md')).toBe(true));

    rmSync(join(root, 'projects'), { recursive: true });
    await new Promise((r) => setTimeout(r, 50));
    mkdirSync(join(root, 'projects'));
    await new Promise((r) => setTimeout(r, 50));
    seen.clear();
    touch('projects/again.md');
    await vi.waitFor(() => expect(seen.has('projects/again.md')).toBe(true));
  });
});
