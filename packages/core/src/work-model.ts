/**
 * The work log's vocabulary and shapes (see work.ts), free of any Node
 * import so the UI can share them.
 */

/** Where a branch is on its way to a release. `parked` is off the path. */
export const WORK_STAGES = [
  'dev',
  'in-uat-branch',
  'on-uat',
  'pr-open',
  'released',
  'parked',
] as const;
export type WorkStage = (typeof WORK_STAGES)[number];
export const WORK_STAGE_LABEL: Record<WorkStage, string> = {
  dev: 'In development',
  'in-uat-branch': 'In the UAT branch',
  'on-uat': 'On UAT',
  'pr-open': 'PR to release',
  released: 'Released',
  parked: 'Parked',
};

/** Whose move it is. */
export const WORK_WAITING = ['me', 'agent', 'tester', 'reviewer', 'nobody'] as const;
export type WorkWaiting = (typeof WORK_WAITING)[number];

/** One progress report from an agent (or from the user through the CLI). */
export interface WorkReport {
  repo: string;
  branch: string;
  /** what was done since the last report */
  summary: string;
  /** where it stopped: the state the work is in right now */
  state?: string | undefined;
  /** the next step */
  next?: string | undefined;
  waitingOn?: WorkWaiting | undefined;
  stage?: WorkStage | undefined;
  /** a short name for the chat or thread reporting */
  chat?: string | undefined;
  /** Jira key the work belongs to */
  issue?: string | undefined;
  /** a readable name for the work; defaults to the branch */
  title?: string | undefined;
  /** the branches this one is headed for, as plain facts: no naming scheme is assumed */
  uatBranch?: string | undefined;
  releaseBranch?: string | undefined;
  /** pull request URL or number */
  pr?: string | undefined;
  /** absolute path of the local clone, for the git checks */
  clone?: string | undefined;
}

/** What the user changes from the app. `null` clears a text field. */
export interface WorkPatch {
  stage?: WorkStage;
  waitingOn?: WorkWaiting;
  next?: string | null;
  uatBranch?: string | null;
  releaseBranch?: string | null;
  pr?: string | null;
}

/** A work note as lists and boards see it (from its frontmatter). */
export interface WorkItem {
  path: string;
  title: string;
  repo: string;
  branch: string;
  stage: WorkStage;
  waitingOn: WorkWaiting;
  state: string | null;
  next: string | null;
  chat: string | null;
  /** ISO timestamp of the last report or edit */
  updated: string | null;
  issue: string | null;
  uatBranch: string | null;
  releaseBranch: string | null;
  pr: string | null;
  clone: string | null;
}

export function isWorkStage(v: unknown): v is WorkStage {
  return typeof v === 'string' && (WORK_STAGES as readonly string[]).includes(v);
}
export function isWorkWaiting(v: unknown): v is WorkWaiting {
  return typeof v === 'string' && (WORK_WAITING as readonly string[]).includes(v);
}
