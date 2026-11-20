import { describe, expect, it } from 'vitest';
import type { WorkGitFacts, WorkItem } from '../../core/src/work-model.ts';
import {
  ageLabel,
  gitNotes,
  isQuiet,
  needsYou,
  quietDays,
  suggestedStage,
  workInProgress,
} from '../src/work.ts';

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

describe('what git adds', () => {
  const facts = (o: Partial<WorkGitFacts> = {}): WorkGitFacts => ({
    path: 'work/a.md',
    available: true,
    local: true,
    checkedOut: true,
    dirty: 0,
    upstream: 'origin/a',
    ahead: 0,
    behind: 0,
    lastCommit: null,
    mergedInto: [],
    inUat: null,
    inRelease: null,
    ...o,
  });

  it('warns about work that exists only on this machine', () => {
    expect(gitNotes(undefined)).toEqual([]);
    expect(gitNotes(facts({ available: false, dirty: 3 }))).toEqual([]);
    expect(gitNotes(facts())).toEqual([]);
    expect(gitNotes(facts({ dirty: 2, ahead: 3, behind: 1 })).map((n) => [n.text, n.tone])).toEqual(
      [
        ['2 uncommitted', 'warn'],
        ['3 unpushed', 'warn'],
        ['1 behind', 'info'],
      ],
    );
    expect(gitNotes(facts({ upstream: null, ahead: null })).map((n) => n.text)).toEqual([
      'not pushed',
    ]);
    // only the remote copy is left: nothing local to lose
    expect(gitNotes(facts({ local: false, upstream: null, ahead: null }))).toEqual([]);
  });

  it('suggests the stage git shows, only for branches the note names', () => {
    expect(suggestedStage(item('a'), facts())).toBeNull();
    expect(suggestedStage(item('a'), facts({ inUat: true }))).toBe('in-uat-branch');
    expect(suggestedStage(item('a', { stage: 'on-uat' }), facts({ inUat: true }))).toBeNull();
    expect(suggestedStage(item('a', { stage: 'pr-open' }), facts({ inRelease: true }))).toBe(
      'released',
    );
    expect(suggestedStage(item('a', { stage: 'released' }), facts({ inRelease: true }))).toBeNull();
    expect(suggestedStage(item('a'), facts({ available: false, inUat: true }))).toBeNull();
  });
});
