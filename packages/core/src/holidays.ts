/**
 * Country-wide bank holidays: a table in a vault note (`Country | From | To |
 * Name`). Everyone whose person note carries that `country:` is automatically
 * away on those days — no per-person entries to maintain.
 */
import { isSeparator, normalizeDate, splitRow } from './availability.ts';

export interface HolidayEntry {
  country: string;
  /** inclusive, YYYY-MM-DD */
  from: string;
  /** inclusive, YYYY-MM-DD */
  to: string;
  name: string;
}

export interface HolidaysParse {
  entries: HolidayEntry[];
  warnings: string[];
}

/** Canonical lowercase country key, tolerant of the usual aliases. */
export function normalizeCountry(raw: string): string {
  const n = raw.trim().toLowerCase();
  const alias: Record<string, string> = {
    'united kingdom': 'uk',
    'great britain': 'uk',
    gb: 'uk',
    england: 'uk',
    'united states': 'usa',
    us: 'usa',
    america: 'usa',
    'people’s republic of china': 'china',
    "people's republic of china": 'china',
    prc: 'china',
    cn: 'china',
    in: 'india',
    pl: 'poland',
    polska: 'poland',
    ca: 'canada',
  };
  return alias[n] ?? n;
}

export function parseHolidays(markdown: string): HolidaysParse {
  const lines = markdown.split('\n');
  const entries: HolidayEntry[] = [];
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
        lower[0]?.startsWith('country') &&
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
    const country = at('country').trim();
    if (!country) continue;
    const from = normalizeDate(at('from'));
    if (!from) {
      warnings.push(`${country}: could not read the "from" date "${at('from')}"`);
      continue;
    }
    const to = normalizeDate(at('to')) ?? from;
    if (to < from) {
      warnings.push(`${country}: ${to} is before ${from}`);
      continue;
    }
    entries.push({ country, from, to, name: at('name') });
  }
  return { entries, warnings };
}

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|');

export function renderHolidaysTable(entries: HolidayEntry[]): string {
  const rows = [...entries].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.country.localeCompare(b.country) ||
      a.name.localeCompare(b.name),
  );
  return [
    '| Country | From | To | Name |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (e) => `| ${escapeCell(e.country)} | ${e.from} | ${e.to} | ${escapeCell(e.name)} |`,
    ),
  ].join('\n');
}

/** Replace the holidays table in a note, preserving everything around it. */
export function replaceHolidaysTable(markdown: string, entries: HolidayEntry[]): string {
  const table = renderHolidaysTable(entries);
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
    if (start === -1 && lower[0]?.startsWith('country') && isSeparator(lines[i + 1] ?? '')) {
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

const H = (country: string, from: string, name: string, to = from): HolidayEntry => ({
  country,
  from,
  to,
  name,
});

/**
 * Built-in bank holidays for 2026–2027. Fixed-date and rule-based holidays
 * (UK, USA, Canada, Poland) are reliable; China's golden-week arrangements and
 * India's festival dates move — treat those as a starting point to verify
 * against the local calendar. India carries only the nationally observed set;
 * state holidays vary too much to guess.
 */
export const BUILTIN_HOLIDAYS: HolidayEntry[] = [
  // ---- Poland ----
  H('Poland', '2026-01-01', "New Year's Day"),
  H('Poland', '2026-01-06', 'Epiphany'),
  H('Poland', '2026-04-06', 'Easter Monday'),
  H('Poland', '2026-05-01', 'Labour Day'),
  H('Poland', '2026-05-03', 'Constitution Day'),
  H('Poland', '2026-06-04', 'Corpus Christi'),
  H('Poland', '2026-08-15', 'Assumption Day'),
  H('Poland', '2026-11-11', 'Independence Day'),
  H('Poland', '2026-12-24', 'Christmas Eve'),
  H('Poland', '2026-12-25', 'Christmas Day'),
  H('Poland', '2026-12-26', 'Second Day of Christmas'),
  H('Poland', '2027-01-01', "New Year's Day"),
  H('Poland', '2027-01-06', 'Epiphany'),
  H('Poland', '2027-03-29', 'Easter Monday'),
  H('Poland', '2027-05-03', 'Constitution Day'),
  H('Poland', '2027-05-27', 'Corpus Christi'),
  H('Poland', '2027-11-01', 'All Saints'),
  H('Poland', '2027-11-11', 'Independence Day'),
  H('Poland', '2027-12-24', 'Christmas Eve'),
  H('Poland', '2027-12-27', 'Christmas (in lieu)'),
  // ---- UK (England & Wales) ----
  H('UK', '2026-01-01', "New Year's Day"),
  H('UK', '2026-04-03', 'Good Friday'),
  H('UK', '2026-04-06', 'Easter Monday'),
  H('UK', '2026-05-04', 'Early May Bank Holiday'),
  H('UK', '2026-05-25', 'Spring Bank Holiday'),
  H('UK', '2026-08-31', 'Summer Bank Holiday'),
  H('UK', '2026-12-25', 'Christmas Day'),
  H('UK', '2026-12-28', 'Boxing Day (substitute)'),
  H('UK', '2027-01-01', "New Year's Day"),
  H('UK', '2027-03-26', 'Good Friday'),
  H('UK', '2027-03-29', 'Easter Monday'),
  H('UK', '2027-05-03', 'Early May Bank Holiday'),
  H('UK', '2027-05-31', 'Spring Bank Holiday'),
  H('UK', '2027-08-30', 'Summer Bank Holiday'),
  H('UK', '2027-12-27', 'Christmas Day (substitute)'),
  H('UK', '2027-12-28', 'Boxing Day (substitute)'),
  // ---- USA (federal) ----
  H('USA', '2026-01-01', "New Year's Day"),
  H('USA', '2026-01-19', 'Martin Luther King Jr. Day'),
  H('USA', '2026-02-16', "Presidents' Day"),
  H('USA', '2026-05-25', 'Memorial Day'),
  H('USA', '2026-06-19', 'Juneteenth'),
  H('USA', '2026-07-03', 'Independence Day (observed)'),
  H('USA', '2026-09-07', 'Labor Day'),
  H('USA', '2026-10-12', 'Columbus Day'),
  H('USA', '2026-11-11', 'Veterans Day'),
  H('USA', '2026-11-26', 'Thanksgiving'),
  H('USA', '2026-12-25', 'Christmas Day'),
  H('USA', '2027-01-01', "New Year's Day"),
  H('USA', '2027-01-18', 'Martin Luther King Jr. Day'),
  H('USA', '2027-02-15', "Presidents' Day"),
  H('USA', '2027-05-31', 'Memorial Day'),
  H('USA', '2027-06-18', 'Juneteenth (observed)'),
  H('USA', '2027-07-05', 'Independence Day (observed)'),
  H('USA', '2027-09-06', 'Labor Day'),
  H('USA', '2027-10-11', 'Columbus Day'),
  H('USA', '2027-11-11', 'Veterans Day'),
  H('USA', '2027-11-25', 'Thanksgiving'),
  H('USA', '2027-12-24', 'Christmas Day (observed)'),
  H('USA', '2027-12-31', "New Year's Day 2028 (observed)"),
  // ---- Canada (federal / most provinces) ----
  H('Canada', '2026-01-01', "New Year's Day"),
  H('Canada', '2026-04-03', 'Good Friday'),
  H('Canada', '2026-05-18', 'Victoria Day'),
  H('Canada', '2026-07-01', 'Canada Day'),
  H('Canada', '2026-08-03', 'Civic Holiday'),
  H('Canada', '2026-09-07', 'Labour Day'),
  H('Canada', '2026-09-30', 'Truth and Reconciliation Day'),
  H('Canada', '2026-10-12', 'Thanksgiving'),
  H('Canada', '2026-11-11', 'Remembrance Day'),
  H('Canada', '2026-12-25', 'Christmas Day'),
  H('Canada', '2026-12-28', 'Boxing Day (in lieu)'),
  H('Canada', '2027-01-01', "New Year's Day"),
  H('Canada', '2027-03-26', 'Good Friday'),
  H('Canada', '2027-05-24', 'Victoria Day'),
  H('Canada', '2027-07-01', 'Canada Day'),
  H('Canada', '2027-08-02', 'Civic Holiday'),
  H('Canada', '2027-09-06', 'Labour Day'),
  H('Canada', '2027-09-30', 'Truth and Reconciliation Day'),
  H('Canada', '2027-10-11', 'Thanksgiving'),
  H('Canada', '2027-11-11', 'Remembrance Day'),
  H('Canada', '2027-12-27', 'Christmas Day (in lieu)'),
  H('Canada', '2027-12-28', 'Boxing Day (in lieu)'),
  // ---- China (statutory; golden-week arrangements move — verify locally) ----
  H('China', '2026-01-01', "New Year's Day"),
  H('China', '2026-02-16', 'Spring Festival', '2026-02-22'),
  H('China', '2026-04-04', 'Qingming Festival', '2026-04-06'),
  H('China', '2026-05-01', 'Labour Day', '2026-05-05'),
  H('China', '2026-06-19', 'Dragon Boat Festival'),
  H('China', '2026-09-25', 'Mid-Autumn Festival'),
  H('China', '2026-10-01', 'National Day', '2026-10-07'),
  H('China', '2027-01-01', "New Year's Day"),
  H('China', '2027-02-05', 'Spring Festival', '2027-02-11'),
  H('China', '2027-04-03', 'Qingming Festival', '2027-04-05'),
  H('China', '2027-05-01', 'Labour Day', '2027-05-05'),
  H('China', '2027-06-09', 'Dragon Boat Festival'),
  H('China', '2027-09-15', 'Mid-Autumn Festival'),
  H('China', '2027-10-01', 'National Day', '2027-10-07'),
  // ---- India (national; festival dates move — verify locally) ----
  H('India', '2026-01-26', 'Republic Day'),
  H('India', '2026-03-04', 'Holi'),
  H('India', '2026-08-15', 'Independence Day'),
  H('India', '2026-10-02', 'Gandhi Jayanti'),
  H('India', '2026-10-20', 'Dussehra'),
  H('India', '2026-11-08', 'Diwali', '2026-11-09'),
  H('India', '2027-01-26', 'Republic Day'),
  H('India', '2027-03-22', 'Holi'),
  H('India', '2027-08-15', 'Independence Day'),
  H('India', '2027-10-02', 'Gandhi Jayanti'),
  H('India', '2027-10-09', 'Dussehra'),
  H('India', '2027-10-29', 'Diwali'),
];
