import { describe, expect, it } from 'vitest';
import type { ObjectRow } from '../src/api.ts';
import { sortRows } from '../src/components/ObjectsPage.tsx';

const row = (title: string, frontmatter: Record<string, unknown> = {}): ObjectRow => ({
  path: `x/${title}.md`,
  title,
  mtime: 0,
  frontmatter,
});
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const titles = (rows: ObjectRow[]) => rows.map((r) => r.title);

describe('sortRows', () => {
  const rows = [
    row('Anna', { capacity: 8, team: 'Gateway' }),
    row('Kit', { capacity: 10, team: 'QIS 2' }),
    row('Amit', { team: 'QIS 10' }),
    row('Navid', { capacity: 9 }),
  ];

  it('leaves the order alone until a column is chosen', () => {
    expect(sortRows(rows, null, text)).toBe(rows);
  });

  it('sorts numbers by value and keeps rows without one at the end, both ways', () => {
    expect(titles(sortRows(rows, { key: 'capacity', dir: 1 }, text))).toEqual([
      'Anna',
      'Navid',
      'Kit',
      'Amit',
    ]);
    expect(titles(sortRows(rows, { key: 'capacity', dir: -1 }, text))).toEqual([
      'Kit',
      'Navid',
      'Anna',
      'Amit',
    ]);
  });

  it('sorts text the way people read it', () => {
    expect(titles(sortRows(rows, { key: 'team', dir: 1 }, text))).toEqual([
      'Anna',
      'Kit',
      'Amit',
      'Navid',
    ]);
  });

  it('does not reorder the list it was given', () => {
    const before = titles(rows);
    sortRows(rows, { key: 'capacity', dir: -1 }, text);
    expect(titles(rows)).toEqual(before);
  });
});
