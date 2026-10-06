import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type VaultConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  index: { assignIds: false },
  jira: { ...DEFAULT_CONFIG.jira, projectKeys: ['EXEC'] },
};

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/** Everything the index derives, in a comparable form. */
function snapshot(ix: Indexer) {
  const all = (sql: string) => ix.db.prepare(sql).all();
  return {
    links: all(
      'SELECT src_path, dst_target, dst_path, ambiguous FROM links ORDER BY src_path, line, col, dst_target',
    ),
    notes: all('SELECT path, title, type FROM notes ORDER BY path'),
    jira: all('SELECT key, path FROM jira ORDER BY key'),
    plan: all('SELECT key, sprint FROM plan ORDER BY key'),
    people: all('SELECT path FROM people ORDER BY path'),
    fts: all("SELECT path FROM notes_fts WHERE notes_fts MATCH 'zebra' ORDER BY path"),
    ftsRows: all('SELECT count(*) AS n FROM notes_fts'),
  };
}

const fresh = () => {
  const ix = new Indexer(root, config, openDb(':memory:'));
  ix.rebuild();
  return snapshot(ix);
};

beforeEach(() => {
  root = join(tmpdir(), `cb-inc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  write('notes/alpha.md', '# Alpha\n\nzebra [[Beta]] [[gamma]] [[Shared]] EXEC-1\n');
  write('notes/beta.md', '---\naliases: [Bee]\n---\n# Beta\n\n[[Alpha]] [[bee]] [[people/anna]]\n');
  write('people/anna.md', '---\ntype: person\ntitle: Anna\njira: anna\n---\n[[Alpha]]\n');
  write(
    'jira/EXEC-1.md',
    '---\ntype: jira\nkey: EXEC-1\nplan:\n  sprint: S1\n---\n# EXEC-1\n\n<!-- jira:end -->\n[[Beta]]\n',
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('incremental indexing matches a full rebuild', () => {
  it('through renames, alias changes, duplicates, type changes and deletes', () => {
    const ix = new Indexer(root, config, openDb(':memory:'));
    ix.rebuild();
    expect(snapshot(ix)).toEqual(fresh());

    const steps: [string, () => string[]][] = [
      [
        'new note claims an alias',
        () => {
          write('notes/gamma-note.md', '---\ntitle: Gamma\naliases: [Shared]\n---\nzebra\n');
          return ['notes/gamma-note.md'];
        },
      ],
      [
        'second note makes the alias ambiguous',
        () => {
          write('notes/other.md', '---\ntitle: Other\naliases: [shared]\n---\n[[Gamma]]\n');
          return ['notes/other.md'];
        },
      ],
      [
        'same basename in another folder',
        () => {
          write('projects/alpha.md', '# Project alpha\n[[alpha]]\n');
          return ['projects/alpha.md'];
        },
      ],
      [
        'title change frees a name',
        () => {
          write('notes/gamma-note.md', '---\ntitle: Delta\n---\nno longer zebra\n');
          return ['notes/gamma-note.md'];
        },
      ],
      [
        'a person becomes a plain note',
        () => {
          write('people/anna.md', '---\ntitle: Anna\n---\n[[Alpha]]\n');
          return ['people/anna.md'];
        },
      ],
      [
        'the issue note is deleted',
        () => {
          unlinkSync(join(root, 'jira/EXEC-1.md'));
          return ['jira/EXEC-1.md'];
        },
      ],
      [
        'the ambiguous alias goes away',
        () => {
          unlinkSync(join(root, 'notes/other.md'));
          return ['notes/other.md'];
        },
      ],
      [
        'the issue comes back with a new plan',
        () => {
          write(
            'jira/EXEC-1.md',
            '---\ntype: jira\nkey: EXEC-1\nplan:\n  sprint: S2\n---\n# EXEC-1\n\n<!-- jira:end -->\nzebra\n',
          );
          return ['jira/EXEC-1.md'];
        },
      ],
    ];
    for (const [name, step] of steps) {
      ix.updatePaths(step());
      expect(snapshot(ix), name).toEqual(fresh());
    }
  });

  it('skips files the index already has when asked, and resolves names like the index', () => {
    const ix = new Indexer(root, config, openDb(':memory:'));
    ix.rebuild();
    const version = ix.version;
    expect(
      ix.updatePaths(['notes/alpha.md', 'notes/missing.md'], { onlyChanged: true }),
    ).toMatchObject({
      indexed: [],
      removed: [],
      unchanged: 1,
    });
    expect(ix.version).toBe(version);
    expect(ix.resolveName('bee')).toEqual({ dst: 'notes/beta.md', ambiguous: 0 });
    expect(ix.resolveName('People/Anna.md')).toEqual({ dst: 'people/anna.md', ambiguous: 0 });
    expect(ix.resolveName('EXEC-9')).toEqual({ dst: 'jira/EXEC-9.md', ambiguous: 0 });
    expect(ix.resolveName('nope')).toEqual({ dst: null, ambiguous: 0 });
  });
});
