/** Planning math per docs/SPEC.md §7: effective values and effort conversion. */
import type { VaultConfig } from './config.ts';

export type EffortUnit = 'points' | 'days' | 'hours' | 'seconds';

/** Convert an effort value between units using vault capacity settings. */
export function convertEffort(
  value: number,
  from: EffortUnit,
  to: 'days' | 'points' | 'hours',
  cfg: VaultConfig['capacity'],
): number | null {
  if ((from as string) === (to as string)) return value;
  // normalise to days first
  let days: number;
  switch (from) {
    case 'days':
      days = value;
      break;
    case 'points':
      days = cfg.pointsPerDay > 0 ? value / cfg.pointsPerDay : Number.NaN;
      break;
    case 'hours':
      days = cfg.hoursPerDay > 0 ? value / cfg.hoursPerDay : Number.NaN;
      break;
    case 'seconds':
      days = cfg.hoursPerDay > 0 ? value / 3600 / cfg.hoursPerDay : Number.NaN;
      break;
  }
  let out: number;
  switch (to) {
    case 'days':
      out = days;
      break;
    case 'points':
      out = days * cfg.pointsPerDay;
      break;
    case 'hours':
      out = days * cfg.hoursPerDay;
      break;
  }
  return Number.isFinite(out) ? Math.round(out * 100) / 100 : null;
}

export interface IssueRiskInput {
  statusCategory: string | null;
  assignee: string | null;
  planAssignee: string | null;
  estimate: number | null;
  planEffort: number | null;
  updated: string | null;
  blockedOn: string[];
  blockedOnUnresolved: string[];
  priority: string | null;
}

export type RiskFlag = 'unestimated' | 'unassigned' | 'stale' | 'blocked' | 'high-priority-stale';

export function issueRiskFlags(i: IssueRiskInput, now: Date, staleDays = 14): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (i.statusCategory === 'done') return flags;
  if (i.estimate === null && i.planEffort === null) flags.push('unestimated');
  if (!i.assignee && !i.planAssignee) flags.push('unassigned');
  let stale = false;
  if (i.updated) {
    const age = (now.getTime() - new Date(i.updated).getTime()) / 86_400_000;
    if (age > staleDays) {
      stale = true;
      flags.push('stale');
    }
  }
  if (i.blockedOnUnresolved.length > 0) flags.push('blocked');
  if (
    stale &&
    (i.priority === 'Highest' ||
      i.priority === 'High' ||
      i.priority === 'Critical' ||
      i.priority === 'Blocker')
  ) {
    flags.push('high-priority-stale');
  }
  return flags;
}
