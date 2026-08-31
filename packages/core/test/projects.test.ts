import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  forecastProject,
  layoutPlan,
  type ProjectDef,
  type ProjectIssue,
  projectOf,
  rollupProject,
  workingDaysBetween,
} from '../src/projects.ts';

function def(over: Partial<ProjectDef> = {}): ProjectDef {
  return {
    path: 'projects/falcon.md',
    title: 'Falcon',
    status: 'active',
    color: null,
    start: null,
    target: null,
    epics: [],
    labels: [],
    keys: [],
    ...over,
  };
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
    effectiveEffort: 2,
    dependsOn: [],
    blockedBy: [],
    plan: { project: null, rank: null },
    ...over,
  };
}

describe('projectOf', () => {
  const projects = [
    def({ epics: ['EXEC-100'], labels: ['falcon'] }),
    def({ path: 'projects/atlas.md', title: 'Atlas', keys: ['EXEC-9'] }),
  ];

  it('matches an explicit tag by path, title or slug', () => {
    for (const tag of ['projects/falcon.md', 'Falcon', 'falcon', 'FALCON']) {
      expect(projectOf(issue({ plan: { project: tag, rank: null } }), projects)).toBe(
        'projects/falcon.md',
      );
    }
  });

  it('falls back to epic, label and key rules', () => {
    expect(projectOf(issue({ epic: 'EXEC-100' }), projects)).toBe('projects/falcon.md');
    expect(projectOf(issue({ labels: ['x', 'falcon'] }), projects)).toBe('projects/falcon.md');
    expect(projectOf(issue({ key: 'EXEC-9' }), projects)).toBe('projects/atlas.md');
    expect(projectOf(issue(), projects)).toBeNull();
  });

  it('lets an explicit tag override a rule match', () => {
    const tagged = issue({ epic: 'EXEC-100', plan: { project: 'Atlas', rank: null } });
    expect(projectOf(tagged, projects)).toBe('projects/atlas.md');
  });
});

describe('rollupProject', () => {
  it('totals scope, progress and per-person effort', () => {
    const r = rollupProject(def(), [
      issue({ key: 'A', statusCategory: 'done', effectiveEffort: 3 }),
      issue({ key: 'B', statusCategory: 'indeterminate', effectiveEffort: 2 }),
      issue({ key: 'C', effectiveEffort: null, effectiveAssignee: null, blockedBy: ['A'] }),
      issue({ key: 'D', effectiveAssignee: 'bob', effectiveSprint: 'Backlog' }),
    ]);
    expect(r).toMatchObject({
      issues: 4,
      done: 1,
      inProgress: 1,
      effort: 7,
      doneEffort: 3,
      remainingEffort: 4,
      unestimated: 1,
      unassigned: 1,
      blocked: 1,
    });
    expect(r.people[0]).toEqual({ assignee: 'anna', effort: 5, issues: 2 });
    expect(r.sprints).toEqual(['Sprint 37']); // Backlog is not a sprint
  });
});

describe('working-day maths', () => {
  it('counts weekdays only', () => {
    // Mon 2026-08-31 → Mon 2026-09-07 is five working days
    expect(workingDaysBetween(new Date('2026-08-31'), new Date('2026-09-07'))).toBe(5);
    expect(addWorkingDays(new Date('2026-08-28T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe(
      '2026-08-31', // Friday + 1 working day = Monday
    );
  });
});

const SPRINTS = [
  { name: 'Sprint 37', start: '2026-08-31T00:00:00Z', end: '2026-09-11T00:00:00Z' },
  { name: 'Sprint 38', start: '2026-09-14T00:00:00Z', end: '2026-09-25T00:00:00Z' },
  { name: 'Sprint 39', start: '2026-09-28T00:00:00Z', end: '2026-10-09T00:00:00Z' },
];

const forecast = (
  issues: ProjectIssue[],
  capacityDays: Record<string, Record<string, number>> = {},
) =>
  forecastProject({
    sprints: SPRINTS,
    issues,
    capacityDays,
    defaultCapacityDays: 8,
    toDays: (e) => e,
    unestimatedDays: 2,
  });

describe('forecastProject', () => {
  it('places work in the first sprint that has room and reports the finish', () => {
    const r = forecast([
      issue({ key: 'A', effectiveEffort: 3 }),
      issue({ key: 'B', effectiveEffort: 4 }),
    ]);
    expect(r.blocks.map((b) => [b.key, b.sprint, b.offsetDays])).toEqual([
      ['A', 'Sprint 37', 0],
      ['B', 'Sprint 37', 3],
    ]);
    expect(r.finishSprint).toBe('Sprint 37');
    expect(r.finishDate).toBe('2026-09-09'); // 7 working days after Mon 31 Aug
    expect(r.unscheduled).toEqual([]);
  });

  it('spills past a full sprint into the next one', () => {
    const r = forecast([
      issue({ key: 'A', effectiveEffort: 6 }),
      issue({ key: 'B', effectiveEffort: 6 }),
    ]);
    expect(r.blocks.map((b) => b.sprint)).toEqual(['Sprint 37', 'Sprint 38']);
    expect(r.blocks[1]?.slipped).toBe(true); // planned for 37, forecast says 38
  });

  it('respects per-sprint capacity overrides and parallel people', () => {
    const r = forecast(
      [
        issue({ key: 'A', effectiveEffort: 5, effectiveAssignee: 'anna' }),
        issue({ key: 'B', effectiveEffort: 5, effectiveAssignee: 'bob' }),
      ],
      { anna: { 'Sprint 37': 2 } },
    );
    const byKey = Object.fromEntries(r.blocks.map((b) => [b.key, b]));
    expect(byKey.A?.sprint).toBe('Sprint 38'); // only 2 days of Anna in 37, task needs 5
    expect(byKey.B?.sprint).toBe('Sprint 37'); // Bob works in parallel
    expect(byKey.B?.offsetDays).toBe(0);
  });

  it('never starts an issue before its blocker finishes, even across people', () => {
    const r = forecast([
      issue({ key: 'A', effectiveEffort: 3, effectiveAssignee: 'anna' }),
      issue({ key: 'B', effectiveEffort: 2, effectiveAssignee: 'bob', dependsOn: ['A'] }),
    ]);
    const byKey = Object.fromEntries(r.blocks.map((b) => [b.key, b]));
    expect(byKey.B?.offsetDays).toBe(3); // waits for A even though Bob is free
  });

  it('orders independent work by plan rank', () => {
    const r = forecast([
      issue({ key: 'A', plan: { project: null, rank: 2 } }),
      issue({ key: 'B', plan: { project: null, rank: 1 } }),
    ]);
    expect(r.blocks.map((b) => b.key)).toEqual(['B', 'A']);
  });

  it('sizes unestimated work with the fallback and marks it', () => {
    const r = forecast([issue({ effectiveEffort: null })]);
    expect(r.blocks[0]?.days).toBe(2);
    expect(r.blocks[0]?.estimated).toBe(false);
  });

  it('reports dependency cycles instead of looping forever', () => {
    const r = forecast([
      issue({ key: 'A', dependsOn: ['B'] }),
      issue({ key: 'B', dependsOn: ['A'] }),
    ]);
    expect(r.cycles[0]).toEqual(['A', 'B']);
    expect(r.unscheduled.map((u) => u.key).sort()).toEqual(['A', 'B']);
  });

  it('flags a blocker planned after the issue it blocks', () => {
    const r = forecast([
      issue({ key: 'A', effectiveSprint: 'Sprint 39' }),
      issue({ key: 'B', effectiveSprint: 'Sprint 37', dependsOn: ['A'] }),
    ]);
    expect(r.violations).toEqual([
      {
        key: 'B',
        blocker: 'A',
        detail: 'A is planned into Sprint 39, after B in Sprint 37',
      },
    ]);
  });

  it('does not call unplanned work slipped when it is scheduled for the first time', () => {
    const r = forecast([issue({ key: 'A', effectiveSprint: 'Backlog', effectiveEffort: 2 })]);
    expect(r.blocks[0]?.sprint).toBe('Sprint 37');
    expect(r.blocks[0]?.slipped).toBe(false);
  });

  it('ignores work that is already done', () => {
    const r = forecast([issue({ statusCategory: 'done', effectiveEffort: 5 })]);
    expect(r.blocks).toEqual([]);
    expect(r.finishSprint).toBeNull();
  });

  it('pools unassigned work so the forecast is not silently optimistic', () => {
    const r = forecast([issue({ effectiveAssignee: null, effectiveEffort: 3 })]);
    expect(r.blocks[0]?.assignee).toBe('(unassigned)');
  });
});

describe('layoutPlan', () => {
  const plan = (
    issues: ProjectIssue[],
    capacityDays: Record<string, Record<string, number>> = {},
  ) =>
    layoutPlan({
      sprints: SPRINTS,
      issues,
      capacityDays,
      defaultCapacityDays: 8,
      toDays: (e) => e,
      unestimatedDays: 2,
    });

  it("stacks each person's work inside the sprint it is planned into", () => {
    const r = plan([
      issue({ key: 'A', effectiveEffort: 3, plan: { project: null, rank: 2 } }),
      issue({ key: 'B', effectiveEffort: 2, plan: { project: null, rank: 1 } }),
      issue({ key: 'C', effectiveEffort: 4, effectiveSprint: 'Sprint 38' }),
    ]);
    expect(r.blocks.map((b) => [b.key, b.sprint, b.offsetDays])).toEqual([
      ['B', 'Sprint 37', 0],
      ['A', 'Sprint 37', 2],
      ['C', 'Sprint 38', 0],
    ]);
  });

  it('marks work that runs past the assignee capacity for that sprint', () => {
    const r = plan([issue({ key: 'A', effectiveEffort: 9 })], { anna: { 'Sprint 37': 8 } });
    expect(r.blocks[0]?.overflow).toBe(true);
  });

  it('keeps unplanned work out of the calendar', () => {
    const r = plan([
      issue({ key: 'A', effectiveSprint: 'Backlog' }),
      issue({ key: 'B', statusCategory: 'done' }),
    ]);
    expect(r.blocks).toEqual([]);
    expect(r.backlog).toEqual(['A']);
  });
});
