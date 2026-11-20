/** How the work log (core/work.ts) is read on screen: what needs you, what has gone quiet. */
import type { WorkGitFacts, WorkItem, WorkStage } from '../../core/src/work-model.ts';

export const STAGE_SHORT: Record<WorkStage, string> = {
  dev: 'dev',
  'in-uat-branch': 'UAT branch',
  'on-uat': 'on UAT',
  'pr-open': 'PR',
  released: 'released',
  parked: 'parked',
};

/** no report for this many days on unfinished work: worth a look */
export const QUIET_DAYS = 7;
const DAY_MS = 86_400_000;

export const isActive = (w: WorkItem): boolean => w.stage !== 'released' && w.stage !== 'parked';
export const needsYou = (w: WorkItem): boolean => isActive(w) && w.waitingOn === 'me';

/** whole days since the last report (null when the note never had one) */
export function quietDays(w: WorkItem, now = Date.now()): number | null {
  const at = w.updated ? Date.parse(w.updated) : Number.NaN;
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / DAY_MS));
}
export const isQuiet = (w: WorkItem, now = Date.now()): boolean =>
  isActive(w) && (quietDays(w, now) ?? 0) >= QUIET_DAYS;

/** "just now", "3 h ago", "yesterday", "9 days ago" */
export function ageLabel(w: WorkItem, now = Date.now()): string {
  const at = w.updated ? Date.parse(w.updated) : Number.NaN;
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 5) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Unfinished work, the order to look at it in: yours to move first, then the quiet, then the freshest. */
export function workInProgress(items: WorkItem[], now = Date.now()): WorkItem[] {
  const rank = (w: WorkItem) => (needsYou(w) ? 0 : isQuiet(w, now) ? 1 : 2);
  return items
    .filter(isActive)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.updated ?? '').localeCompare(a.updated ?? '') ||
        a.title.localeCompare(b.title),
    );
}

export interface GitNote {
  text: string;
  /** warn: work that exists only on this machine */
  tone: 'warn' | 'info';
  title: string;
}

/** What the clone adds to a branch's row, the things that can be lost first. */
export function gitNotes(facts: WorkGitFacts | undefined): GitNote[] {
  if (!facts?.available) return [];
  const notes: GitNote[] = [];
  if (facts.dirty)
    notes.push({
      text: `${facts.dirty} uncommitted`,
      tone: 'warn',
      title: 'Files changed in the clone but not committed',
    });
  if (facts.local && facts.upstream === null)
    notes.push({
      text: 'not pushed',
      tone: 'warn',
      title: 'The branch has no upstream: it exists only in the local clone',
    });
  if (facts.ahead)
    notes.push({
      text: `${facts.ahead} unpushed`,
      tone: 'warn',
      title: `Commits that are not on ${facts.upstream ?? 'the remote'} yet`,
    });
  if (facts.behind)
    notes.push({
      text: `${facts.behind} behind`,
      tone: 'info',
      title: `${facts.upstream ?? 'The remote'} has commits this clone does not`,
    });
  return notes;
}

/**
 * The stage git says the branch has reached, when the note is behind it:
 * contained in its release branch, or in its UAT branch while still "dev".
 * Only for branches the note names — nothing is guessed from branch names.
 */
export function suggestedStage(item: WorkItem, facts: WorkGitFacts | undefined): WorkStage | null {
  if (!facts?.available || !isActive(item)) return null;
  if (facts.inRelease) return 'released';
  if (facts.inUat && item.stage === 'dev') return 'in-uat-branch';
  return null;
}
