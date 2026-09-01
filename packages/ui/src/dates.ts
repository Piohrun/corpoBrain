/** Calendar-date helpers. The app reasons in the user's local day, not UTC. */

const pad = (n: number): string => String(n).padStart(2, '0');

/** YYYY-MM-DD of `d` in the local timezone (toISOString would give the UTC day). */
export function localISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day `months` months before `d`, as YYYY-MM-DD. */
export function monthsAgo(months: number, d: Date = new Date()): string {
  const x = new Date(d.getFullYear(), d.getMonth() - months, d.getDate());
  return localISODate(x);
}
