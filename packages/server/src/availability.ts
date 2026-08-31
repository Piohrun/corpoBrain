/** Reading and writing the availability table, and resolving it to people. */
import {
  type Absence,
  type AvailabilityEntry,
  absencesBySprint,
  parseAvailability,
  replaceAvailabilityTable,
  type SprintSpan,
} from '@corpobrain/core';
import type { VaultService } from './vault-service.ts';

export interface PersonRef {
  path: string;
  name: string;
  jiraIds: string[];
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
  return {
    entries,
    warnings,
    byPerson: absencesBySprint(resolved, sprints, v.config.availability.supportFactor),
  };
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
