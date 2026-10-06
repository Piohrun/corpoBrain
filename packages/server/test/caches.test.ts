import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { buildBoard } from '../src/plan-routes.ts';
import { buildTree } from '../src/tree-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeEach(() => {
  root = join(tmpdir(), `cb-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  write('people/anna.md', '---\ntype: person\ntitle: Anna\njira: anna\ncapacity: 8\n---\n');
  write(
    'jira/EXEC-1.md',
    '---\ntype: jira\nkey: EXEC-1\nassignee: anna\nestimate: 3\n---\n<!-- jira:end -->\n',
  );
  write('daily/2026-10-06.md', '# today\n');
  vault = new VaultService(root, ':memory:');
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('derived-model caches', () => {
  it('keeps the board across unrelated saves and rebuilds it for planning changes', () => {
    const board = buildBoard(vault);
    vault.write('daily/2026-10-06.md', '# today\n\nwrote something\n');
    vault.write('notes/idea.md', '# idea\n');
    expect(buildBoard(vault)).toBe(board);

    vault.write(
      'jira/EXEC-1.md',
      '---\ntype: jira\nkey: EXEC-1\nassignee: anna\nestimate: 5\n---\n<!-- jira:end -->\n',
    );
    const after = buildBoard(vault);
    expect(after).not.toBe(board);
    expect(after.issues[0]?.estimate).toBe(5);

    // a person note outside the people folder still counts
    vault.write('notes/bob.md', '---\ntype: person\ntitle: Bob\njira: bob\n---\n');
    expect(
      buildBoard(vault)
        .people.map((p) => p.name)
        .sort(),
    ).toEqual(['Anna', 'Bob']);
    // the availability note is read from disk by the board
    const before = buildBoard(vault);
    vault.write(
      vault.config.availability.file,
      '| Person | From | To | Type |\n|---|---|---|---|\n',
    );
    expect(buildBoard(vault)).not.toBe(before);
    // config is a planning input too
    const cfg = buildBoard(vault);
    vault.updateConfig('capacity', { defaultCapacity: 6 });
    expect(buildBoard(vault)).not.toBe(cfg);
  });

  it('rebuilds the tree on any change and serves it from cache otherwise', () => {
    const tree = buildTree(vault);
    expect(buildTree(vault)).toBe(tree);
    vault.write('notes/child.md', '---\nparent: "[[today]]"\n---\n# child\n');
    const next = buildTree(vault);
    expect(next).not.toBe(tree);
    const daily = next.folders.find((f) => f.folder === 'daily')?.roots[0];
    expect(daily?.children.map((c) => c.path)).toEqual(['notes/child.md']);
  });

  it('answers 304 for unchanged index-derived lists, and fresh data after a change', async () => {
    const app = createApp(vault);
    const first = await app.request('/api/notes');
    const etag = first.headers.get('etag') as string;
    expect(etag).toMatch(/^W\/".+-\d+"$/);
    const again = await app.request('/api/notes', { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    vault.write('notes/new.md', '# new\n');
    const changed = await app.request('/api/notes', { headers: { 'If-None-Match': etag } });
    expect(changed.status).toBe(200);
    expect(
      ((await changed.json()) as { path: string }[]).some((n) => n.path === 'notes/new.md'),
    ).toBe(true);
    // a fresh server never matches tags from a previous process
    const other = createApp(new VaultService(root, ':memory:'));
    expect((await other.request('/api/notes', { headers: { 'If-None-Match': etag } })).status).toBe(
      200,
    );
  });
});
