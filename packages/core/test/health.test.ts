import { describe, expect, it } from 'vitest';
import { type HealthIssue, type HealthPerson, sprintHealth } from '../src/health.ts';

const NOW = new Date('2026-08-31T12:00:00Z');
const SPRINT = { name: 'Sprint 37', start: '2026-08-24T00:00:00Z', end: '2026-09-04T00:00:00Z' };

function issue(over: Partial<HealthIssue> = {}): HealthIssue {
  return {
    key: 'EXEC-1',
    path: 'jira/EXEC-1.md',
    summary: 'Something',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Story',
    priority: 'Medium',
    estimate: 3,
    effectiveEffort: 3,
    effectiveSprint: 'Sprint 37',
    effectiveAssignee: 'anna',
    updated: '2026-08-30T00:00:00Z',
    blockedBy: [],
    ...over,
  };
}

function person(over: Partial<HealthPerson> = {}): HealthPerson {
  return {
    path: 'people/anna.md',
    name: 'Anna',
    jiraIds: ['anna'],
    capacity: 10,
    overrides: {},
    loadOverrides: {},
    active: true,
    region: 'EMEA',
    team: 'Gateway',
    ...over,
  };
}

const run = (issues: HealthIssue[], people: HealthPerson[] = [person()]) =>
  sprintHealth({ sprint: SPRINT, issues, people, unit: 'points' }, NOW);

const kinds = (issues: HealthIssue[], people?: HealthPerson[]) =>
  run(issues, people).problems.map((p) => p.kind);

describe('sprintHealth', () => {
  it('flags issues with no estimate and no assignee', () => {
    const found = kinds([
      issue({ estimate: null, effectiveEffort: null, effectiveAssignee: null }),
    ]);
    expect(found).toContain('no-estimate');
    expect(found).toContain('no-assignee');
  });

  it('flags oversized issues that should be split', () => {
    expect(kinds([issue({ estimate: 8, effectiveEffort: 8 })])).toContain('oversized');
    expect(kinds([issue({ estimate: 5, effectiveEffort: 5 })])).not.toContain('oversized');
  });

  it('flags blocked and stalled issues', () => {
    expect(kinds([issue({ blockedBy: ['EXEC-9'] })])).toContain('blocked');
    expect(kinds([issue({ updated: '2026-08-20T00:00:00Z' })])).toContain('stale');
  });

  it('flags work not started past the sprint midpoint', () => {
    expect(kinds([issue({ statusCategory: 'new', status: 'To Do' })])).toContain('not-started');
  });

  it('ignores done issues but still counts their effort', () => {
    const r = run([issue({ statusCategory: 'done', estimate: null, effectiveEffort: null })]);
    expect(r.problems).toHaveLength(1); // only the person's underload
    expect(r.problems[0]?.kind).toBe('underloaded');
    expect(r.totals.done).toBe(1);
  });

  it('flags people over their bandwidth, respecting per-sprint overrides', () => {
    const issues = [issue({ effectiveEffort: 12, estimate: 12 })];
    const over = run(issues).problems.find((p) => p.kind === 'overloaded');
    expect(over?.personName).toBe('Anna');
    expect(over?.value).toBe(12);
    expect(over?.limit).toBe(10);
    // a per-sprint capacity override raises the bar
    const raised = run(issues, [person({ overrides: { 'Sprint 37': 15 } })]);
    expect(raised.problems.map((p) => p.kind)).not.toContain('overloaded');
  });

  it('uses a manual used-load override instead of the computed load', () => {
    const found = run(
      [issue({ effectiveEffort: 2 })],
      [person({ loadOverrides: { 'Sprint 37': 14 } })],
    );
    expect(found.problems.find((p) => p.kind === 'overloaded')?.value).toBe(14);
  });

  it('flags assignees who have no person note (invisible in the grid)', () => {
    const r = run([issue({ effectiveAssignee: 'ghost' })], [person()]);
    const ghost = r.problems.find((p) => p.kind === 'unknown-assignee');
    expect(ghost?.personName).toBe('ghost');
    expect(ghost?.value).toBe(1);
  });

  it('warns near the sprint end instead of repeating not-started', () => {
    const late = sprintHealth(
      {
        sprint: SPRINT,
        issues: [issue({ statusCategory: 'new' })],
        people: [person()],
        unit: 'points',
      },
      new Date('2026-09-03T12:00:00Z'),
    );
    const found = late.problems.map((p) => p.kind);
    expect(found).toContain('at-risk');
    expect(found).not.toContain('not-started');
    expect(late.daysLeft).toBe(1);
  });

  it('skips date-based checks for sprints without dates', () => {
    const r = sprintHealth(
      {
        sprint: { name: 'Sprint 37', start: null, end: null },
        issues: [issue({ statusCategory: 'new' })],
        people: [person()],
        unit: 'points',
      },
      NOW,
    );
    expect(r.elapsedPct).toBeNull();
    expect(r.problems.map((p) => p.kind)).not.toContain('not-started');
  });

  it('sorts problems by severity and summarises totals', () => {
    const r = run([
      issue({ key: 'A', estimate: 9, effectiveEffort: 9 }),
      issue({ key: 'B', effectiveAssignee: null, estimate: null, effectiveEffort: null }),
    ]);
    expect(r.problems[0]?.severity).toBe('high');
    expect(r.totals.issues).toBe(2);
    expect(r.totals.effort).toBe(9);
    expect(r.counts['no-assignee']).toBe(1);
  });

  it('only looks at the requested sprint', () => {
    expect(kinds([issue({ effectiveSprint: 'Backlog', effectiveAssignee: null })])).not.toContain(
      'no-assignee',
    );
  });
});
