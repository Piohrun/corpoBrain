/** Reading and writing the availability table, and resolving it to people. */
import {
  type Absence,
  type AvailabilityEntry,
  absencesBySprint,
  BUILTIN_HOLIDAYS,
  type HolidayEntry,
  normalizeCountry,
  parseAvailability,
  parseHolidays,
  replaceAvailabilityTable,
  replaceHolidaysTable,
  type SprintSpan,
} from '@corpobrain/core';
import type { VaultService } from './vault-service.ts';

export interface PersonRef {
  path: string;
  name: string;
  jiraIds: string[];
  country?: string | null;
}

export interface ResolvedAvailability {
  entries: AvailabilityEntry[];
  warnings: string[];
  /** person note path → sprint name → absence */
  byPerson: Map<string, Map<string, Absence>>;
}

const norm = (s: string): string => s.trim().toLowerCase();
const basename = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '');

/** Match a table cell to a person note: title, path, file name or Jira id. */
export function resolvePerson(raw: string, people: PersonRef[]): PersonRef | null {
  const n = norm(raw);
  return (
    people.find((p) => norm(p.name) === n) ??
    people.find((p) => norm(p.path) === n) ??
    people.find((p) => norm(basename(p.path)) === n) ??
    people.find((p) => p.jiraIds.some((id) => norm(id) === n)) ??
    null
  );
}

export function readAvailability(v: VaultService): {
  entries: AvailabilityEntry[];
  warnings: string[];
  content: string | null;
} {
  try {
    const { content } = v.read(v.config.availability.file);
    const { entries, warnings } = parseAvailability(content);
    return { entries, warnings, content };
  } catch {
    return { entries: [], warnings: [], content: null }; // no note yet
  }
}

/** Absences per person note, ready to reduce bandwidth. */
export function resolveAvailability(
  v: VaultService,
  sprints: SprintSpan[],
  people: PersonRef[],
): ResolvedAvailability {
  const { entries, warnings } = readAvailability(v);
  const resolved: AvailabilityEntry[] = [];
  const byName = new Map<string, string>(); // table name → person path
  for (const e of entries) {
    const person = resolvePerson(e.person, people);
    if (!person) {
      if (!warnings.some((w) => w.includes(e.person)))
        warnings.push(`"${e.person}" does not match a person note — that absence is ignored`);
      continue;
    }
    byName.set(e.person, person.path);
    resolved.push({ ...e, person: person.path });
  }
  // country-wide bank holidays become synthetic entries for everyone there
  for (const h of readHolidays(v).entries) {
    const c = normalizeCountry(h.country);
    for (const p of people) {
      if (!p.country || normalizeCountry(p.country) !== c) continue;
      resolved.push({ person: p.path, from: h.from, to: h.to, kind: 'holiday', note: h.name });
    }
  }
  return {
    entries,
    warnings,
    byPerson: absencesBySprint(resolved, sprints, v.config.availability.supportFactor),
  };
}

export function readHolidays(v: VaultService): {
  entries: HolidayEntry[];
  warnings: string[];
  content: string | null;
} {
  try {
    const { content } = v.read(v.config.availability.holidaysFile);
    const { entries, warnings } = parseHolidays(content);
    return { entries, warnings, content };
  } catch {
    return { entries: [], warnings: [], content: null };
  }
}

const HOLIDAYS_SCAFFOLD = `---
type: holidays
title: Bank holidays
---

# Bank holidays

Country-wide holidays; everyone whose person note has that 'country:' is
automatically away on these days. Dates are inclusive. Edit here or in the
Availability page — both write this table.

`;

/** Write the holiday table back, creating the note if it does not exist yet. */
export function saveHolidays(v: VaultService, entries: HolidayEntry[]): string {
  const file = v.config.availability.holidaysFile;
  const existing = readHolidays(v);
  if (existing.content === null) {
    v.create(
      file,
      'Bank holidays',
      `${HOLIDAYS_SCAFFOLD}${replaceHolidaysTable('', entries).trim()}\n`,
      'holidays',
    );
    return file;
  }
  v.write(file, replaceHolidaysTable(existing.content, entries));
  return file;
}

/** Merge the built-in 2026–27 dataset into the table, never duplicating. */
export function seedHolidays(v: VaultService): { added: number; file: string } {
  const existing = readHolidays(v).entries;
  const key = (h: HolidayEntry) => `${normalizeCountry(h.country)}|${h.from}|${h.to}`;
  const seen = new Set(existing.map(key));
  const fresh = BUILTIN_HOLIDAYS.filter((h) => !seen.has(key(h)));
  const file = saveHolidays(v, [...existing, ...fresh]);
  return { added: fresh.length, file };
}

/** Write the table back, creating the note if it does not exist yet. */
export function saveAvailability(v: VaultService, entries: AvailabilityEntry[]): string {
  const file = v.config.availability.file;
  const existing = readAvailability(v);
  if (existing.content === null) {
    v.create(
      file,
      'Availability',
      `---\ntype: availability\ntitle: Availability\n---\n\n# Availability\n\nOut-of-office and support rota. Dates are inclusive; \`Type\` is \`ooo\` or \`support\`.\nEdit here or in Planning → Availability — both write this table.\n\n${replaceAvailabilityTable('', entries).trim()}\n`,
      'availability',
    );
    return file;
  }
  v.write(file, replaceAvailabilityTable(existing.content, entries));
  return file;
}

/**
 * Move entries that ended more than `months` ago into per-year archive notes
 * (`availability-2025.md` beside the main note), keeping the working table
 * short without losing history — it all stays in the vault and in git.
 */
export function archiveAvailability(
  v: VaultService,
  months = 3,
): { archived: number; files: string[] } {
  const existing = readAvailability(v);
  if (existing.content === null) return { archived: 0, files: [] };
  const cutoffDate = new Date();
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - months);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const old = existing.entries.filter((e) => e.to < cutoff);
  if (!old.length) return { archived: 0, files: [] };
  const keep = existing.entries.filter((e) => e.to >= cutoff);

  const byYear = new Map<string, AvailabilityEntry[]>();
  for (const e of old) {
    const y = e.to.slice(0, 4);
    const list = byYear.get(y) ?? [];
    list.push(e);
    byYear.set(y, list);
  }
  const files: string[] = [];
  const dedupeKey = (e: AvailabilityEntry) => `${e.person}|${e.from}|${e.to}|${e.kind}|${e.note}`;
  for (const [year, entries] of byYear) {
    const file = v.config.availability.file.replace(/\.md$/i, `-${year}.md`);
    let content: string | null = null;
    try {
      content = v.read(file).content;
    } catch {
      content = null;
    }
    if (content === null) {
      v.create(
        file,
        `Availability ${year}`,
        `---\ntype: availability-archive\ntitle: "Availability ${year}"\n---\n\n# Availability ${year}\n\nArchived out-of-office and support entries. The planner does not read this\nnote; it exists for history.\n\n${replaceAvailabilityTable('', entries).trim()}\n`,
        'availability-archive',
      );
    } else {
      const seen = new Set<string>();
      const merged = [...parseAvailability(content).entries, ...entries].filter((e) => {
        const k = dedupeKey(e);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      v.write(file, replaceAvailabilityTable(content, merged));
    }
    files.push(file);
  }
  v.write(v.config.availability.file, replaceAvailabilityTable(existing.content, keep));
  return { archived: old.length, files };
}
