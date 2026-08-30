import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteFrontmatterKey,
  parseFrontmatter,
  patchFrontmatter,
  setFrontmatterKey,
  splitFrontmatter,
} from '../src/frontmatter.ts';

const dir = join(import.meta.dirname, 'golden', 'frontmatter');
const golden = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('parseFrontmatter (golden)', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    it(file, () => {
      const text = golden(file);
      const p = parseFrontmatter(text);
      expect({
        present: p.present,
        bodyOffset: p.bodyOffset,
        bodyLine: p.bodyLine,
        eol: JSON.stringify(p.eol),
        data: p.data,
        error: p.error,
        body: text.slice(p.bodyOffset),
      }).toMatchSnapshot();
    });
  }

  it('keeps dates as strings', () => {
    expect(parseFrontmatter(golden('complex.md')).data.date).toBe('2026-08-30');
  });
});

describe('round trip', () => {
  it('setting a key to its current rendering is byte-identical for simple keys', () => {
    const text = golden('basic.md');
    expect(setFrontmatterKey(text, 'title', 'Hello')).toBe(text);
  });

  it('touches only the target key (complex)', () => {
    const text = golden('complex.md');
    const out = setFrontmatterKey(text, 'date', '2026-09-01');
    expect(out).toBe(text.replace('date: 2026-08-30', 'date: 2026-09-01'));
  });

  it('replaces a nested block wholesale and preserves the rest', () => {
    const text = golden('complex.md');
    const out = setFrontmatterKey(text, 'plan', { sprint: 'Sprint 40', rank: 1 });
    expect(out).toContain('title: "Quoted: title"   # trailing comment');
    expect(out).toContain('plan:\n  sprint: Sprint 40\n  rank: 1\nlist:\n- one\n- two\n');
    expect(out).not.toContain('multi');
    expect(parseFrontmatter(out).data.plan).toEqual({ sprint: 'Sprint 40', rank: 1 });
  });

  it('appends new keys at the end and inserts id at the start', () => {
    const text = golden('basic.md');
    const a = setFrontmatterKey(text, 'new', 1);
    expect(a).toContain('tags: [a, b]\nnew: 1\n---');
    const b = setFrontmatterKey(text, 'id', 'X', { position: 'start' });
    expect(b.startsWith('---\nid: X\ntitle: Hello\n')).toBe(true);
  });

  it('creates a frontmatter block when none exists', () => {
    const out = setFrontmatterKey(golden('none.md'), 'id', 'ABC');
    expect(out).toBe('---\nid: ABC\n---\n# No frontmatter\n\nJust body.\n');
  });

  it('preserves CRLF', () => {
    const text = golden('crlf.md');
    const out = setFrontmatterKey(text, 'status', 'Done');
    expect(out).toBe('---\r\ntitle: Windows\r\nstatus: Done\r\n---\r\nBody\r\n');
    expect(deleteFrontmatterKey(out, 'status')).toBe('---\r\ntitle: Windows\r\n---\r\nBody\r\n');
  });

  it('deletes keys including multi-line ones', () => {
    const text = golden('complex.md');
    const out = deleteFrontmatterKey(text, 'plan');
    expect(out).toContain('date: 2026-08-30\nlist:\n- one');
    expect(out).not.toContain('sprint');
    expect(deleteFrontmatterKey(text, 'nope')).toBe(text);
  });

  it('patch applies sets and deletes', () => {
    const out = patchFrontmatter(golden('basic.md'), { tags: undefined, x: [1] });
    expect(out).toBe('---\ntitle: Hello\nx:\n  - 1\n---\n\n# Hello\n\nBody.\n');
  });

  it('empty block and unterminated block', () => {
    expect(splitFrontmatter(golden('empty-block.md'))).toMatchObject({ present: true, raw: '' });
    expect(setFrontmatterKey(golden('empty-block.md'), 'a', 1)).toBe('---\na: 1\n---\nBody only\n');
    expect(splitFrontmatter(golden('unterminated.md')).present).toBe(false);
  });

  it('handles BOM', () => {
    const text = '﻿---\ntitle: T\n---\nB\n';
    expect(parseFrontmatter(text).data.title).toBe('T');
    expect(setFrontmatterKey(text, 'k', 'v')).toBe('﻿---\ntitle: T\nk: v\n---\nB\n');
  });
});
