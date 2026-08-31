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

/** nameColor as #rrggbb (color inputs cannot display hsl strings). */
export function nameColorHex(name: string | null): string {
  if (!name) return '#888888';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return hslToHex(h, 52, 46);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
