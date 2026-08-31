/** Shared at-a-glance color coding. */

/**
 * Jira status → dot color. Backed by status_category (stable across
 * instances) with a name heuristic for the "ready/review" band that
 * category alone cannot distinguish.
 */
export function statusColor(status: string | null, category: string | null): string {
  if (category === 'done') return 'var(--st-done)';
  const s = (status ?? '').toLowerCase();
  if (/ready|release|review|uat|verif|deploy|approv/.test(s)) return 'var(--st-ready)';
  if (category === 'indeterminate') return 'var(--st-progress)';
  return 'var(--st-todo)';
}

export function statusTitle(status: string | null, category: string | null): string {
  return `${status ?? 'unknown'} (${
    category === 'done' ? 'done' : category === 'indeterminate' ? 'in progress' : 'to do'
  })`;
}

/** Deterministic hue per name (regions, teams) — same name, same color, everywhere. */
export function nameColor(name: string | null): string {
  if (!name) return 'transparent';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 52% 46%)`;
}
