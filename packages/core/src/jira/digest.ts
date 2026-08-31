/**
 * Change digest: what moved in Jira between two syncs.
 *
 * The mirror already caches every issue's raw JSON under
 * `.corpobrain/jira-cache/issues/KEY.json`, so the previous sync's state is on
 * disk for free — the digest diffs against that and appends the result to a
 * JSONL journal. No extra network calls, and it works retroactively on a vault
 * that has been syncing for months.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedIssue } from './render.ts';

export interface IssueSnapshot {
  summary: string;
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  assigneeName: string | null;
  sprint: string | null;
  estimate: number | null;
  priority: string | null;
  issueType: string | null;
  epic: string | null;
}

export type ChangeKind =
  | 'created'
  | 'status'
  | 'done'
  | 'reopened'
  | 'assignee'
  | 'sprint'
  | 'estimate'
  | 'summary'
  | 'priority'
  | 'epic';

export interface ChangeEvent {
  /** sync timestamp; every event from one refresh shares it */
  at: string;
  profile: string;
  key: string;
  kind: ChangeKind;
  from: string | null;
  to: string | null;
  /** issue context at the time of the change, for grouping without a second lookup */
  summary: string;
  assignee: string | null;
  assigneeName: string | null;
  sprint: string | null;
  statusCategory: string | null;
}

export function snapshotOf(i: NormalizedIssue): IssueSnapshot {
  return {
    summary: i.summary,
    status: i.status,
    statusCategory: i.statusCategory,
    assignee: i.assignee?.id ?? null,
    assigneeName: i.assignee?.name ?? null,
    sprint: i.sprint?.name ?? null,
    estimate: i.estimate,
    priority: i.priority,
    issueType: i.issueType,
    epic: i.epic,
  };
}

const num = (n: number | null): string | null => (n === null ? null : String(n));

/** Field-level changes between two snapshots of one issue. */
export function diffIssue(
  prev: IssueSnapshot | null | undefined,
  next: IssueSnapshot,
  meta: { at: string; profile: string; key: string },
): ChangeEvent[] {
  const ctx = {
    ...meta,
    summary: next.summary,
    assignee: next.assignee,
    assigneeName: next.assigneeName,
    sprint: next.sprint,
    statusCategory: next.statusCategory,
  };
  if (!prev) {
    return [{ ...ctx, kind: 'created', from: null, to: next.status }];
  }
  const events: ChangeEvent[] = [];
  const push = (kind: ChangeKind, from: string | null, to: string | null): void => {
    events.push({ ...ctx, kind, from, to });
  };

  if (prev.status !== next.status) {
    const kind: ChangeKind =
      next.statusCategory === 'done' && prev.statusCategory !== 'done'
        ? 'done'
        : prev.statusCategory === 'done' && next.statusCategory !== 'done'
          ? 'reopened'
          : 'status';
    push(kind, prev.status, next.status);
  }
  if (prev.assignee !== next.assignee) push('assignee', prev.assigneeName, next.assigneeName);
  if (prev.sprint !== next.sprint) push('sprint', prev.sprint, next.sprint);
  if (prev.estimate !== next.estimate) push('estimate', num(prev.estimate), num(next.estimate));
  if (prev.summary !== next.summary) push('summary', prev.summary, next.summary);
  if (prev.priority !== next.priority) push('priority', prev.priority, next.priority);
  if (prev.epic !== next.epic) push('epic', prev.epic, next.epic);
  return events;
}

/** One-line rendering shared by the UI and any export. */
export function formatEvent(e: ChangeEvent): string {
  const who = e.assigneeName ? ` (${e.assigneeName})` : '';
  const arrow = `${e.from ?? '—'} → ${e.to ?? '—'}`;
  switch (e.kind) {
    case 'created':
      return `${e.key} added to the mirror${who}`;
    case 'done':
      return `${e.key} done (${arrow})${who}`;
    case 'reopened':
      return `${e.key} reopened (${arrow})${who}`;
    case 'status':
      return `${e.key} status ${arrow}${who}`;
    case 'assignee':
      return `${e.key} reassigned ${arrow}`;
    case 'sprint':
      return `${e.key} moved ${arrow}${who}`;
    case 'estimate':
      return `${e.key} re-estimated ${arrow}${who}`;
    case 'summary':
      return `${e.key} renamed ${arrow}`;
    case 'priority':
      return `${e.key} priority ${arrow}${who}`;
    case 'epic':
      return `${e.key} epic ${arrow}`;
  }
}

const MAX_LINES = 20_000;

/** Append-only JSONL journal of change events. */
export class DigestStore {
  readonly file: string;

  constructor(cacheDir: string) {
    this.file = join(cacheDir, 'digest.jsonl');
  }

  append(events: ChangeEvent[]): void {
    if (!events.length) return;
    appendFileSync(this.file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    this.trim();
  }

  /** Newest first. */
  read(opts: { since?: string; limit?: number } = {}): ChangeEvent[] {
    if (!existsSync(this.file)) return [];
    const out: ChangeEvent[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as ChangeEvent;
        if (opts.since && e.at < opts.since) continue;
        out.push(e);
      } catch {
        /* a torn line is not worth failing the digest over */
      }
    }
    out.reverse();
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /** Distinct refresh timestamps, newest first. */
  runs(limit = 30): string[] {
    const seen = new Set<string>();
    for (const e of this.read()) {
      seen.add(e.at);
      if (seen.size >= limit) break;
    }
    return [...seen];
  }

  private trim(): void {
    try {
      const lines = readFileSync(this.file, 'utf8')
        .split('\n')
        .filter((l) => l.trim());
      if (lines.length <= MAX_LINES) return;
      writeFileSync(this.file, `${lines.slice(-MAX_LINES).join('\n')}\n`);
    } catch {
      /* trimming is best effort */
    }
  }
}
