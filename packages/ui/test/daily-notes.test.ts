import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../src/api.ts';
import { type DailyGroup, dailyGroupKeysForPath, groupDailyNotes } from '../src/daily-notes.ts';

const note = (path: string, children: TreeNode[] = []): TreeNode => ({
  path,
  title: path.split('/').pop() as string,
  type: 'note',
  order: null,
  children,
});
const leaves = (groups: DailyGroup[]): string[] =>
  groups.flatMap((group) => [...leaves(group.groups), ...group.notes.map(({ node }) => node.path)]);

describe('daily note calendar groups', () => {
  it('sorts dates newest first and retains original sibling positions and note titles', () => {
    const roots = ['2025-12-31', '2026-08-30', '2026-09-28', '2026-09-30', '2026-09-20'].map(
      (date) => note(`daily/${date}.md`),
    );
    const planningNote = roots.find((node) => node.path === 'daily/2026-09-30.md');
    if (planningNote) planningNote.title = 'Quarterly planning';
    const { groups } = groupDailyNotes(roots, 'daily', '2026-09-30');
    expect(groups.map((group) => [group.label, group.count])).toEqual([
      ['2026', 4],
      ['2025', 1],
    ]);
    expect(groups[0]?.groups.map((group) => group.label)).toEqual(['September', 'August']);
    const weeks = groups[0]?.groups[0]?.groups ?? [];
    expect(weeks.map((group) => group.label)).toEqual(['28 Sep–4 Oct', '14–20 Sep']);
    expect(weeks[0]?.notes.map(({ node, index }) => [node.title, index])).toEqual([
      ['Quarterly planning', 3],
      ['2026-09-28.md', 2],
    ]);
    expect(leaves(groups)).toEqual([
      'daily/2026-09-30.md',
      'daily/2026-09-28.md',
      'daily/2026-09-20.md',
      'daily/2026-08-30.md',
      'daily/2025-12-31.md',
    ]);
    expect(roots[0]?.path).toBe('daily/2025-12-31.md');
  });

  it('uses Monday–Sunday weeks and expands only the current periods by default', () => {
    const roots = ['2026-09-27', '2026-09-28', '2026-09-30', '2026-10-04', '2025-09-30'].map(
      (date) => note(`daily/${date}.md`),
    );
    const { groups } = groupDailyNotes(roots, 'daily', '2026-09-30');
    expect(groups.map((group) => group.defaultOpen)).toEqual([true, false]);
    const months = groups[0]?.groups ?? [];
    expect(months.map((group) => [group.label, group.defaultOpen])).toEqual([
      ['October', false],
      ['September', true],
    ]);
    expect(months[1]?.groups.map((group) => [group.label, group.count, group.defaultOpen])).toEqual(
      [
        ['28 Sep–4 Oct', 2, true],
        ['21–27 Sep', 1, false],
      ],
    );
    expect(leaves(groups)).toHaveLength(roots.length);
  });

  it('keeps boundary weeks in each note’s calendar year and month without duplication', () => {
    const roots = ['2025-12-31', '2026-01-01', '2026-01-04', '2026-01-05'].map((date) =>
      note(`daily/${date}.md`),
    );
    const { groups } = groupDailyNotes(roots, 'daily', '2026-01-01');
    expect(groups.map((group) => [group.label, group.count])).toEqual([
      ['2026', 3],
      ['2025', 1],
    ]);
    expect(groups[0]?.groups[0]?.groups.map((group) => [group.label, group.count])).toEqual([
      ['5–11 Jan', 1],
      ['29 Dec–4 Jan', 2],
    ]);
    expect(new Set(leaves(groups)).size).toBe(4);
  });

  it('accepts leap days and rejects impossible dates and notes outside the configured folder', () => {
    const roots = [
      'journal/days/2024-02-29.md',
      'journal/days/2025-02-29.md',
      'journal/days/2026-04-31.md',
      'journal/days/ideas.md',
      'journal/days-extra/2026-09-30.md',
      'notes/2026-09-30.md',
    ].map((path) => note(path));
    const { groups, ungrouped } = groupDailyNotes(roots, 'journal/days', '2026-09-30');
    expect(leaves(groups)).toEqual(['journal/days/2024-02-29.md']);
    expect(ungrouped.map(({ node }) => node)).toEqual(roots.slice(1));
  });

  it('preserves child notes and finds the groups to reveal for a selected descendant', () => {
    const child = note('notes/meeting.md');
    const root = note('daily/2026-09-30.md', [child]);
    const { groups } = groupDailyNotes([root], 'daily', '2026-09-30');
    expect(groups[0]?.groups[0]?.groups[0]?.notes[0]?.node).toBe(root);
    expect(dailyGroupKeysForPath(groups, child.path)).toEqual([
      'daily/2026',
      'daily/2026-09',
      'daily/2026-09/2026-09-28',
    ]);
    expect(dailyGroupKeysForPath(groups, 'notes/unrelated.md')).toEqual([]);
    expect(dailyGroupKeysForPath(groups, null)).toEqual([]);
  });

  it('handles DST transition weeks as calendar dates', () => {
    const roots = ['2026-03-28', '2026-03-29', '2026-03-30'].map((date) =>
      note(`daily/${date}.md`),
    );
    const { groups } = groupDailyNotes(roots, 'daily', '2026-03-29');
    expect(
      groups[0]?.groups[0]?.groups.map((group) => [group.label, group.count, group.defaultOpen]),
    ).toEqual([
      ['30 Mar–5 Apr', 1, false],
      ['23–29 Mar', 2, true],
    ]);
  });
});
