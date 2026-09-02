import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type VaultConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';

let root: string;
let indexer: Indexer;

const config: VaultConfig = {
  ...DEFAULT_CONFIG,
  jira: { ...DEFAULT_CONFIG.jira, projectKeys: ['EXEC'] },
};

function write(rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  root = join(tmpdir(), `cb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  write(
    'notes/alpha.md',
    '---\nid: A1\ntitle: Alpha Note\naliases: [alfa]\ntags: [Project/X]\n---\n# Alpha\n\nLinks to [[Beta]] and [[EXEC-7]] and [[missing one]].\n#project/x\n- [ ] follow up 📅 2026-09-01\n',
  );
  write(
    'notes/beta.md',
    '---\nid: B1\ntitle: Beta\nowner: "[[Alpha Note]]"\n---\nMentions EXEC-9 inline.\n',
  );
  write(
    'jira/EXEC-7.md',
    '---\ntype: jira\nkey: EXEC-7\nsummary: Fix the gateway\nstatus: In Progress\nstatus_category: indeterminate\nassignee: jdoe\nsprint: Sprint 37\nestimate: 5\nepic: "[[EXEC-1]]"\njira:\n  synced: 2026-08-30T00:00:00Z\n  profile: team\nplan:\n  sprint: Sprint 39\n  rank: 2\n  blocked_on: ["[[EXEC-5]]"]\n---\n# EXEC-7 — Fix the gateway\n\nGenerated [[NotIndexed]] text.\n\n<!-- jira:end -->\n\nMy note about [[Alpha Note]].\n',
  );
  write(
    'people/anna.md',
    '---\nid: P1\ntype: person\ntitle: Anna Kowalska\njira: akowalska\ncapacity: 8\ncapacity_overrides:\n  Sprint 39: 4\n---\nNotes about Anna.\n',
  );
  write('private/x.md.enc', 'ENCRYPTED');
  const db = openDb(':memory:');
  indexer = new Indexer(root, config, db);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Indexer', () => {
  it('rebuild indexes notes, links, tags, tasks', () => {
    const s = indexer.rebuild();
    expect(s.indexed).toHaveLength(5);
    const notes = indexer.db
      .prepare('SELECT path, type, title, protected FROM notes ORDER BY path')
      .all();
    expect(notes).toMatchObject([
      { path: 'jira/EXEC-7.md', type: 'jira' },
      { path: 'notes/alpha.md', title: 'Alpha Note' },
      { path: 'notes/beta.md', title: 'Beta' },
      { path: 'people/anna.md', type: 'person', title: 'Anna Kowalska' },
      { path: 'private/x.md.enc', protected: 1, title: 'Protected note' },
    ]);
    expect(indexer.db.prepare("SELECT tag FROM tags WHERE path='notes/alpha.md'").all()).toEqual([
      { tag: 'project/x' },
    ]);
    expect(indexer.db.prepare('SELECT text, due FROM tasks').all()).toEqual([
      { text: 'follow up', due: '2026-09-01' },
    ]);
  });

  it('resolves links per spec order', () => {
    indexer.rebuild();
    const links = indexer.db
      .prepare(
        "SELECT dst_target, dst_path, kind FROM links WHERE src_path='notes/alpha.md' ORDER BY line, col",
      )
      .all() as { dst_target: string; dst_path: string | null; kind: string }[];
    expect(links).toEqual([
      { dst_target: 'Beta', dst_path: 'notes/beta.md', kind: 'link' },
      { dst_target: 'EXEC-7', dst_path: 'jira/EXEC-7.md', kind: 'link' },
      { dst_target: 'missing one', dst_path: null, kind: 'link' },
    ]);
    // mention + alias + property links
    const mention = indexer.db
      .prepare("SELECT dst_path FROM links WHERE src_path='notes/beta.md' AND kind='mention'")
      .get() as { dst_path: string };
    expect(mention.dst_path).toBe('jira/EXEC-9.md');
    const prop = indexer.db
      .prepare("SELECT dst_path FROM links WHERE src_path='notes/beta.md' AND kind='property'")
      .get() as { dst_path: string };
    expect(prop.dst_path).toBe('notes/alpha.md');
  });

  it('backlinks work and generated jira region is excluded', () => {
    indexer.rebuild();
    const back = indexer.backlinks('notes/alpha.md');
    expect(back.map((b) => [b.srcPath, b.kind])).toEqual([
      ['jira/EXEC-7.md', 'link'],
      ['notes/beta.md', 'property'],
    ]);
    expect(indexer.db.prepare("SELECT * FROM links WHERE dst_target='NotIndexed'").all()).toEqual(
      [],
    );
  });

  it('returns one backlink per source note and prefers a visible body link', () => {
    write(
      'notes/repeat.md',
      '---\nid: R1\ntitle: Repeat\nsource: "[[Alpha Note]]"\n---\nSee [[Alpha Note]] twice: [[Alpha Note]].\n',
    );
    indexer.rebuild();

    const backlinks = indexer
      .backlinks('notes/alpha.md')
      .filter((backlink) => backlink.srcPath === 'notes/repeat.md');
    expect(backlinks).toEqual([
      expect.objectContaining({ srcPath: 'notes/repeat.md', kind: 'link', line: 6 }),
    ]);
  });

  it('populates jira, plan, and people tables', () => {
    indexer.rebuild();
    expect(indexer.db.prepare('SELECT * FROM jira').get()).toMatchObject({
      key: 'EXEC-7',
      summary: 'Fix the gateway',
      sprint: 'Sprint 37',
      estimate: 5,
      epic: 'EXEC-1',
      synced: '2026-08-30T00:00:00Z',
      profile: 'team',
    });
    expect(indexer.db.prepare('SELECT * FROM plan').get()).toMatchObject({
      key: 'EXEC-7',
      sprint: 'Sprint 39',
      rank: 2,
      blocked_on_json: '["EXEC-5"]',
    });
    expect(indexer.db.prepare('SELECT * FROM people').get()).toMatchObject({
      name: 'Anna Kowalska',
      jira_id: '["akowalska"]',
      capacity: 8,
    });
  });

  it('assigns ids to notes that lack one (but never in jira/)', () => {
    write('notes/new.md', '# Fresh\n\nNo frontmatter.\n');
    const s = indexer.rebuild();
    expect(s.idsAssigned).toBe(1);
    const text = readFileSync(join(root, 'notes/new.md'), 'utf8');
    expect(text).toMatch(/^---\nid: [0-9A-HJKMNP-TV-Z]{26}\n---\n# Fresh\n/);
    const jiraText = readFileSync(join(root, 'jira/EXEC-7.md'), 'utf8');
    expect(jiraText).not.toContain('id:');
  });

  it('protected notes expose nothing', () => {
    indexer.rebuild();
    expect(indexer.search('ENCRYPTED')).toEqual([]);
    const row = indexer.db.prepare('SELECT * FROM notes WHERE protected=1').get() as Record<
      string,
      unknown
    >;
    expect(row.title).toBe('Protected note');
    expect(indexer.db.prepare("SELECT * FROM links WHERE src_path LIKE 'private%'").all()).toEqual(
      [],
    );
  });

  it('full-text search hits titles and bodies', () => {
    indexer.rebuild();
    expect(indexer.search('gateway')[0]?.path).toBe('jira/EXEC-7.md');
    expect(indexer.search('alpha')[0]?.path).toBe('notes/alpha.md');
    expect(indexer.search('nonexistentword')).toEqual([]);
  });

  it('incremental update: only changed files reindexed, deletes handled, links re-resolved', async () => {
    indexer.rebuild();
    await new Promise((r) => setTimeout(r, 10));
    // "missing one" becomes resolvable after creating the note
    write('notes/missing one.md', '---\nid: M1\ntitle: missing one\n---\nNow exists.\n');
    const s1 = indexer.update();
    expect(s1.indexed).toEqual(['notes/missing one.md']);
    expect(s1.unchanged).toBe(5);
    expect(indexer.unresolved()).toEqual([]);
    unlinkSync(join(root, 'notes/missing one.md'));
    const s2 = indexer.update();
    expect(s2.removed).toEqual(['notes/missing one.md']);
    expect(indexer.unresolved().map((u) => u.target)).toEqual(['missing one']);
  });

  it('ambiguous titles are flagged', () => {
    write('notes/dup1.md', '---\nid: D1\ntitle: Duplicate\n---\nx\n');
    write('notes/dup2.md', '---\nid: D2\ntitle: Duplicate\n---\ny\n');
    write('notes/refs.md', '---\nid: R1\n---\nSee [[Duplicate]].\n');
    indexer.rebuild();
    const u = indexer.unresolved();
    expect(u).toMatchObject([
      { target: 'missing one', ambiguous: 0 },
      { target: 'Duplicate', ambiguous: 1 },
    ]);
  });
});
