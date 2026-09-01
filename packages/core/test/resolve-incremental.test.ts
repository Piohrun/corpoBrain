import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';

let root: string;
let idx: Indexer;

const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const resolution = (src: string) =>
  idx.db
    .prepare('SELECT dst_target, dst_path, ambiguous FROM links WHERE src_path = ? ORDER BY line')
    .all(src) as { dst_target: string; dst_path: string | null; ambiguous: number }[];

beforeEach(() => {
  root = join(tmpdir(), `cb-res-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  idx = new Indexer(root, structuredClone(DEFAULT_CONFIG), openDb(':memory:'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('incremental link resolution', () => {
  it('resolves pending links when their target appears, re-flags on ambiguity, and undoes on delete', () => {
    write('notes/a.md', '---\nid: A\n---\nSee [[Beta]] and [[notes/gamma]].\n');
    idx.update();
    expect(resolution('notes/a.md')).toEqual([
      { dst_target: 'Beta', dst_path: null, ambiguous: 0 },
      { dst_target: 'notes/gamma', dst_path: null, ambiguous: 0 },
    ]);

    // a note titled Beta appears: only a.md's first link should flip
    write('notes/b.md', '---\nid: B\ntitle: Beta\n---\nhi\n');
    idx.updatePaths(['notes/b.md']);
    expect(resolution('notes/a.md')[0]).toMatchObject({ dst_path: 'notes/b.md' });

    // a second Beta (by basename) makes the title link ambiguous
    write('notes/x/beta.md', '---\nid: C\n---\nother\n');
    idx.updatePaths(['notes/x/beta.md']);
    expect(resolution('notes/a.md')[0]).toMatchObject({ dst_path: null, ambiguous: 1 });

    // deleting it resolves the link again without touching anything else
    unlinkSync(join(root, 'notes', 'x', 'beta.md'));
    idx.updatePaths(['notes/x/beta.md']);
    expect(resolution('notes/a.md')[0]).toMatchObject({ dst_path: 'notes/b.md', ambiguous: 0 });

    // path-style target resolves when the file shows up
    write('notes/gamma.md', '---\nid: G\n---\ngamma\n');
    idx.updatePaths(['notes/gamma.md']);
    expect(resolution('notes/a.md')[1]).toMatchObject({ dst_path: 'notes/gamma.md' });
  });

  it('follows alias changes of an existing note', () => {
    write('notes/a.md', '---\nid: A\n---\n[[Old Name]] [[New Name]]\n');
    write('notes/t.md', '---\nid: T\ntitle: Old Name\n---\n');
    idx.update();
    expect(resolution('notes/a.md').map((l) => l.dst_path)).toEqual(['notes/t.md', null]);
    write('notes/t.md', '---\nid: T\ntitle: New Name\n---\n');
    idx.updatePaths(['notes/t.md']);
    expect(resolution('notes/a.md').map((l) => l.dst_path)).toEqual([null, 'notes/t.md']);
  });

  it('matches the full rebuild answer after a series of incremental updates', () => {
    for (let i = 0; i < 30; i++)
      write(
        `notes/n${i}.md`,
        `---\nid: N${i}\n---\n[[n${(i + 1) % 30}]] [[Title ${i % 7}]] [[EXEC-${i}]]\n`,
      );
    idx.update();
    for (let i = 0; i < 7; i++) write(`notes/t${i}.md`, `---\nid: T${i}\ntitle: Title ${i}\n---\n`);
    idx.updatePaths(Array.from({ length: 7 }, (_, i) => `notes/t${i}.md`));
    unlinkSync(join(root, 'notes', 'n3.md'));
    idx.updatePaths(['notes/n3.md']);
    const snapshot = () =>
      idx.db
        .prepare(
          'SELECT src_path, dst_target, dst_path, ambiguous FROM links ORDER BY src_path, line',
        )
        .all();
    const incremental = snapshot();
    idx.resolveAll();
    expect(incremental).toEqual(snapshot());
    expect(
      incremental.filter((l) => (l as { dst_path: string | null }).dst_path === null),
    ).toHaveLength(1); // only [[n3]]
  });
});
