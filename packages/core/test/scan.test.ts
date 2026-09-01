import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { maskInlineCode, scanMarkdown } from '../src/scan.ts';

const dir = join(import.meta.dirname, 'golden', 'scan');

describe('scanMarkdown (golden)', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    it(file, () => {
      const text = readFileSync(join(dir, file), 'utf8');
      const opts =
        file === 'jira-region.md'
          ? { skipUntilMarker: '<!-- jira:end -->' }
          : { jiraProjectKeys: ['EXEC'] };
      expect(scanMarkdown(text, opts)).toMatchSnapshot();
    });
  }
});

describe('scanMarkdown specifics', () => {
  const links = (text: string, opts = {}) => scanMarkdown(text, opts).links;

  it('parses all five wikilink forms', () => {
    const l = links('[[a]] [[a|x]] [[a#H]] [[a#^b1]] ![[a]]');
    expect(l.map((x) => [x.kind, x.target, x.fragment, x.alias])).toEqual([
      ['link', 'a', null, null],
      ['link', 'a', null, 'x'],
      ['link', 'a', 'H', null],
      ['link', 'a', '^b1', null],
      ['embed', 'a', null, null],
    ]);
  });

  it('within-note link has empty target', () => {
    expect(links('[[#Heading]]')[0]).toMatchObject({ target: '', fragment: 'Heading' });
  });

  it('does not double-count jira keys inside wikilinks', () => {
    const l = links('[[EXEC-1]] EXEC-2', { jiraProjectKeys: ['EXEC'] });
    expect(l).toHaveLength(2);
    expect(l[1]).toMatchObject({ kind: 'mention', target: 'EXEC-2' });
  });

  it('CRLF files scan identically', () => {
    const lf = scanMarkdown('---\nt: 1\n---\n[[a]]\n- [ ] t\n#x\n');
    const crlf = scanMarkdown('---\r\nt: 1\r\n---\r\n[[a]]\r\n- [ ] t\r\n#x\r\n');
    expect(crlf.links).toEqual(lf.links);
    expect(crlf.tasks).toEqual(lf.tasks);
    expect(crlf.tags).toEqual(lf.tags);
  });

  it('masks inline code preserving length', () => {
    const line = 'a `code` b ``x ` y`` c';
    expect(maskInlineCode(line)).toHaveLength(line.length);
    expect(maskInlineCode(line)).not.toContain('code');
  });

  it('frontmatter is never scanned', () => {
    const r = scanMarkdown('---\ntitle: "[[NotALink]] #notag"\n---\nBody\n');
    expect(r.links).toEqual([]);
    expect(r.tags).toEqual([]);
  });

  it('line numbers are 1-based file lines', () => {
    const r = scanMarkdown('---\nt: 1\n---\n\n[[a]]\n');
    expect(r.links[0]?.line).toBe(5);
  });
});

describe('jira task items', () => {
  it('marks `- j[ ]` lines as jira, independent of the checkbox state', () => {
    const r = scanMarkdown('- [ ] plain\n- j[ ] create a jira\n- j[x] created it\n- J[X] loud\n');
    expect(r.tasks.map((t) => [t.text, t.kind, t.done])).toEqual([
      ['plain', 'task', false],
      ['create a jira', 'jira', false],
      ['created it', 'jira', true],
      ['loud', 'jira', true],
    ]);
  });

  it('accepts the `- [j]` shorthand as an open jira item', () => {
    const r = scanMarkdown('- [j] prioritise EXEC-1\n');
    expect(r.tasks[0]).toMatchObject({ text: 'prioritise EXEC-1', kind: 'jira', done: false });
  });

  it('keeps due dates, block ids and wikilinks working on jira items', () => {
    const r = scanMarkdown('- j[ ] split [[EXEC-9]] 📅 2026-09-30 ^abc\n');
    expect(r.tasks[0]).toMatchObject({ kind: 'jira', due: '2026-09-30', blockId: 'abc' });
    expect(r.tasks[0]?.text).toBe('split [[EXEC-9]]');
  });

  it('does not treat other bracket letters as tasks', () => {
    expect(scanMarkdown('- k[ ] nope\n- [k] also nope\n').tasks).toEqual([]);
  });
});
