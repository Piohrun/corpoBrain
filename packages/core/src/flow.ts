/**
 * Flow metrics from an issue's transition history (SPEC: jira changelog →
 * `transitions`). Pure: bands in, numbers out. Durations are calendar days
 * with two decimals — honest about weekends, and comparable across teams.
 */
import type { Transition } from './jira/render.ts';

export type StatusCategory = 'new' | 'indeterminate' | 'done';

export interface StatusBand {
  status: string;
  /** ISO instant the issue entered this status */
  from: string;
  /** ISO instant it left, null while current */
  to: string | null;
}

const DAY_MS = 86_400_000;

export function daysBetween(a: string | Date, b: string | Date): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round((ms / DAY_MS) * 100) / 100;
}

/**
 * The statuses an issue has been in, in order, from its creation. The first
 * band's name comes from the first status transition's `from` (or the current
 * status when it never changed).
 */
export function statusBands(
  created: string,
  transitions: Transition[],
  currentStatus: string | null,
): StatusBand[] {
  const moves = transitions
    .filter((t) => t.field === 'status')
    .sort((a, b) => a.at.localeCompare(b.at));
  const bands: StatusBand[] = [];
  let status = moves[0]?.from ?? currentStatus ?? 'unknown';
  let since = created;
  for (const m of moves) {
    bands.push({ status, from: since, to: m.at });
    status = m.to ?? status;
    since = m.at;
  }
  bands.push({ status, from: since, to: null });
  return bands;
}

export interface FlowTimes {
  /** first entry into an in-progress status */
  startedAt: string | null;
  /** entry into the final done status (null while open or reopened) */
  doneAt: string | null;
  cycleDays: number | null;
  leadDays: number | null;
  /** open issues: days since started (null when never started) */
  ageDays: number | null;
  /** days in the current status */
  inStatusDays: number;
  /** total days per status, done and open alike */
  perStatus: Record<string, number>;
}

export function flowTimes(
  bands: StatusBand[],
  categoryOf: (status: string) => StatusCategory | null,
  now: Date,
): FlowTimes {
  const first = bands[0];
  const last = bands[bands.length - 1];
  if (!first || !last) {
    return {
      startedAt: null,
      doneAt: null,
      cycleDays: null,
      leadDays: null,
      ageDays: null,
      inStatusDays: 0,
      perStatus: {},
    };
  }
  const startedAt = bands.find((b) => categoryOf(b.status) === 'indeterminate')?.from ?? null;
  const isDone = categoryOf(last.status) === 'done';
  // entry into the final stretch of done statuses (a Done → Closed hop is not a reopen)
  let doneAt: string | null = null;
  if (isDone) {
    let i = bands.length - 1;
    while (i > 0 && categoryOf((bands[i - 1] as StatusBand).status) === 'done') i--;
    doneAt = (bands[i] as StatusBand).from;
  }
  const perStatus: Record<string, number> = {};
  for (const b of bands) {
    perStatus[b.status] =
      Math.round(((perStatus[b.status] ?? 0) + daysBetween(b.from, b.to ?? now)) * 100) / 100;
  }
  return {
    startedAt,
    doneAt,
    cycleDays: doneAt && startedAt ? daysBetween(startedAt, doneAt) : null,
    leadDays: doneAt ? daysBetween(first.from, doneAt) : null,
    ageDays: !isDone && startedAt ? daysBetween(startedAt, now) : null,
    inStatusDays: daysBetween(last.from, now),
    perStatus,
  };
}

/** Nearest-rank percentile (p in 0..100); null on an empty sample. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] as number;
}

/** A sprint transition value ("Sprint 36, Sprint 37") names this sprint? */
export function mentionsSprint(value: string | null, name: string): boolean {
  if (!value) return false;
  return value.split(',').some((s) => s.trim() === name);
}

export interface SprintChurn {
  /** joined after the sprint started */
  added: { key: string; at: string; by: string | null }[];
  /** left while the sprint was running */
  removed: { key: string; at: string; by: string | null; to: string | null }[];
  /** estimate changed while the sprint was running */
  reestimated: {
    key: string;
    at: string;
    by: string | null;
    from: string | null;
    to: string | null;
  }[];
}

/**
 * Scope changes during a sprint, from sprint and estimate transitions of
 * every issue that ever mentioned it. `start`/`end` are ISO instants.
 */
export function sprintChurn(
  sprint: { name: string; start: string; end: string },
  transitionsByKey: Map<string, Transition[]>,
): SprintChurn {
  const churn: SprintChurn = { added: [], removed: [], reestimated: [] };
  const inWindow = (at: string) => at > sprint.start && at <= sprint.end;
  for (const [key, ts] of transitionsByKey) {
    let member = false;
    for (const t of ts) {
      if (t.field === 'sprint') {
        const was = mentionsSprint(t.from, sprint.name);
        const is = mentionsSprint(t.to, sprint.name);
        if (!was && is) {
          member = true;
          if (t.at > sprint.start) churn.added.push({ key, at: t.at, by: t.author });
        } else if (was && !is) {
          member = false;
          if (inWindow(t.at)) churn.removed.push({ key, at: t.at, by: t.author, to: t.to });
        }
      } else if (t.field === 'estimate' && member && inWindow(t.at)) {
        churn.reestimated.push({ key, at: t.at, by: t.author, from: t.from, to: t.to });
      }
    }
  }
  for (const list of [churn.added, churn.removed, churn.reestimated])
    list.sort((a, b) => a.at.localeCompare(b.at));
  return churn;
}
