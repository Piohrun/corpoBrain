import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../../core/src/work-model.ts';
import { ageLabel, isQuiet, needsYou, quietDays, workInProgress } from '../src/work.ts';

const now = Date.parse('2026-11-20T12:00:00Z');
const item = (title: string, o: Partial<WorkItem> = {}): WorkItem => ({
  path: `work/${title}.md`,
  title,
  repo: 'r',
  branch: title,
  stage: 'dev',
  waitingOn: 'nobody',
  state: null,
  next: null,
  chat: null,
  updated: '2026-11-20T11:00:00Z',
  issue: null,
  uatBranch: null,
  releaseBranch: null,
  pr: null,
  clone: null,
  ...o,
});

describe('work in progress', () => {
  it('puts what needs you first, then what has gone quiet, then the freshest', () => {
    const list = workInProgress(
      [
        item('fresh', { updated: '2026-11-20T11:30:00Z' }),
        item('older', { updated: '2026-11-18T09:00:00Z' }),
        item('quiet', { updated: '2026-11-05T09:00:00Z' }),
        item('mine', { waitingOn: 'me', updated: '2026-11-01T09:00:00Z' }),
        item('done', { stage: 'released', waitingOn: 'me' }),
        item('shelved', { stage: 'parked' }),
      ],
      now,
    );
    expect(list.map((w) => w.title)).toEqual(['mine', 'quiet', 'fresh', 'older']);
  });

  it('knows whose move it is and how long nothing was reported', () => {
    expect(needsYou(item('a', { waitingOn: 'me' }))).toBe(true);
    expect(needsYou(item('a', { waitingOn: 'me', stage: 'released' }))).toBe(false);
    expect(quietDays(item('a', { updated: '2026-11-13T12:00:00Z' }), now)).toBe(7);
    expect(isQuiet(item('a', { updated: '2026-11-13T12:00:00Z' }), now)).toBe(true);
    expect(isQuiet(item('a', { updated: '2026-11-14T12:00:00Z' }), now)).toBe(false);
    expect(isQuiet(item('a', { updated: null }), now)).toBe(false);
    expect(isQuiet(item('a', { updated: '2026-01-01T00:00:00Z', stage: 'parked' }), now)).toBe(
      false,
    );
  });

  it('says how old the last report is', () => {
    const age = (updated: string | null) => ageLabel(item('a', { updated }), now);
    expect(age('2026-11-20T11:58:00Z')).toBe('just now');
    expect(age('2026-11-20T11:20:00Z')).toBe('40 min ago');
    expect(age('2026-11-20T07:00:00Z')).toBe('5 h ago');
    expect(age('2026-11-19T10:00:00Z')).toBe('yesterday');
    expect(age('2026-11-11T12:00:00Z')).toBe('9 days ago');
    expect(age(null)).toBe('');
    expect(age('not a date')).toBe('');
  });
});
