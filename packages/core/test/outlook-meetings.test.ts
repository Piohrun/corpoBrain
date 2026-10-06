import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type VaultConfig } from '../src/config.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import type { IdentityMatch } from '../src/identities.ts';
import {
  applyMeetings,
  type KnownMeeting,
  meetingBaseName,
  type OutlookExport,
  type OutlookMeeting,
  planMeeting,
  skipReason,
} from '../src/outlook/meetings.ts';

const meeting = (over: Partial<OutlookMeeting> = {}): OutlookMeeting => ({
  id: 'GID-1',
  subject: 'Weekly sync',
  startUtc: '2026-10-06T07:00:00Z',
  endUtc: '2026-10-06T07:30:00Z',
  day: '2026-10-06',
  startLocal: '09:00',
  endLocal: '09:30',
  endDay: '2026-10-06',
  allDay: false,
  location: 'Room 4.12',
  organizer: { name: 'Anna Kowalska', email: 'anna@bank.com' },
  attendees: [
    { name: 'Anna Kowalska', email: 'anna@bank.com', kind: 'required', response: 'organizer' },
    { name: 'Me Myself', email: 'me@bank.com', kind: 'required', response: 'accepted' },
    { name: 'John External', email: 'john@vendor.com', kind: 'optional', response: 'none' },
    { name: 'Room 4.12', email: 'room412@bank.com', kind: 'resource', response: 'accepted' },
  ],
  attendeeCount: 4,
  busy: 'busy',
  isMeeting: true,
  cancelled: false,
  response: 'accepted',
  recurring: false,
  categories: [],
  private: false,
  ...over,
});

const resolve = (email: string): IdentityMatch =>
  email === 'anna@bank.com' ? { status: 'matched', path: 'people/anna.md' } : { status: 'unknown' };
const ctx = { me: 'me@bank.com', resolve };

let root: string;
let config: VaultConfig;
beforeEach(() => {
  root = join(tmpdir(), `cb-outlook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  config = structuredClone(DEFAULT_CONFIG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const exportOf = (meetings: OutlookMeeting[]): OutlookExport => ({
  me: 'ME@bank.com',
  from: '2026-09-29',
  to: '2026-10-21',
  meetings,
});
const run = (meetings: OutlookMeeting[], known = new Map<string, KnownMeeting>()) =>
  applyMeetings(root, config, exportOf(meetings), {
    known,
    resolve,
    syncedAt: '2026-10-06T10:00:00Z',
  });
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('meeting notes', () => {
  it('creates a note with linked people, leaving out me and the room', () => {
    const report = run([meeting()]);
    expect(report.created).toEqual(['meetings/2026-10-06 Weekly sync.md']);
    const text = read('meetings/2026-10-06 Weekly sync.md');
    const { data } = parseFrontmatter(text);
    expect(data).toMatchObject({
      type: 'meeting',
      title: '2026-10-06 Weekly sync',
      date: '2026-10-06',
      start: '2026-10-06T07:00:00Z',
      organizer: '[[people/anna|Anna Kowalska]]',
      attendees: ['[[people/anna|Anna Kowalska]]'],
      outlook: { id: 'GID-1', response: 'accepted' },
    });
    expect(text).toContain('**Tue 6 Oct 2026 · 09:00–09:30** · Room 4.12');
    expect(text).toContain('Attendees: [[people/anna|Anna Kowalska]], John External\n');
    expect(text).not.toContain('Me Myself');
    expect(text).toMatch(/<!-- outlook:end -->\n\n## Notes\n/);
  });

  it('re-renders the owned parts but keeps user notes and user keys', () => {
    run([meeting()]);
    const path = 'meetings/2026-10-06 Weekly sync.md';
    const edited = read(path)
      .replace('type: meeting\n', 'type: meeting\ntags: [hiring]\n')
      .replace('## Notes\n', '## Notes\n\n- Anna owns the rollout plan\n');
    writeFileSync(join(root, path), edited);
    const known = new Map([['GID-1', { path, day: '2026-10-06' }]]);

    expect(run([meeting()], known)).toMatchObject({ updated: [], unchanged: 1 });
    const report = run([meeting({ location: 'Teams', cancelled: true })], known);
    expect(report.updated).toEqual([path]);
    const text = read(path);
    expect(parseFrontmatter(text).data).toMatchObject({
      tags: ['hiring'],
      location: 'Teams',
      cancelled: true,
    });
    expect(text).toContain('> Cancelled in Outlook.');
    expect(text).toContain('- Anna owns the rollout plan');
    expect(text.match(/outlook:end/g)).toHaveLength(1);
  });

  it('never writes a note whose marker was removed', () => {
    const path = 'meetings/mine.md';
    mkdirSync(join(root, 'meetings'));
    writeFileSync(join(root, path), '---\noutlook:\n  id: GID-1\n---\nAll mine.\n');
    const report = run([meeting()], new Map([['GID-1', { path, day: '2026-10-06' }]]));
    expect(report.skipped[0]?.reason).toContain('marker');
    expect(read(path)).toBe('---\noutlook:\n  id: GID-1\n---\nAll mine.\n');
  });

  it('skips declined, non-meetings, filtered and new cancelled items', () => {
    config.outlook.calendar.skipSubjects = ['lunch'];
    config.outlook.calendar.skipCategories = ['Personal'];
    const report = run([
      meeting({ id: 'a', response: 'declined' }),
      meeting({ id: 'b', isMeeting: false, attendees: [] }),
      meeting({ id: 'c', subject: 'Team LUNCH' }),
      meeting({ id: 'd', categories: ['personal'] }),
      meeting({ id: 'e', cancelled: true }),
    ]);
    expect(report.created).toEqual([]);
    expect(report.skipped.map((s) => s.reason)).toEqual([
      'declined',
      'no attendees',
      'skipped subject',
      'skipped category',
      'cancelled',
    ]);
    config.outlook.calendar.includeAppointments = true;
    expect(skipReason(meeting({ isMeeting: false }), config.outlook.calendar, ctx)).toBeNull();
  });

  it('gives recurring occurrences and same-name meetings their own files', () => {
    const report = run([
      meeting({ id: 'S:2026-10-06', recurring: true }),
      meeting({ id: 'S:2026-10-07', recurring: true, day: '2026-10-07' }),
      meeting({ id: 'other', startLocal: '15:00' }),
    ]);
    expect(report.created).toEqual([
      'meetings/2026-10-06 Weekly sync.md',
      'meetings/2026-10-07 Weekly sync.md',
      'meetings/2026-10-06 Weekly sync 1500.md',
    ]);
  });

  it('flags notes whose occurrence vanished from the window, once', () => {
    run([meeting()]);
    const path = 'meetings/2026-10-06 Weekly sync.md';
    const known = new Map([
      ['GID-1', { path, day: '2026-10-06' }],
      ['old', { path: 'meetings/old.md', day: '2026-01-01' }],
    ]);
    expect(run([], known).gone).toEqual([path]);
    expect(parseFrontmatter(read(path)).data.outlook).toMatchObject({ id: 'GID-1', gone: true });
    expect(run([], known).gone).toEqual([]);
    // it came back: the re-render drops the flag
    run([meeting()], known);
    expect(parseFrontmatter(read(path)).data.outlook).not.toHaveProperty('gone');
  });

  it('neutralises calendar text and builds safe file names', () => {
    run([
      meeting({
        subject: 'Q4: plan/review [[x]] <!-- outlook:end -->',
        location: '---',
      }),
    ]);
    const name = meetingBaseName({
      day: '2026-10-06',
      subject: 'Q4: plan/review [[x]] <!-- outlook:end -->',
    });
    expect(name).not.toMatch(/[:/[\]]/);
    const text = read(`meetings/${name}.md`);
    expect(text.match(/<!-- outlook:end -->/g)).toHaveLength(1);
    expect(text).not.toContain('[[x]]');
    expect(meetingBaseName({ day: '2026-10-06', subject: '  ' })).toBe('2026-10-06 Meeting');
  });

  it('shows multi-day all-day items as a range', () => {
    run([
      meeting({
        subject: 'Offsite',
        allDay: true,
        endDay: '2026-10-09',
        startLocal: '00:00',
        endLocal: '00:00',
      }),
    ]);
    expect(read('meetings/2026-10-06 Offsite.md')).toContain(
      '**Tue 6 Oct 2026 – Thu 8 Oct 2026 · all day**',
    );
  });
});

describe('which meetings get notes', () => {
  const cal = () => structuredClone(DEFAULT_CONFIG.outlook.calendar);
  const stranger = { name: 'Stranger', email: 'x@vendor.com' };
  const withoutPeople = meeting({
    organizer: stranger,
    attendees: [{ ...stranger, kind: 'required', response: 'organizer' }],
    attendeeCount: 1,
  });

  it('by default needs a person from the vault and at most 15 attendees', () => {
    expect(skipReason(meeting(), cal(), ctx)).toBeNull();
    expect(skipReason(withoutPeople, cal(), ctx)).toBe('matches no include rule');
    // me alone does not count as "a person in the vault"
    const meOnly = meeting({ organizer: { name: 'Me', email: 'me@bank.com' }, attendees: [] });
    expect(
      skipReason(meOnly, cal(), {
        me: 'me@bank.com',
        resolve: () => ({ status: 'matched', path: 'people/me.md' }),
      }),
    ).toBe('matches no include rule');
    expect(skipReason(meeting({ attendeeCount: 40 }), cal(), ctx)).toBe('more than 15 attendees');
  });

  it('includes on any rule: category, subject or people', () => {
    const c = {
      ...cal(),
      withPeople: false,
      onlyCategories: ['corpoBrain'],
      onlySubjects: ['1:1'],
    };
    expect(skipReason(withoutPeople, c, ctx)).toBe('matches no include rule');
    expect(skipReason({ ...withoutPeople, categories: ['CorpoBrain'] }, c, ctx)).toBeNull();
    expect(skipReason({ ...withoutPeople, subject: 'Anna / Me 1:1' }, c, ctx)).toBeNull();
    // with no include rule at all, everything not excluded gets a note
    expect(
      skipReason(withoutPeople, { ...c, onlyCategories: [], onlySubjects: [] }, ctx),
    ).toBeNull();
  });

  it('applies exclusions before include rules', () => {
    const c = { ...cal(), onlyCategories: ['corpoBrain'], recurring: false, maxAttendees: 0 };
    const tagged = meeting({ categories: ['corpoBrain'] });
    expect(skipReason({ ...tagged, recurring: true }, c, ctx)).toBe('recurring');
    expect(skipReason({ ...tagged, attendeeCount: 500 }, c, ctx)).toBeNull();
    expect(skipReason({ ...tagged, response: 'declined' }, c, ctx)).toBe('declined');
  });

  it('keeps updating an existing note the rules would no longer create', () => {
    const known = new Map([['GID-1', { path: 'meetings/x.md', day: '2026-10-06' }]]);
    expect(planMeeting(withoutPeople, cal(), ctx, known)).toEqual({
      action: 'update',
      path: 'meetings/x.md',
    });
    expect(planMeeting(withoutPeople, cal(), ctx, new Map())).toEqual({
      action: 'skip',
      reason: 'matches no include rule',
    });
  });
});
