import { describe, expect, it } from 'vitest';
import {
  arrangeCalendar,
  type CalendarInput,
  dateOfIndex,
  dayIndexOf,
  layoutCalendar,
} from '../src/calendar.ts';
import type { ProjectIssue } from '../src/projects.ts';

// Mon 31 Aug – Fri 25 Sep 2026: four full working weeks
const DAYS: string[] = [];
{
  const d = new Date('2026-08-31T00:00:00Z');
  while (DAYS.length < 20) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) DAYS.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function issue(over: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    key: 'EXEC-1',
    path: 'jira/EXEC-1.md',
    summary: 'Thing',
    status: 'To Do',
    statusCategory: 'new',
    priority: 'Medium',
    epic: null,
    labels: [],
    effectiveSprint: 'Sprint 37',
    effectiveAssignee: 'anna',
    effectiveEffort: 3,
    dependsOn: [],
    blockedBy: [],
    plan: { project: null, rank: null, start: null },
    ...over,
  };
}
const plan = (over: Partial<ProjectIssue['plan']>): ProjectIssue['plan'] => ({
  project: null,
  rank: null,
  start: null,
  ...over,
});

const input = (issues: ProjectIssue[], away: Record<string, number[]> = {}): CalendarInput => ({
  days: DAYS,
  issues,
  sprintFrom: { 'Sprint 37': 0, 'Sprint 38': 10 },
  away,
  toDays: (e) => e,
  unestimatedDays: 2,
});

describe('day maths', () => {
  it('maps dates to indexes, extrapolating past the grid on workdays', () => {
    expect(dayIndexOf(DAYS, '2026-08-31')).toBe(0);
    expect(dayIndexOf(DAYS, '2026-09-07')).toBe(5); // second Monday
    expect(dayIndexOf(DAYS, '2026-08-01')).toBe(-1); // before the grid
    expect(dayIndexOf(DAYS, '2026-09-28')).toBe(20); // Monday after the grid
    expect(dateOfIndex(DAYS, 5)).toBe('2026-09-07');
    expect(dateOfIndex(DAYS, 20)).toBe('2026-09-28');
  });
});

describe('layoutCalendar', () => {
  it('pins a block to its start day with width = effort days', () => {
    const { blocks } = layoutCalendar(
      input([issue({ plan: plan({ start: '2026-09-02' }), effectiveEffort: 4 })]),
    );
    expect(blocks[0]).toMatchObject({ start: 2, span: 4, workDays: 4, pinned: true });
  });

  it('stretches a block over away days instead of shrinking the work', () => {
    // Anna away Thu+Fri of week one (indexes 3,4)
    const { blocks } = layoutCalendar(
      input([issue({ plan: plan({ start: '2026-09-02' }), effectiveEffort: 4 })], {
        anna: [3, 4],
      }),
    );
    // needs days 2,5,6,7 → spans 2..7
    expect(blocks[0]).toMatchObject({ start: 2, span: 6, workDays: 4, awayDays: 2 });
  });

  it('flows unpinned work into its sprint after what is already there', () => {
    const { blocks } = layoutCalendar(
      input([
        issue({ key: 'A', plan: plan({ start: '2026-08-31' }), effectiveEffort: 3 }),
        issue({ key: 'B', effectiveEffort: 2, plan: plan({ rank: 1 }) }),
        issue({ key: 'C', effectiveEffort: 2, effectiveSprint: 'Sprint 38' }),
      ]),
    );
    const byKey = Object.fromEntries(blocks.map((b) => [b.key, b]));
    expect(byKey.B).toMatchObject({ start: 3, pinned: false }); // right after A
    expect(byKey.C).toMatchObject({ start: 10 }); // Sprint 38 begins at day 10
  });

  it('flags overlapping pinned blocks on both sides instead of hiding one', () => {
    const { blocks } = layoutCalendar(
      input([
        issue({ key: 'A', plan: plan({ start: '2026-09-01' }), effectiveEffort: 3 }),
        issue({ key: 'B', plan: plan({ start: '2026-09-02' }), effectiveEffort: 3 }),
      ]),
    );
    expect(blocks.every((b) => b.conflict)).toBe(true);
  });

  it('leaves different people alone and pools unassigned work on its own row', () => {
    const { blocks } = layoutCalendar(
      input([
        issue({ key: 'A', plan: plan({ start: '2026-09-01' }) }),
        issue({ key: 'B', plan: plan({ start: '2026-09-01' }), effectiveAssignee: 'bob' }),
        issue({ key: 'C', plan: plan({ start: '2026-09-01' }), effectiveAssignee: null }),
      ]),
    );
    expect(blocks.every((b) => !b.conflict)).toBe(true);
    expect(blocks.find((b) => b.key === 'C')?.assignee).toBe('(unassigned)');
  });

  it('clamps a start before the grid and keeps unknown-sprint work off it', () => {
    const r = layoutCalendar(
      input([
        issue({ key: 'A', plan: plan({ start: '2026-01-05' }) }),
        issue({ key: 'B', effectiveSprint: 'Backlog' }),
      ]),
    );
    expect(r.blocks[0]).toMatchObject({ start: 0, clamped: true });
    expect(r.unplaced).toEqual(['B']);
  });

  it('reports blockers that do not finish before their dependents start', () => {
    const { blocks } = layoutCalendar(
      input([
        issue({ key: 'A', plan: plan({ start: '2026-09-07' }), effectiveEffort: 5 }),
        issue({
          key: 'B',
          plan: plan({ start: '2026-09-02' }),
          effectiveAssignee: 'bob',
          dependsOn: ['A'],
        }),
      ]),
    );
    expect(blocks.find((b) => b.key === 'B')?.lateDeps).toEqual(['A']);
  });

  it('sizes unestimated work with the fallback', () => {
    const { blocks } = layoutCalendar(input([issue({ effectiveEffort: null })]));
    expect(blocks[0]).toMatchObject({ workDays: 2, estimated: false });
  });
});

describe('arrangeCalendar', () => {
  it('schedules dependencies first and packs each person forward', () => {
    const r = arrangeCalendar(
      input([
        issue({ key: 'A', effectiveEffort: 3 }),
        issue({ key: 'B', effectiveEffort: 2, dependsOn: ['A'] }),
        issue({ key: 'C', effectiveEffort: 2, effectiveAssignee: 'bob' }),
      ]),
    );
    expect(r.starts.get('A')).toBe('2026-08-31');
    expect(r.starts.get('B')).toBe('2026-09-03'); // after A's three days
    expect(r.starts.get('C')).toBe('2026-08-31'); // parallel person
    expect(r.finishDate).toBe('2026-09-04');
    expect(r.cycles).toEqual([]);
  });

  it('waits for a blocker across people and skips away days', () => {
    const r = arrangeCalendar(
      input(
        [
          issue({ key: 'A', effectiveEffort: 2 }),
          issue({ key: 'B', effectiveEffort: 2, effectiveAssignee: 'bob', dependsOn: ['A'] }),
        ],
        { bob: [2] },
      ),
    );
    expect(r.starts.get('B')).toBe('2026-09-03'); // A ends day 1; bob away day 2
  });

  it('never schedules before the notBefore day (today)', () => {
    const r = arrangeCalendar({ ...input([issue({ effectiveEffort: 2 })]), notBefore: 5 });
    expect(r.starts.get('EXEC-1')).toBe('2026-09-07'); // day 5, not the grid start
  });

  it('reports cycles instead of hanging', () => {
    const r = arrangeCalendar(
      input([issue({ key: 'A', dependsOn: ['B'] }), issue({ key: 'B', dependsOn: ['A'] })]),
    );
    expect(r.cycles[0]).toEqual(['A', 'B']);
    expect(r.starts.size).toBe(0);
  });
});
