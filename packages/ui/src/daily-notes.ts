/** Calendar groups for the sidebar only; note paths and parent relationships stay intact. */
import type { TreeNode } from './api.ts';
import { localISODate } from './dates.ts';

export interface DailyEntry {
  node: TreeNode;
  /** Original sibling position, used by the note tree's drag-and-drop actions. */
  index: number;
  date: string;
}

export interface DailyGroup {
  key: string;
  kind: 'year' | 'month' | 'week';
  label: string;
  count: number;
  defaultOpen: boolean;
  groups: DailyGroup[];
  notes: DailyEntry[];
}

const monthName = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
const shortMonth = new Intl.DateTimeFormat('en', { month: 'short', timeZone: 'UTC' });

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

/** UTC arithmetic treats these as calendar dates, independent of timezone and DST. */
function monday(date: Date): Date {
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

function weekLabel(start: Date): string {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const first = `${start.getUTCDate()}${start.getUTCMonth() === end.getUTCMonth() ? '' : ` ${shortMonth.format(start)}`}`;
  return `${first}–${end.getUTCDate()} ${shortMonth.format(end)}`;
}

export function groupDailyNotes(
  roots: TreeNode[],
  dailyFolder: string,
  today = localISODate(),
): { groups: DailyGroup[]; ungrouped: { node: TreeNode; index: number }[] } {
  const entries: DailyEntry[] = [];
  const ungrouped: { node: TreeNode; index: number }[] = [];
  roots.forEach((node, index) => {
    const date = node.path.split('/').pop()?.replace(/\.md$/, '') ?? '';
    if (node.path.startsWith(`${dailyFolder}/`) && calendarDate(date))
      entries.push({ node, index, date });
    else ungrouped.push({ node, index });
  });
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.node.path.localeCompare(b.node.path));

  const groups: DailyGroup[] = [];
  const byKey = new Map<string, DailyGroup>();
  const current = calendarDate(today);
  const currentMonday = current ? monday(current).toISOString().slice(0, 10) : '';
  for (const entry of entries) {
    const date = calendarDate(entry.date) as Date;
    const start = monday(date);
    const week = start.toISOString().slice(0, 10);
    const year = entry.date.slice(0, 4);
    const month = entry.date.slice(0, 7);
    const levels = [
      { id: year, kind: 'year' as const, label: year, current: year === today.slice(0, 4) },
      {
        id: month,
        kind: 'month' as const,
        label: monthName.format(date),
        current: month === today.slice(0, 7),
      },
      {
        // A week spanning months appears in each month, with only that month's notes.
        id: `${month}/${week}`,
        kind: 'week' as const,
        label: weekLabel(start),
        current: week === currentMonday,
      },
    ];
    let siblings = groups;
    for (const level of levels) {
      const key = `${dailyFolder}/${level.id}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          kind: level.kind,
          label: level.label,
          count: 0,
          defaultOpen: level.current,
          groups: [],
          notes: [],
        };
        byKey.set(key, group);
        siblings.push(group);
      }
      group.count++;
      if (level.kind === 'week') group.notes.push(entry);
      siblings = group.groups;
    }
  }
  return { groups, ungrouped };
}

export function dailyGroupKeysForPath(groups: DailyGroup[], path: string | null): string[] {
  if (!path) return [];
  const contains = (node: TreeNode): boolean => node.path === path || node.children.some(contains);
  for (const group of groups) {
    if (group.notes.some(({ node }) => contains(node))) return [group.key];
    const children = dailyGroupKeysForPath(group.groups, path);
    if (children.length) return [group.key, ...children];
  }
  return [];
}
