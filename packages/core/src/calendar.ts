/**
 * The project calendar: a dense grid of workdays where each issue is a block
 * whose width is its effort in days (story points ≈ workdays).
 *
 * An issue with `plan.start` is pinned to that day. One without a start flows
 * into the first free gap of the sprint it is planned into. Blocks are
 * elastic over a person's away days (OOO / support): the work still takes N
 * working days, so the block stretches to span them.
 */
import { weekdaysIn } from './availability.ts';
import { addWorkingDays, type ProjectIssue } from './projects.ts';

export interface CalendarInput {
  /** workday dates, ascending, YYYY-MM-DD */
  days: string[];
  issues: ProjectIssue[];
  /** sprint name → first day index, for flowing unpinned work */
  sprintFrom: Record<string, number>;
  /** assignee → away day indexes (OOO and support together) */
  away: Record<string, number[]>;
  /** effort (capacity unit) → working days */
  toDays: (effort: number) => number;
  unestimatedDays: number;
  /** auto-arrange never schedules before this day index (today) */
  notBefore?: number;
}

export interface CalendarBlock {
  key: string;
  assignee: string;
  /** first day index; may run past the grid (the UI clips it) */
  start: number;
  /** grid width in days, away gaps included */
  span: number;
  /** actual working days of effort */
  workDays: number;
  pinned: boolean;
  estimated: boolean;
  /** away days inside the span */
  awayDays: number;
  /** shares a day with another block of the same person */
  conflict: boolean;
  /** pinned before the first day of the grid */
  clamped: boolean;
  /** blockers that do not finish before this starts */
  lateDeps: string[];
}

export interface CalendarLayout {
  blocks: CalendarBlock[];
  /** open issues that have no start and no sprint on the grid */
  unplaced: string[];
}

const UNASSIGNED = '(unassigned)';

/** Day index for a date: inside the grid, or extrapolated past its end. */
export function dayIndexOf(days: string[], date: string): number {
  if (!days.length) return 0;
  if (date <= (days[0] as string)) return date < (days[0] as string) ? -1 : 0;
  const idx = days.findIndex((d) => d >= date);
  if (idx !== -1) return idx;
  const last = days[days.length - 1] as string;
  return (
    days.length -
    1 +
    weekdaysIn(new Date(`${last}T00:00:00Z`), new Date(`${date}T00:00:00Z`)).length
  );
}

/** Date for a day index, extrapolating past the grid on workdays. */
export function dateOfIndex(days: string[], idx: number): string {
  if (idx < days.length) return days[Math.max(idx, 0)] as string;
  const last = days[days.length - 1] as string;
  return addWorkingDays(new Date(`${last}T00:00:00Z`), idx - (days.length - 1))
    .toISOString()
    .slice(0, 10);
}

interface Person {
  away: Set<number>;
  taken: Map<number, string>;
}

function personOf(map: Map<string, Person>, who: string, away: Record<string, number[]>): Person {
  let p = map.get(who);
  if (!p) {
    p = { away: new Set(away[who] ?? []), taken: new Map() };
    map.set(who, p);
  }
  return p;
}

/** The working-day cells a block starting at `start` occupies, skipping away days. */
function cellsFor(p: Person, start: number, workDays: number): number[] {
  const cells: number[] = [];
  let idx = start;
  while (cells.length < workDays) {
    if (!p.away.has(idx)) cells.push(idx);
    idx++;
  }
  return cells;
}

function wholeDays(issue: ProjectIssue, input: CalendarInput): number {
  const d =
    issue.effectiveEffort === null ? input.unestimatedDays : input.toDays(issue.effectiveEffort);
  return Math.max(1, Math.ceil(d - 0.001));
}

export function layoutCalendar(input: CalendarInput): CalendarLayout {
  const open = input.issues.filter((i) => i.statusCategory !== 'done');
  const inScope = new Map(open.map((i) => [i.key, i]));
  const people = new Map<string, Person>();
  const blocks: CalendarBlock[] = [];
  const unplaced: string[] = [];
  const rank = (i: ProjectIssue) => i.plan.rank ?? Number.POSITIVE_INFINITY;

  const push = (
    issue: ProjectIssue,
    who: string,
    cells: number[],
    pinned: boolean,
    clamped: boolean,
    conflict: boolean,
  ) => {
    const start = cells[0] as number;
    const end = cells[cells.length - 1] as number;
    blocks.push({
      key: issue.key,
      assignee: who,
      start,
      span: end - start + 1,
      workDays: cells.length,
      pinned,
      estimated: issue.effectiveEffort !== null,
      awayDays: end - start + 1 - cells.length,
      conflict,
      clamped,
      lateDeps: [],
    });
  };

  // ---- pinned blocks sit exactly where they were put -----------------------
  const pinnedIssues = open
    .filter((i) => i.plan.start)
    .sort((a, b) => (a.plan.start as string).localeCompare(b.plan.start as string));
  for (const issue of pinnedIssues) {
    const who = issue.effectiveAssignee ?? UNASSIGNED;
    const p = personOf(people, who, input.away);
    const raw = dayIndexOf(input.days, issue.plan.start as string);
    const clamped = raw < 0;
    const cells = cellsFor(p, Math.max(raw, 0), wholeDays(issue, input));
    let conflict = false;
    for (const c of cells) {
      const other = p.taken.get(c);
      if (other) {
        conflict = true;
        const b = blocks.find((x) => x.key === other);
        if (b) b.conflict = true;
      } else {
        p.taken.set(c, issue.key);
      }
    }
    push(issue, who, cells, true, clamped, conflict);
  }

  // ---- unpinned work flows into the first free gap of its sprint -----------
  const flowing = open
    .filter((i) => !i.plan.start)
    .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  for (const issue of flowing) {
    const from = input.sprintFrom[issue.effectiveSprint];
    if (from === undefined) {
      unplaced.push(issue.key);
      continue;
    }
    const who = issue.effectiveAssignee ?? UNASSIGNED;
    const p = personOf(people, who, input.away);
    const need = wholeDays(issue, input);
    let start = from;
    for (;;) {
      const cells = cellsFor(p, start, need);
      const hit = cells.find((c) => p.taken.has(c));
      if (hit === undefined) {
        for (const c of cells) p.taken.set(c, issue.key);
        push(issue, who, cells, false, false, false);
        break;
      }
      start = hit + 1;
    }
  }

  // ---- dependency sanity: a blocker must finish before its dependent starts
  const endOf = new Map(blocks.map((b) => [b.key, b.start + b.span - 1]));
  for (const b of blocks) {
    const issue = inScope.get(b.key) as ProjectIssue;
    for (const dep of new Set([...issue.dependsOn, ...issue.blockedBy])) {
      if (dep === b.key || !endOf.has(dep)) continue;
      if ((endOf.get(dep) as number) >= b.start) b.lateDeps.push(dep);
    }
  }
  return { blocks, unplaced };
}

export interface ArrangeResult {
  /** key → start date, in schedule order */
  starts: Map<string, string>;
  finishDate: string | null;
  cycles: string[][];
}

/**
 * Auto-arrange: dependency order first, then the earliest free slot on each
 * person's row (away days skipped). The result is a set of `plan.start`
 * pins — a starting point to drag around, not a mode of its own.
 */
export function arrangeCalendar(input: CalendarInput): ArrangeResult {
  const open = input.issues.filter(
    (i) =>
      i.statusCategory !== 'done' &&
      (i.plan.start || input.sprintFrom[i.effectiveSprint] !== undefined),
  );
  const inScope = new Map(open.map((i) => [i.key, i]));
  const deps = new Map<string, string[]>();
  for (const i of open) {
    deps.set(
      i.key,
      [...new Set([...i.dependsOn, ...i.blockedBy])].filter((k) => inScope.has(k) && k !== i.key),
    );
  }
  const rankOf = (k: string) => inScope.get(k)?.plan.rank ?? Number.POSITIVE_INFINITY;
  const order: string[] = [];
  const remaining = new Map(deps);
  for (;;) {
    const next = [...remaining.entries()]
      .filter(([, d]) => d.every((x) => !remaining.has(x)))
      .map(([k]) => k)
      .sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))[0];
    if (!next) break;
    order.push(next);
    remaining.delete(next);
  }
  const cycles = remaining.size ? [[...remaining.keys()].sort()] : [];

  const people = new Map<string, Person>();
  const endOf = new Map<string, number>();
  const starts = new Map<string, string>();
  let finish = -1;

  for (const key of order) {
    const issue = inScope.get(key) as ProjectIssue;
    const who = issue.effectiveAssignee ?? UNASSIGNED;
    const p = personOf(people, who, input.away);
    const need = wholeDays(issue, input);
    let start = input.notBefore ?? 0;
    for (const d of deps.get(key) ?? []) start = Math.max(start, (endOf.get(d) ?? -1) + 1);
    for (;;) {
      const cells = cellsFor(p, start, need);
      const hit = cells.find((c) => p.taken.has(c));
      if (hit === undefined) {
        for (const c of cells) p.taken.set(c, key);
        const last = cells[cells.length - 1] as number;
        endOf.set(key, last);
        finish = Math.max(finish, last);
        starts.set(key, dateOfIndex(input.days, cells[0] as number));
        break;
      }
      start = hit + 1;
    }
  }
  return {
    starts,
    finishDate: finish >= 0 ? dateOfIndex(input.days, finish) : null,
    cycles,
  };
}
