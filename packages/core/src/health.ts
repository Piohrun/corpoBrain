/** Sprint health: the problems in a sprint that are worth acting on today. */

export interface HealthIssue {
  key: string;
  path: string;
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  issueType: string | null;
  priority: string | null;
  /** raw Jira estimate, in the Jira estimate unit (story points for most teams) */
  estimate: number | null;
  /** estimate converted to the capacity unit, plan override applied */
  effectiveEffort: number | null;
  effectiveSprint: string;
  effectiveAssignee: string | null;
  updated: string | null;
  /** unresolved blockers only */
  blockedBy: string[];
}

export interface HealthPerson {
  path: string;
  name: string;
  jiraIds: string[];
  capacity: number | null;
  overrides: Record<string, number>;
  loadOverrides: Record<string, number>;
  active: boolean;
  region: string | null;
  team: string | null;
}

export interface HealthSprint {
  name: string;
  start: string | null;
  end: string | null;
}

export type HealthKind =
  | 'no-estimate'
  | 'no-assignee'
  | 'oversized'
  | 'blocked'
  | 'stale'
  | 'not-started'
  | 'at-risk'
  | 'overloaded'
  | 'underloaded'
  | 'unknown-assignee';

export type Severity = 'high' | 'medium' | 'low';

export interface HealthProblem {
  kind: HealthKind;
  severity: Severity;
  /** short and actionable, rendered as the row label */
  detail: string;
  issueKey: string | null;
  path: string | null;
  summary: string | null;
  personName: string | null;
  personPath: string | null;
  value: number | null;
  limit: number | null;
}

export interface HealthTotals {
  issues: number;
  done: number;
  inProgress: number;
  todo: number;
  effort: number;
  doneEffort: number;
  capacity: number;
  unassignedEffort: number;
  unestimated: number;
}

export interface HealthReport {
  sprint: string;
  unit: string;
  generatedAt: string;
  /** null when the sprint has no dates (local sprints may not) */
  elapsedPct: number | null;
  daysLeft: number | null;
  totals: HealthTotals;
  counts: Record<string, number>;
  problems: HealthProblem[];
}

export interface HealthOptions {
  /** raw-estimate threshold above which an issue should be split */
  bigIssue: number;
  /** days without an update before an in-progress issue counts as stalled */
  staleDays: number;
  /** report people below this fraction of their capacity as having room */
  underloadPct: number;
}

export const DEFAULT_HEALTH: HealthOptions = { bigIssue: 8, staleDays: 5, underloadPct: 0.5 };

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : null;
}

/**
 * Problems in one sprint, ordered by severity. Pure: everything it needs is in
 * `input`, so the planning board and tests can share it.
 */
export function sprintHealth(
  input: {
    sprint: HealthSprint;
    issues: HealthIssue[];
    people: HealthPerson[];
    unit: string;
  },
  now: Date = new Date(),
  opts: HealthOptions = DEFAULT_HEALTH,
): HealthReport {
  const { sprint, people, unit } = input;
  const issues = input.issues.filter((i) => i.effectiveSprint === sprint.name);
  const problems: HealthProblem[] = [];

  // ---- sprint clock -------------------------------------------------------
  const start = sprint.start ? new Date(sprint.start).getTime() : Number.NaN;
  const end = sprint.end ? new Date(sprint.end).getTime() : Number.NaN;
  const hasDates = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const elapsedPct = hasDates
    ? Math.max(0, Math.min(100, Math.round(((now.getTime() - start) / (end - start)) * 100)))
    : null;
  const daysLeft = Number.isFinite(end) ? Math.ceil((end - now.getTime()) / 86_400_000) : null;

  const issueProblem = (
    i: HealthIssue,
    kind: HealthKind,
    severity: Severity,
    detail: string,
    value: number | null = null,
    limit: number | null = null,
  ): void => {
    problems.push({
      kind,
      severity,
      detail,
      issueKey: i.key,
      path: i.path,
      summary: i.summary,
      personName: null,
      personPath: null,
      value,
      limit,
    });
  };

  // ---- per-issue checks ---------------------------------------------------
  const unknownAssignees = new Map<string, number>();
  const totals: HealthTotals = {
    issues: issues.length,
    done: 0,
    inProgress: 0,
    todo: 0,
    effort: 0,
    doneEffort: 0,
    capacity: 0,
    unassignedEffort: 0,
    unestimated: 0,
  };

  for (const i of issues) {
    const done = i.statusCategory === 'done';
    if (done) totals.done++;
    else if (i.statusCategory === 'indeterminate') totals.inProgress++;
    else totals.todo++;
    const effort = i.effectiveEffort ?? 0;
    totals.effort = round(totals.effort + effort);
    if (done) totals.doneEffort = round(totals.doneEffort + effort);
    if (done) continue;

    if (i.effectiveEffort === null) {
      totals.unestimated++;
      issueProblem(i, 'no-estimate', 'high', 'no estimate — cannot be planned or counted');
    }
    if (!i.effectiveAssignee) {
      totals.unassignedEffort = round(totals.unassignedEffort + effort);
      issueProblem(i, 'no-assignee', 'high', 'nobody assigned');
    } else if (!people.some((p) => p.jiraIds.includes(i.effectiveAssignee as string))) {
      const id = i.effectiveAssignee;
      unknownAssignees.set(id, (unknownAssignees.get(id) ?? 0) + 1);
    }
    if (i.estimate !== null && i.estimate >= opts.bigIssue) {
      issueProblem(
        i,
        'oversized',
        'medium',
        `${i.estimate} points — split into smaller issues`,
        i.estimate,
        opts.bigIssue,
      );
    }
    if (i.blockedBy.length) {
      issueProblem(
        i,
        'blocked',
        'high',
        `blocked by ${i.blockedBy.join(', ')}`,
        i.blockedBy.length,
        null,
      );
    }
    const age = ageDays(i.updated, now);
    if (i.statusCategory === 'indeterminate' && age !== null && age > opts.staleDays) {
      issueProblem(
        i,
        'stale',
        'medium',
        `in progress with no update for ${Math.floor(age)} days`,
        Math.floor(age),
        opts.staleDays,
      );
    }
    if (daysLeft !== null && daysLeft <= 2 && daysLeft >= -30) {
      issueProblem(
        i,
        'at-risk',
        'high',
        daysLeft < 0
          ? 'sprint has ended and this is not done'
          : `sprint ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'} and this is not done`,
        daysLeft,
        null,
      );
    } else if (elapsedPct !== null && elapsedPct >= 50 && i.statusCategory === 'new') {
      issueProblem(
        i,
        'not-started',
        'medium',
        `not started, ${elapsedPct}% of the sprint gone`,
        elapsedPct,
        50,
      );
    }
  }

  for (const [id, count] of unknownAssignees) {
    problems.push({
      kind: 'unknown-assignee',
      severity: 'medium',
      detail: `${count} issue${count === 1 ? '' : 's'} assigned to "${id}", who has no person note — invisible in the bandwidth grid`,
      issueKey: null,
      path: null,
      summary: null,
      personName: id,
      personPath: null,
      value: count,
      limit: null,
    });
  }

  // ---- per-person load ----------------------------------------------------
  for (const p of people) {
    if (!p.active) continue;
    const capacity = p.overrides[sprint.name] ?? p.capacity;
    const computed = issues
      .filter((i) => i.statusCategory !== 'done' && i.effectiveAssignee)
      .filter((i) => p.jiraIds.includes(i.effectiveAssignee as string))
      .reduce((sum, i) => sum + (i.effectiveEffort ?? 0), 0);
    const load = round(p.loadOverrides[sprint.name] ?? computed);
    if (capacity === null || capacity <= 0) {
      if (load > 0) {
        problems.push({
          kind: 'overloaded',
          severity: 'low',
          detail: `${load} ${unit} assigned but no bandwidth set`,
          issueKey: null,
          path: null,
          summary: null,
          personName: p.name,
          personPath: p.path,
          value: load,
          limit: null,
        });
      }
      continue;
    }
    totals.capacity = round(totals.capacity + capacity);
    if (load > capacity + 0.001) {
      problems.push({
        kind: 'overloaded',
        severity: 'high',
        detail: `${load} ${unit} assigned against ${capacity} ${unit} of bandwidth (over by ${round(load - capacity)})`,
        issueKey: null,
        path: null,
        summary: null,
        personName: p.name,
        personPath: p.path,
        value: load,
        limit: capacity,
      });
    } else if (load < capacity * opts.underloadPct && (daysLeft === null || daysLeft > 0)) {
      problems.push({
        kind: 'underloaded',
        severity: 'low',
        detail: `${load} of ${capacity} ${unit} assigned — room for ${round(capacity - load)} more`,
        issueKey: null,
        path: null,
        summary: null,
        personName: p.name,
        personPath: p.path,
        value: load,
        limit: capacity,
      });
    }
  }

  problems.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      (a.issueKey ?? a.personName ?? '').localeCompare(b.issueKey ?? b.personName ?? ''),
  );

  const counts: Record<string, number> = {};
  for (const p of problems) counts[p.kind] = (counts[p.kind] ?? 0) + 1;

  return {
    sprint: sprint.name,
    unit,
    generatedAt: now.toISOString(),
    elapsedPct,
    daysLeft,
    totals,
    counts,
    problems,
  };
}
