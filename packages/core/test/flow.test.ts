import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  flowTimes,
  mentionsSprint,
  percentile,
  sprintChurn,
  statusBands,
} from '../src/flow.ts';
import type { Transition } from '../src/jira/render.ts';

const t = (
  at: string,
  field: Transition['field'],
  from: string | null,
  to: string | null,
): Transition => ({
  at,
  field,
  from,
  to,
  author: 'Anna',
});
const cat = (s: string) =>
  s === 'Done' || s === 'Closed' ? 'done' : s === 'To Do' ? 'new' : 'indeterminate';
const now = new Date('2026-09-10T00:00:00Z');

describe('statusBands + flowTimes', () => {
  it('reconstructs the status timeline and derives cycle, lead and time in status', () => {
    const bands = statusBands(
      '2026-09-01T00:00:00Z',
      [
        t('2026-09-03T00:00:00Z', 'status', 'To Do', 'In Progress'),
        t('2026-09-02T00:00:00Z', 'assignee', null, 'Anna'), // ignored
        t('2026-09-05T12:00:00Z', 'status', 'In Progress', 'Review'),
        t('2026-09-07T00:00:00Z', 'status', 'Review', 'Done'),
        t('2026-09-08T00:00:00Z', 'status', 'Done', 'Closed'), // not a reopen
      ],
      'Closed',
    );
    expect(bands.map((b) => b.status)).toEqual([
      'To Do',
      'In Progress',
      'Review',
      'Done',
      'Closed',
    ]);
    const f = flowTimes(bands, cat, now);
    expect(f.startedAt).toBe('2026-09-03T00:00:00Z');
    expect(f.doneAt).toBe('2026-09-07T00:00:00Z');
    expect(f.cycleDays).toBe(4);
    expect(f.leadDays).toBe(6);
    expect(f.ageDays).toBeNull();
    expect(f.perStatus).toEqual({
      'To Do': 2,
      'In Progress': 2.5,
      Review: 1.5,
      Done: 1,
      Closed: 2,
    });
  });

  it('open issues report age since started and days in the current status', () => {
    const bands = statusBands(
      '2026-09-01T00:00:00Z',
      [t('2026-09-04T00:00:00Z', 'status', 'To Do', 'In Progress')],
      'In Progress',
    );
    const f = flowTimes(bands, cat, now);
    expect(f).toMatchObject({ doneAt: null, cycleDays: null, ageDays: 6, inStatusDays: 6 });
    // never started: no age, but time in To Do
    const idle = flowTimes(statusBands('2026-09-01T00:00:00Z', [], 'To Do'), cat, now);
    expect(idle).toMatchObject({ startedAt: null, ageDays: null, inStatusDays: 9 });
    // reopened: not done any more, cycle open again
    const re = flowTimes(
      statusBands(
        '2026-09-01T00:00:00Z',
        [
          t('2026-09-02T00:00:00Z', 'status', 'To Do', 'In Progress'),
          t('2026-09-03T00:00:00Z', 'status', 'In Progress', 'Done'),
          t('2026-09-05T00:00:00Z', 'status', 'Done', 'In Progress'),
        ],
        'In Progress',
      ),
      cat,
      now,
    );
    expect(re.doneAt).toBeNull();
    expect(re.ageDays).toBe(8);
  });

  it('percentile is nearest-rank; daysBetween rounds to 2 decimals', () => {
    expect(percentile([], 85)).toBeNull();
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 85)).toBe(9);
    expect(daysBetween('2026-09-01T00:00:00Z', '2026-09-01T06:00:00Z')).toBe(0.25);
  });
});

describe('sprintChurn', () => {
  it('finds issues added late, pulled out, and re-estimated during the sprint', () => {
    const sprint = {
      name: 'Sprint 37',
      start: '2026-08-31T09:00:00Z',
      end: '2026-09-11T17:00:00Z',
    };
    const byKey = new Map<string, Transition[]>([
      ['EXEC-1', [t('2026-08-28T00:00:00Z', 'sprint', null, 'Sprint 37')]], // planned in time
      [
        'EXEC-2',
        [
          t('2026-09-02T00:00:00Z', 'sprint', null, 'Sprint 37'), // late add
          t('2026-09-04T00:00:00Z', 'estimate', '3', '8'), // grew while in
        ],
      ],
      [
        'EXEC-3',
        [
          t('2026-08-20T00:00:00Z', 'sprint', 'Sprint 36', 'Sprint 36, Sprint 37'),
          t('2026-09-06T00:00:00Z', 'sprint', 'Sprint 36, Sprint 37', 'Sprint 36, Sprint 38'), // pulled
        ],
      ],
      ['EXEC-4', [t('2026-09-05T00:00:00Z', 'estimate', '1', '2')]], // never in the sprint
    ]);
    const churn = sprintChurn(sprint, byKey);
    expect(churn.added.map((a) => a.key)).toEqual(['EXEC-2']);
    expect(churn.removed.map((r) => `${r.key}→${r.to}`)).toEqual(['EXEC-3→Sprint 36, Sprint 38']);
    expect(churn.reestimated.map((r) => `${r.key} ${r.from}→${r.to}`)).toEqual(['EXEC-2 3→8']);
    expect(mentionsSprint('Sprint 36, Sprint 37', 'Sprint 3')).toBe(false);
  });
});
