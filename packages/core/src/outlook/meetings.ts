/**
 * Outlook meeting notes (SPEC §6.4): one note per calendar occurrence, with a
 * tool-owned region above `<!-- outlook:end -->` and the user's notes below.
 * Pure rendering and merging; the server feeds it the exporter's output.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VaultConfig } from '../config.ts';
import { parseFrontmatter, patchFrontmatter, splitFrontmatter } from '../frontmatter.ts';
import type { IdentityMatch } from '../identities.ts';
import { writeFileAtomic } from '../vault.ts';

export const OUTLOOK_MARKER = '<!-- outlook:end -->';

export interface OutlookPerson {
  name: string;
  email: string | null;
}

export interface OutlookAttendee extends OutlookPerson {
  kind: 'required' | 'optional' | 'resource' | 'group';
  response: 'organizer' | 'accepted' | 'tentative' | 'declined' | 'none' | null;
}

/** One calendar occurrence as the exporter (python/outlook_export.py) emits it. */
export interface OutlookMeeting {
  /** stable per occurrence: global appointment id, plus the day for recurring series */
  id: string;
  subject: string;
  startUtc: string;
  endUtc: string;
  /** local calendar day the occurrence starts on */
  day: string;
  startLocal: string;
  endLocal: string;
  endDay: string;
  allDay: boolean;
  location: string | null;
  organizer: OutlookPerson | null;
  attendees: OutlookAttendee[];
  attendeeCount: number;
  busy: 'free' | 'tentative' | 'busy' | 'oof' | 'elsewhere';
  isMeeting: boolean;
  cancelled: boolean;
  response: 'organizer' | 'accepted' | 'tentative' | 'declined' | 'none' | null;
  recurring: boolean;
  categories: string[];
  private: boolean;
}

export interface OutlookExport {
  /** the mailbox owner's address, left out of attendee lists */
  me: string | null;
  /** inclusive first day and exclusive last day of the exported window */
  from: string;
  to: string;
  meetings: OutlookMeeting[];
}

export interface MeetingsReport {
  profile: string;
  fetched: number;
  created: string[];
  updated: string[];
  unchanged: number;
  skipped: { id: string; reason: string }[];
  /** notes whose occurrence is no longer in Outlook (deleted, declined, rescheduled) */
  gone: string[];
  warnings: string[];
}

/** An existing meeting note, found through its `outlook.id`. */
export interface KnownMeeting {
  path: string;
  day: string | null;
}

/** Why an occurrence does not get a note, or null when it does. */
export function skipReason(m: OutlookMeeting, cfg: VaultConfig['outlook']): string | null {
  if (m.response === 'declined') return 'declined';
  if (!m.isMeeting && !cfg.includeAppointments) return 'not a meeting';
  const skipCats = new Set(cfg.skipCategories.map((c) => c.toLowerCase()));
  if (m.categories.some((c) => skipCats.has(c.toLowerCase()))) return 'skipped category';
  const subject = m.subject.toLowerCase();
  if (cfg.skipSubjects.some((s) => s.trim() && subject.includes(s.trim().toLowerCase())))
    return 'skipped subject';
  return null;
}

/** Escape anything in untrusted calendar text that this spec would interpret. */
export function neutralizeOutlook(text: string): string {
  return text
    .replace(/<!--\s*outlook:end\s*-->/g, '<!-- outlook:end (escaped) -->')
    .replace(/^---[ \t]*$/gm, '\\---')
    .replace(/\[\[|\]\]/g, (b) => (b === '[[' ? '[​[' : ']​]'));
}

const oneLine = (s: string) => neutralizeOutlook(s.replace(/\s+/g, ' ').trim());

/** A file-system-safe note name: `2026-10-06 Weekly sync`. */
export function meetingBaseName(m: Pick<OutlookMeeting, 'day' | 'subject'>): string {
  const subject =
    m.subject
      .replace(/[\\/:*?"<>|#^[\]{}\p{Cc}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80)
      .trim() || 'Meeting';
  return `${m.day} ${subject}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function longDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export type PersonResolver = (email: string) => IdentityMatch;

interface Rendered {
  frontmatter: Record<string, unknown>;
  body: string;
}

function renderMeeting(
  m: OutlookMeeting,
  opts: { me: string | null; resolve: PersonResolver; syncedAt: string },
): Rendered {
  const link = (p: OutlookPerson): { text: string; link: string | null } => {
    const match = p.email ? opts.resolve(p.email) : { status: 'unknown' as const };
    const name = oneLine(p.name || p.email || 'Unknown');
    if (match.status !== 'matched') return { text: name, link: null };
    const target = match.path.replace(/\.md$/, '');
    const wikilink = `[[${target}|${name.replace(/\|/g, '/')}]]`;
    return { text: wikilink, link: wikilink };
  };
  const me = opts.me?.toLowerCase() ?? null;
  const organizer = m.organizer ? link(m.organizer) : null;
  const others = m.attendees.filter((a) => !me || a.email?.toLowerCase() !== me);
  const people = others.filter((a) => a.kind !== 'resource').map(link);
  const linked = [...new Set([organizer?.link, ...people.map((p) => p.link)].filter(Boolean))];

  const frontmatter: Record<string, unknown> = {
    type: 'meeting',
    title: meetingBaseName(m),
    date: m.day,
    start: m.startUtc,
    end: m.endUtc,
    all_day: m.allDay || undefined,
    location: m.location ? oneLine(m.location) : undefined,
    organizer: organizer ? (organizer.link ?? organizer.text) : undefined,
    attendees: linked.length ? linked : undefined,
    cancelled: m.cancelled || undefined,
    outlook: {
      id: m.id,
      synced: opts.syncedAt,
      ...(m.recurring ? { recurring: true } : {}),
      ...(m.response ? { response: m.response } : {}),
      ...(m.busy !== 'busy' ? { busy: m.busy } : {}),
      ...(m.private ? { private: true } : {}),
      ...(m.categories.length ? { categories: m.categories.map(oneLine) } : {}),
    },
  };

  const lastDay = m.allDay ? previousDay(m.endDay) : m.endDay;
  const when = m.allDay
    ? lastDay > m.day
      ? `${longDay(m.day)} – ${longDay(lastDay)} · all day`
      : `${longDay(m.day)} · all day`
    : `${longDay(m.day)} · ${m.startLocal}–${m.endLocal}`;
  const lines = [`# ${oneLine(m.subject) || 'Meeting'}`, ''];
  lines.push(`**${when}**${m.location ? ` · ${oneLine(m.location)}` : ''}`);
  if (m.cancelled) lines.push('', '> Cancelled in Outlook.');
  if (organizer) lines.push('', `Organizer: ${organizer.text}`);
  if (people.length) {
    const shown = people.slice(0, 40).map((p) => p.text);
    const excluded = m.attendees.length - people.length; // me and rooms
    const more = Math.max(0, m.attendeeCount - excluded - shown.length);
    lines.push(`Attendees: ${shown.join(', ')}${more ? `, +${more} more` : ''}`);
  }
  return { frontmatter, body: `${lines.join('\n')}\n` };
}

/** Frontmatter keys this tool owns on a meeting note; any other key is the user's. */
const OWNED_KEYS = [
  'type',
  'title',
  'date',
  'start',
  'end',
  'all_day',
  'location',
  'organizer',
  'attendees',
  'cancelled',
  'outlook',
];

const NEW_USER_REGION = '\n## Notes\n\n';

function newFile(r: Rendered): string {
  const fm = patchFrontmatter('', r.frontmatter);
  return `${fm}\n${r.body}\n${OUTLOOK_MARKER}\n${NEW_USER_REGION}`;
}

type Merge = { kind: 'write'; text: string } | { kind: 'skip'; reason: string };

/** Re-render the owned frontmatter keys and region; keep everything else. */
export function mergeMeetingFile(existing: string, r: Rendered): Merge {
  const normalized = existing.replace(/\r\n/g, '\n');
  if (parseFrontmatter(normalized).error) return { kind: 'skip', reason: 'unreadable frontmatter' };
  const markerAt = normalized.indexOf(`\n${OUTLOOK_MARKER}`);
  if (markerAt === -1) return { kind: 'skip', reason: `no ${OUTLOOK_MARKER} marker` };
  const userRegion = normalized.slice(markerAt + OUTLOOK_MARKER.length + 1);
  const patch: Record<string, unknown> = {};
  for (const key of OWNED_KEYS) patch[key] = r.frontmatter[key];
  const head = patchFrontmatter(normalized.slice(0, markerAt), patch);
  const split = splitFrontmatter(head);
  const fm = head.slice(0, split.bodyOffset);
  return { kind: 'write', text: `${fm}\n${r.body}\n${OUTLOOK_MARKER}${userRegion}` };
}

/**
 * Write meeting notes for an export. `known` maps outlook ids to existing
 * notes (wherever the user moved them); new notes go to `cfg.outlook.folder`.
 */
export function applyMeetings(
  root: string,
  config: VaultConfig,
  data: OutlookExport,
  opts: {
    known: Map<string, KnownMeeting>;
    resolve: PersonResolver;
    syncedAt: string;
    profile?: string;
  },
): MeetingsReport {
  const report: MeetingsReport = {
    profile: opts.profile ?? 'calendar',
    fetched: data.meetings.length,
    created: [],
    updated: [],
    unchanged: 0,
    skipped: [],
    gone: [],
    warnings: [],
  };
  const seen = new Set<string>();
  const taken = new Set<string>();
  for (const m of data.meetings) {
    seen.add(m.id);
    const known = opts.known.get(m.id);
    const reason = skipReason(m, config.outlook);
    // An existing note is kept current even if it would no longer be created
    // (e.g. declined later): the user may have written in it.
    if (reason && !known) {
      report.skipped.push({ id: m.id, reason });
      continue;
    }
    if (m.cancelled && !known) {
      report.skipped.push({ id: m.id, reason: 'cancelled' });
      continue;
    }
    const rendered = renderMeeting(m, {
      me: data.me,
      resolve: opts.resolve,
      syncedAt: opts.syncedAt,
    });
    if (known) {
      const abs = join(root, known.path);
      if (!existsSync(abs)) {
        report.warnings.push(`${known.path}: indexed but missing on disk`);
        continue;
      }
      const existing = readFileSync(abs, 'utf8');
      const merged = mergeMeetingFile(existing, rendered);
      if (merged.kind === 'skip') {
        report.skipped.push({ id: m.id, reason: `${known.path}: ${merged.reason}` });
        report.warnings.push(`${known.path}: ${merged.reason}; left untouched`);
        continue;
      }
      // Only the sync timestamp changed: leave the file (and git) alone.
      if (sameIgnoringSynced(existing, merged.text)) report.unchanged++;
      else {
        writeFileAtomic(abs, merged.text);
        report.updated.push(known.path);
      }
      continue;
    }
    const path = freePath(root, config.outlook.folder, meetingBaseName(m), m.startLocal, taken);
    taken.add(path);
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileAtomic(abs, newFile(rendered));
    report.created.push(path);
  }
  for (const [id, known] of opts.known) {
    if (seen.has(id) || !known.day || known.day < data.from || known.day >= data.to) continue;
    const abs = join(root, known.path);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const outlook = parseFrontmatter(text).data.outlook;
    if (!outlook || typeof outlook !== 'object' || (outlook as { gone?: unknown }).gone) continue;
    writeFileAtomic(abs, patchFrontmatter(text, { outlook: { ...outlook, gone: true } }));
    report.gone.push(known.path);
  }
  return report;
}

function sameIgnoringSynced(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/\r\n/g, '\n').replace(/^ {2}synced: .*$/m, '');
  return strip(a) === strip(b);
}

function freePath(
  root: string,
  folder: string,
  base: string,
  time: string,
  taken: Set<string>,
): string {
  const candidates = [base, `${base} ${time.replace(':', '')}`];
  for (let i = 2; i < 100; i++) candidates.push(`${base} (${i})`);
  for (const name of candidates) {
    const path = `${folder}/${name}.md`;
    if (!taken.has(path) && !existsSync(join(root, path))) return path;
  }
  throw new Error(`no free file name for ${base}`);
}

/** Outlook ids of existing meeting notes, from their parsed frontmatter. */
export function knownMeetingOf(
  path: string,
  fm: Record<string, unknown>,
): [string, KnownMeeting] | null {
  const outlook = fm.outlook as { id?: unknown } | undefined;
  if (!outlook || typeof outlook.id !== 'string') return null;
  return [outlook.id, { path, day: typeof fm.date === 'string' ? fm.date : null }];
}
