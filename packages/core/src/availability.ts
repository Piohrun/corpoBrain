/**
 * Availability: who is away, and when.
 *
 * The source of truth is a markdown table in a vault note, so it can be edited
 * by hand (or pasted in from a spreadsheet) today and written by a calendar
 * sync later without changing anything downstream. Absence reduces a person's
 * bandwidth for the sprints it overlaps, which is what the planning grid, the
 * sprint-health checks and the project forecast all read.
 */

export type AbsenceKind = 'ooo' | 'holiday' | 'support';

export interface AvailabilityEntry {
  /** as written in the table: a name, a wikilink target, or a Jira id */
  person: string;
  /** inclusive, YYYY-MM-DD */
  from: string;
  /** inclusive, YYYY-MM-DD */
  to: string;
  kind: AbsenceKind;
  note: string;
}

export interface AvailabilityParse {
  entries: AvailabilityEntry[];
  warnings: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

export const isSeparator = (line: string): boolean => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);

/** Strip a wikilink or bold wrapper from a person cell. */
export function personCell(raw: string): string {
  const link = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(raw.trim());
  return (link?.[1] ?? raw).replace(/\*\*/g, '').trim();
}

export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (DATE_RE.test(s)) return s;
  // tolerate what a spreadsheet paste produces
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy as unknown as [string, string, string, string];
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) && /\d{4}/.test(s)
    ? parsed.toISOString().slice(0, 10)
    : null;
}

/** Read the availability table out of a note. Malformed rows are reported, not thrown. */
export function parseAvailability(markdown: string): AvailabilityParse {
  const lines = markdown.split('\n');
  const entries: AvailabilityEntry[] = [];
  const warnings: string[] = [];
  let inFence = false;
  let header: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.includes('|')) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (!header) {
      const lower = cells.map((c) => c.toLowerCase());
      if (
        lower[0]?.startsWith('person') &&
        lower.includes('from') &&
        isSeparator(lines[i + 1] ?? '')
      )
        header = lower;
      continue;
    }
    if (isSeparator(line)) continue;

    const at = (name: string) => {
      const idx = header?.indexOf(name) ?? -1;
      return idx >= 0 ? (cells[idx] ?? '') : '';
    };
    const person = personCell(at('person'));
    if (!person) continue;
    const from = normalizeDate(at('from'));
    if (!from) {
      warnings.push(`${person}: could not read the "from" date "${at('from')}"`);
      continue;
    }
    const to = normalizeDate(at('to')) ?? from;
    if (to < from) {
      warnings.push(`${person}: ${to} is before ${from}`);
      continue;
    }
    const kindRaw = at('type').toLowerCase();
    const kind: AbsenceKind =
      kindRaw.startsWith('sup') || kindRaw.startsWith('rota')
        ? 'support'
        : kindRaw.startsWith('hol') || kindRaw.startsWith('bank')
          ? 'holiday'
          : 'ooo';
    entries.push({ person, from, to, kind, note: at('note') });
  }
  return { entries, warnings };
}

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|');

export function renderAvailabilityTable(entries: AvailabilityEntry[]): string {
  const rows = [...entries].sort(
    (a, b) => a.from.localeCompare(b.from) || a.person.localeCompare(b.person),
  );
  return [
    '| Person | From | To | Type | Note |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (e) =>
        `| [[${escapeCell(e.person)}]] | ${e.from} | ${e.to} | ${e.kind} | ${escapeCell(e.note)} |`,
    ),
  ].join('\n');
}

/** Replace the availability table in a note, preserving everything around it. */
export function replaceAvailabilityTable(markdown: string, entries: AvailabilityEntry[]): string {
  const table = renderAvailabilityTable(entries);
  const lines = markdown.split('\n');
  let start = -1;
  let end = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.includes('|')) continue;
    const lower = splitRow(line).map((c) => c.toLowerCase());
    if (start === -1 && lower[0]?.startsWith('person') && isSeparator(lines[i + 1] ?? '')) {
      start = i;
      end = i + 1;
      while (end + 1 < lines.length && (lines[end + 1] as string).trim().startsWith('|')) end++;
      break;
    }
  }
  if (start === -1) {
    const body = markdown.replace(/\s*$/, '');
    return `${body}\n\n${table}\n`;
  }
  return [...lines.slice(0, start), table, ...lines.slice(end + 1)].join('\n');
}

// ------------------------------------------------------------ absence maths

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
const isWeekend = (d: Date): boolean => d.getUTCDay() === 0 || d.getUTCDay() === 6;

/**
 * The civil day Jira wrote for a sprint boundary. The first ten characters
 * carry the date in the board's own zone; converting through `new Date()`
 * would shift it by the offset and, for an end like `…T17:00+02:00`, drop the
 * last day of the sprint. Null when the string does not start with a date.
 */
export function civilDay(iso: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  return m ? (m[1] as string) : null;
}

/** UTC midnight of a YYYY-MM-DD day (Invalid Date for anything else). */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** UTC midnight of the sprint's first day. */
export function sprintStart(iso: string): Date {
  return dayStart(civilDay(iso) ?? iso);
}

/**
 * The instant a sprint stops counting: midnight after its last civil day. A
 * timed Jira end (`…T17:00`) and a date-only local sprint (`2026-09-11`) both
 * include that whole day.
 */
export function endExclusive(iso: string): Date {
  const d = sprintStart(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Weekdays a sprint covers, first and last day included. */
export function sprintDays(start: string, end: string): string[] {
  return weekdaysIn(sprintStart(start), endExclusive(end));
}

/** Weekdays in [from, to) as YYYY-MM-DD. */
export function weekdaysIn(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur < end) {
    if (!isWeekend(cur)) out.push(dayKey(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export interface Absence {
  ooo: number;
  /** country-wide bank holidays */
  holiday: number;
  support: number;
  /** working days in the sprint */
  total: number;
  /** working days the person can actually spend on their issues */
  available: number;
}

export interface SprintSpan {
  name: string;
  start: string | null;
  end: string | null;
}

/**
 * Absence per person per sprint. A day that is both OOO and support counts
 * once, as OOO — nobody is doubly away.
 */
const KIND_RANK: Record<AbsenceKind, number> = { ooo: 3, holiday: 2, support: 1 };

export function absencesBySprint(
  entries: AvailabilityEntry[],
  sprints: SprintSpan[],
  supportFactor = 0,
): Map<string, Map<string, Absence>> {
  // person → sprint → day → kind, so a day claimed twice is only counted once
  const claimed = new Map<string, Map<string, Map<string, AbsenceKind>>>();
  const daysOf = new Map<string, Set<string>>();

  for (const s of sprints) {
    if (!s.start || !s.end) continue;
    const days = sprintDays(s.start, s.end);
    if (days.length) daysOf.set(s.name, new Set(days));
  }

  for (const e of entries) {
    const to = new Date(`${e.to}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1); // entry dates are inclusive
    const away = weekdaysIn(new Date(`${e.from}T00:00:00Z`), to);
    for (const [sprint, days] of daysOf) {
      const hits = away.filter((d) => days.has(d));
      if (!hits.length) continue;
      const perPerson = claimed.get(e.person) ?? new Map<string, Map<string, AbsenceKind>>();
      const perSprint = perPerson.get(sprint) ?? new Map<string, AbsenceKind>();
      for (const d of hits) {
        // one day counts once: personal leave > bank holiday > support rota
        const had = perSprint.get(d);
        if (!had || KIND_RANK[e.kind] > KIND_RANK[had]) perSprint.set(d, e.kind);
      }
      perPerson.set(sprint, perSprint);
      claimed.set(e.person, perPerson);
    }
  }

  const out = new Map<string, Map<string, Absence>>();
  for (const [person, perPerson] of claimed) {
    const perSprint = new Map<string, Absence>();
    for (const [sprint, days] of perPerson) {
      const total = daysOf.get(sprint)?.size ?? 0;
      const kinds = [...days.values()];
      const ooo = kinds.filter((k) => k === 'ooo').length;
      const holiday = kinds.filter((k) => k === 'holiday').length;
      const support = kinds.length - ooo - holiday;
      perSprint.set(sprint, {
        ooo,
        holiday,
        support,
        total,
        available: Math.round((total - ooo - holiday - support * (1 - supportFactor)) * 100) / 100,
      });
    }
    out.set(person, perSprint);
  }
  return out;
}

/** Bandwidth left after absence, in the capacity unit. Never negative. */
export function adjustCapacity(base: number, absence: Absence | undefined): number {
  if (!absence || absence.total <= 0 || absence.available >= absence.total) return base;
  return Math.max(0, Math.round(base * (absence.available / absence.total) * 2) / 2);
}
