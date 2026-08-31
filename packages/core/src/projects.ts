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
  plan: { project: string | null; rank: number | null };
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

const DAY = 86_400_000;

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Working days (Mon–Fri) in [from, to). */
export function workingDaysBetween(from: Date, to: Date): number {
  let n = 0;
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur < end) {
    if (!isWeekend(cur)) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

/** The date `n` working days after `from` (n may be fractional; the fraction is a part-day). */
export function addWorkingDays(from: Date, n: number): Date {
  const cur = new Date(from.getTime());
  let whole = Math.floor(n);
  while (whole > 0) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (!isWeekend(cur)) whole--;
  }
  const frac = n - Math.floor(n);
  return frac > 0 ? new Date(cur.getTime() + frac * DAY) : cur;
}

// -------------------------------------------------------------- forecasting

export interface SprintWindow {
  name: string;
  start: string | null;
  end: string | null;
}

export interface ForecastInput {
  /** ordered, earliest first */
  sprints: SprintWindow[];
  issues: ProjectIssue[];
  /** assignee → sprint name → capacity, already converted to days */
  capacityDays: Record<string, Record<string, number>>;
  /** used when a person has no capacity for a sprint */
  defaultCapacityDays: number;
  /** effort (capacity unit) → days */
  toDays: (effort: number) => number;
  /** days to assume for an issue with no estimate */
  unestimatedDays: number;
}

export interface ScheduledBlock {
  key: string;
  assignee: string;
  /** the sprint the forecast puts it in */
  sprint: string;
  /** the sprint it is planned into today */
  plannedSprint: string;
  /** working days from the start of the forecast sprint */
  offsetDays: number;
  days: number;
  /** the forecast moved it later than the plan */
  slipped: boolean;
  estimated: boolean;
  /** the block runs past the assignee's capacity for that sprint */
  overflow: boolean;
}

export interface ForecastResult {
  blocks: ScheduledBlock[];
  /** issues the forecast could not place, with the reason */
  unscheduled: { key: string; reason: string }[];
  /** dependency cycles, each as the keys involved */
  cycles: string[][];
  /** a blocker planned into a later sprint than the issue it blocks */
  violations: { key: string; blocker: string; detail: string }[];
  finishSprint: string | null;
  finishDate: string | null;
}

interface Band {
  name: string;
  /** absolute working-day offset of the sprint start, from the first sprint */
  from: number;
  /** capacity budget is per person, so the band only carries its length */
  length: number;
  start: Date | null;
}

function bandsOf(sprints: SprintWindow[]): Band[] {
  const bands: Band[] = [];
  let cursor = 0;
  for (const s of sprints) {
    const start = s.start ? new Date(s.start) : null;
    const end = s.end ? new Date(s.end) : null;
    const length = start && end && end > start ? workingDaysBetween(start, end) : 10;
    bands.push({ name: s.name, from: cursor, length, start });
    cursor += length;
  }
  return bands;
}

/**
 * Forward pass: dependencies first, then each person's remaining capacity in
 * each sprint. Returns where every issue actually lands.
 */
export function forecastProject(input: ForecastInput): ForecastResult {
  const bands = bandsOf(input.sprints);
  const open = input.issues.filter((i) => i.statusCategory !== 'done');
  const inScope = new Map(open.map((i) => [i.key, i]));

  // ---- dependency order (Kahn, stable by rank then key) --------------------
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

  // ---- greedy placement ---------------------------------------------------
  /** assignee → absolute working-day cursor */
  const cursors = new Map<string, number>();
  /** assignee → sprint → days already committed */
  const used = new Map<string, Map<string, number>>();
  const finishOf = new Map<string, number>();
  const blocks: ScheduledBlock[] = [];
  const unscheduled: { key: string; reason: string }[] = [];

  const budget = (who: string, sprint: string): number => {
    const cap = input.capacityDays[who]?.[sprint];
    return cap === undefined ? input.defaultCapacityDays : cap;
  };

  for (const key of order) {
    const issue = inScope.get(key) as ProjectIssue;
    const who = issue.effectiveAssignee ?? '(unassigned)';
    const days =
      issue.effectiveEffort === null
        ? input.unestimatedDays
        : Math.max(input.toDays(issue.effectiveEffort), 0.25);

    // cannot start before every in-scope blocker has finished
    let earliest = cursors.get(who) ?? 0;
    for (const d of deps.get(key) ?? []) earliest = Math.max(earliest, finishOf.get(d) ?? 0);

    // Find the first sprint the task fits in; if it fits nowhere, take the
    // first with any room left, and failing that overflow the last sprint.
    const spentIn = (band: Band): number => used.get(who)?.get(band.name) ?? 0;
    const startIdx = Math.max(
      0,
      bands.findIndex((b) => earliest < b.from + b.length),
    );
    let placed: { band: Band; offset: number } | null = null;
    for (const pass of ['fit', 'any'] as const) {
      for (let bi = startIdx; bi < bands.length; bi++) {
        const band = bands[bi] as Band;
        const room = budget(who, band.name) - spentIn(band);
        const ok = pass === 'fit' ? days <= room + 0.001 : room > 0.001;
        if (!ok) continue;
        placed = { band, offset: Math.max(earliest - band.from, spentIn(band), 0) };
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      const band = bands.at(-1);
      if (band) placed = { band, offset: Math.max(earliest - band.from, spentIn(band), 0) };
    }
    if (placed) {
      const perSprint = used.get(who) ?? new Map<string, number>();
      perSprint.set(placed.band.name, placed.offset + days);
      used.set(who, perSprint);
    }

    if (!placed) {
      unscheduled.push({ key, reason: 'no sprint with capacity in the horizon' });
      continue;
    }
    const absStart = placed.band.from + placed.offset;
    const absEnd = absStart + days;
    cursors.set(who, absEnd);
    finishOf.set(key, absEnd);
    const capacityHere = budget(who, placed.band.name);
    const plannedIdx = bands.findIndex((b) => b.name === issue.effectiveSprint);
    blocks.push({
      key,
      assignee: who,
      overflow: placed.offset + days > capacityHere + 0.001,
      sprint: placed.band.name,
      plannedSprint: issue.effectiveSprint,
      offsetDays: round(placed.offset),
      days: round(days),
      // work that was never in a sprint is newly scheduled, not slipped
      slipped: plannedIdx >= 0 && bands.findIndex((b) => b.name === placed?.band.name) > plannedIdx,
      estimated: issue.effectiveEffort !== null,
    });
  }

  for (const key of cycles[0] ?? []) {
    unscheduled.push({ key, reason: 'dependency cycle' });
  }

  // ---- plan-order violations (today's plan, not the forecast) --------------
  const idx = (sprint: string) => {
    const i = bands.findIndex((b) => b.name === sprint);
    return i === -1 ? bands.length : i; // Backlog sorts last
  };
  const violations: { key: string; blocker: string; detail: string }[] = [];
  for (const i of open) {
    for (const b of [...new Set([...i.dependsOn, ...i.blockedBy])]) {
      const blocker = inScope.get(b);
      if (!blocker) continue;
      if (idx(blocker.effectiveSprint) > idx(i.effectiveSprint)) {
        violations.push({
          key: i.key,
          blocker: b,
          detail: `${b} is planned into ${blocker.effectiveSprint}, after ${i.key} in ${i.effectiveSprint}`,
        });
      }
    }
  }

  const lastEnd = blocks.length
    ? Math.max(...blocks.map((b) => bandFrom(bands, b) + b.days))
    : null;
  const finishBand =
    lastEnd === null
      ? null
      : (bands.find((b) => lastEnd > b.from && lastEnd <= b.from + b.length) ??
        bands.at(-1) ??
        null);
  const finishDate =
    lastEnd !== null && bands[0]?.start
      ? addWorkingDays(bands[0].start, lastEnd).toISOString().slice(0, 10)
      : null;

  return {
    blocks,
    unscheduled,
    cycles,
    violations,
    finishSprint: finishBand?.name ?? null,
    finishDate,
  };
}

function bandFrom(bands: Band[], b: ScheduledBlock): number {
  return (bands.find((x) => x.name === b.sprint)?.from ?? 0) + b.offsetDays;
}

/**
 * Today's plan laid out on the same timeline: every issue in the sprint it is
 * planned into, stacked per person in rank order. Blocks that run past the
 * person's capacity for that sprint are marked, which is what makes an
 * over-committed sprint visible at a glance.
 */
export function layoutPlan(input: ForecastInput): {
  blocks: ScheduledBlock[];
  backlog: string[];
} {
  const bands = bandsOf(input.sprints);
  const names = new Set(bands.map((b) => b.name));
  const open = input.issues.filter((i) => i.statusCategory !== 'done');
  const backlog = open.filter((i) => !names.has(i.effectiveSprint)).map((i) => i.key);
  const cursor = new Map<string, number>();
  const blocks: ScheduledBlock[] = [];

  const ordered = [...open]
    .filter((i) => names.has(i.effectiveSprint))
    .sort(
      (a, b) =>
        (a.plan.rank ?? Number.POSITIVE_INFINITY) - (b.plan.rank ?? Number.POSITIVE_INFINITY) ||
        a.key.localeCompare(b.key),
    );

  for (const i of ordered) {
    const who = i.effectiveAssignee ?? '(unassigned)';
    const days =
      i.effectiveEffort === null
        ? input.unestimatedDays
        : Math.max(input.toDays(i.effectiveEffort), 0.25);
    const slot = `${who}\u0000${i.effectiveSprint}`;
    const offset = cursor.get(slot) ?? 0;
    cursor.set(slot, offset + days);
    const capacity = input.capacityDays[who]?.[i.effectiveSprint] ?? input.defaultCapacityDays;
    blocks.push({
      key: i.key,
      assignee: who,
      sprint: i.effectiveSprint,
      plannedSprint: i.effectiveSprint,
      offsetDays: round(offset),
      days: round(days),
      slipped: false,
      estimated: i.effectiveEffort !== null,
      overflow: offset + days > capacity + 0.001,
    });
  }
  return { blocks, backlog };
}
