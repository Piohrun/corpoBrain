import type { BoardModel, BoardPerson } from '../api.ts';

export const UNASSIGNED = '(unassigned)';
export type GroupBy = 'region' | 'team' | 'region-team' | 'none';

export interface Row {
  id: string;
  name: string;
  jiraId: string | null;
  capacity: number | null;
  capacityIsDefault: boolean;
  overrides: Record<string, number>;
  loadOverrides: Record<string, number>;
  suggested: Record<string, number>;
  absence: BoardPerson['absence'];
  region: string | null;
  team: string | null;
  editable: boolean;
  path: string | null;
}

export function personName(board: BoardModel, assignee: string | null): string {
  if (!assignee) return '—';
  return board.people.find((p) => p.jiraIds.includes(assignee))?.name ?? assignee;
}
