import { isWeekend, weekdaysIn } from './availability.ts';

/**
 * Projects: a slice of Jira issues that belong to one initiative, plus the
 * forecast of when that slice lands.
 *
 * Membership is resolved from the vault, never written to Jira: an explicit
 * `plan.project` on the issue wins, otherwise the project's epic / label / key
 * rules decide. The forecast is a forward pass over the dependency graph that
 * respects each person's per-sprint capacity, so it answers "if nothing
 * changes, when is this done?" without anyone maintaining dates by hand.
 */

export interface ProjectDef {
  path: string;
  title: string;
  status: string | null;
  color: string | null;
  start: string | null;
  target: string | null;
  /** membership rules */
  epics: string[];
  labels: string[];
  keys: string[];
  /** roster: people on the project even before they have issues */
  people: string[];
}

export interface ProjectIssue {
  key: string;
  path: string;
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  priority: string | null;
  epic: string | null;
  labels: string[];
  effectiveSprint: string;
  effectiveAssignee: string | null;
  /** in the vault's capacity unit */
  effectiveEffort: number | null;
  dependsOn: string[];
  blockedBy: string[];
  plan: { project: string | null; rank: number | null; start: string | null };
}

const slug = (path: string): string =>
  (path.split('/').pop() ?? path).replace(/\.md$/i, '').toLowerCase();

/** The project an issue belongs to, or null. Explicit tagging always wins. */
export function projectOf(issue: ProjectIssue, projects: ProjectDef[]): string | null {
  const tag = issue.plan.project?.trim().toLowerCase();
  if (tag) {
    const explicit = projects.find(
      (p) => p.path.toLowerCase() === tag || p.title.toLowerCase() === tag || slug(p.path) === tag,
    );
    if (explicit) return explicit.path;
  }
  for (const p of projects) {
    if (p.keys.includes(issue.key)) return p.path;
    if (issue.epic && p.epics.includes(issue.epic)) return p.path;
    if (p.labels.some((l) => issue.labels.includes(l))) return p.path;
  }
  return null;
}

export interface ProjectRollup {
  path: string;
  title: string;
  status: string | null;
  color: string | null;
  target: string | null;
  issues: number;
  done: number;
  inProgress: number;
  effort: number;
  doneEffort: number;
  remainingEffort: number;
  unestimated: number;
  unassigned: number;
  blocked: number;
  people: { assignee: string; effort: number; issues: number }[];
  sprints: string[];
}

const round = (n: number): number => Math.round(n * 100) / 100;

export function rollupProject(def: ProjectDef, issues: ProjectIssue[]): ProjectRollup {
  const byPerson = new Map<string, { assignee: string; effort: number; issues: number }>();
  const sprints = new Set<string>();
  let done = 0;
  let inProgress = 0;
  let effort = 0;
  let doneEffort = 0;
  let unestimated = 0;
  let unassigned = 0;
  let blocked = 0;

  for (const i of issues) {
    const e = i.effectiveEffort ?? 0;
    effort += e;
    if (i.statusCategory === 'done') {
      done++;
      doneEffort += e;
    } else {
      if (i.statusCategory === 'indeterminate') inProgress++;
      if (i.effectiveEffort === null) unestimated++;
      if (!i.effectiveAssignee) unassigned++;
      if (i.blockedBy.length) blocked++;
    }
    if (i.effectiveSprint !== 'Backlog') sprints.add(i.effectiveSprint);
    const who = i.effectiveAssignee ?? '(unassigned)';
    const row = byPerson.get(who) ?? { assignee: who, effort: 0, issues: 0 };
    row.effort = round(row.effort + e);
    row.issues++;
    byPerson.set(who, row);
  }

  return {
    path: def.path,
    title: def.title,
    status: def.status,
    color: def.color,
    target: def.target,
    issues: issues.length,
    done,
    inProgress,
    effort: round(effort),
    doneEffort: round(doneEffort),
    remainingEffort: round(effort - doneEffort),
    unestimated,
    unassigned,
    blocked,
    people: [...byPerson.values()].sort((a, b) => b.effort - a.effort),
    sprints: [...sprints],
  };
}

// ----------------------------------------------------------- calendar maths

/** Working days in [from, to): weekdays only, no holiday awareness (that lives in availability). */
export function workingDaysBetween(from: Date, to: Date): number {
  return weekdaysIn(from, to).length;
}

/** `n` working days after `from` (Friday + 1 → Monday). */
export function addWorkingDays(from: Date, n: number): Date {
  const d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) left--;
  }
  return d;
}
