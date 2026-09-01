import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
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
    people: [],
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
    plan: { project: null, rank: null, start: null },
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
      expect(projectOf(issue({ plan: { project: tag, rank: null, start: null } }), projects)).toBe(
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
    const tagged = issue({ epic: 'EXEC-100', plan: { project: 'Atlas', rank: null, start: null } });
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
