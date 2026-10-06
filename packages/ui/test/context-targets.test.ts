import { describe, expect, it } from 'vitest';
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  linesToTasks,
  linkAt,
  setTaskDue,
  tableCellAt,
  taskLine,
  toggleTask,
  toggleTaskKind,
} from '../src/editor/contextTargets.ts';

describe('linkAt', () => {
  const line =
    'See [[Roadmap|the plan]], EXEC-12 and [docs](https://x.example/a) or [[people/anna]].';
  it('finds the link under the cursor and nothing elsewhere', () => {
    expect(linkAt(line, 8)).toEqual({ kind: 'note', target: 'Roadmap' });
    expect(linkAt(line, 28)).toEqual({ kind: 'jira', key: 'EXEC-12' });
    expect(linkAt(line, 42)).toEqual({ kind: 'url', url: 'https://x.example/a' });
    expect(linkAt(line, line.indexOf('anna'))).toEqual({ kind: 'note', target: 'people/anna' });
    expect(linkAt(line, 1)).toBeNull();
    expect(linkAt('[[EXEC-9]]', 3)).toEqual({ kind: 'jira', key: 'EXEC-9' });
    expect(linkAt('go to https://a.b/c.', 10)).toEqual({ kind: 'url', url: 'https://a.b/c' });
    expect(linkAt('[x](notes/a%20b.md)', 1)).toEqual({ kind: 'note', target: 'notes/a b' });
  });
});

describe('task lines', () => {
  it('toggles, switches kind and sets due dates without losing the rest of the line', () => {
    expect(taskLine('  - [ ] call Anna')).toEqual({ done: false, jira: false });
    expect(taskLine('- j[x] ticket')).toEqual({ done: true, jira: true });
    expect(taskLine('just text')).toBeNull();
    expect(toggleTask('- [ ] a')).toBe('- [x] a');
    expect(toggleTask('- j[x] a')).toBe('- j[ ] a');
    expect(toggleTask('- [j] a')).toBe('- j[x] a');
    expect(toggleTaskKind('- [ ] a')).toBe('- j[ ] a');
    expect(toggleTaskKind('- j[x] a')).toBe('- [x] a');
    expect(toggleTaskKind('- [j] a')).toBe('- [ ] a');
    expect(setTaskDue('- [ ] a 📅 2026-01-01 ^ol-1a', '2026-10-09')).toBe(
      '- [ ] a 📅 2026-10-09 ^ol-1a',
    );
    expect(setTaskDue('- [ ] a @due(2026-01-01)', '2026-10-09')).toBe('- [ ] a 📅 2026-10-09');
    expect(setTaskDue('- [ ] a 📅 2026-01-01', null)).toBe('- [ ] a');
    expect(linesToTasks('one\n- two\n\n  three\n- [x] done')).toBe(
      '- [ ] one\n- [ ] two\n\n  - [ ] three\n- [x] done',
    );
  });
});

describe('tables', () => {
  const t = ['| A | B |', '|---|:-:|', '| 1 | 2 |', '| 3 | x\\|y |'];
  it('locates the cell under the cursor', () => {
    expect(tableCellAt(t, 0, 2)).toEqual({ row: -1, col: 0 });
    expect(tableCellAt(t, 2, 6)).toEqual({ row: 0, col: 1 });
    expect(tableCellAt(t, 3, 9)).toEqual({ row: 1, col: 1 }); // the escaped pipe is not a border
  });
  it('inserts and deletes rows and columns, keeping alignment and escapes', () => {
    expect(insertRow(t, 0)).toEqual([
      '| A | B |',
      '|---|:-:|',
      '| 1 | 2 |',
      '|  |  |',
      '| 3 | x\\|y |',
    ]);
    expect(insertRow(t, -1)[2]).toBe('|  |  |');
    expect(deleteRow(t, 0)).toEqual(['| A | B |', '|---|:-:|', '| 3 | x\\|y |']);
    expect(deleteRow(t, -1)).toBe(t);
    expect(insertColumn(t, 0)).toEqual([
      '| A |  | B |',
      '| --- | --- | :-: |',
      '| 1 |  | 2 |',
      '| 3 |  | x\\|y |',
    ]);
    expect(deleteColumn(t, 0)).toEqual(['| B |', '| :-: |', '| 2 |', '| x\\|y |']);
    expect(deleteColumn(['| A |', '|---|'], 0)).toEqual(['| A |', '|---|']);
  });
});
