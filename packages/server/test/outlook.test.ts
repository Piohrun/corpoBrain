import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutlookMeeting } from '@corpobrain/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import {
  type ExportRequest,
  type ExportResult,
  OutlookSyncService,
  pythonExporter,
  resolvePython,
} from '../src/outlook-sync-service.ts';
import { VaultService } from '../src/vault-service.ts';

const python = ['python3', 'python'].find((cmd) => {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
const fakeComtypes = join(import.meta.dirname, 'fixtures', 'fake-comtypes');

let root: string;
let vault: VaultService;
beforeEach(() => {
  root = join(tmpdir(), `cb-outlook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'people'), { recursive: true });
  writeFileSync(
    join(root, 'people', 'anna.md'),
    '---\ntype: person\ntitle: Anna Kowalska\nemail: anna@bank.com\n---\n',
  );
  vault = new VaultService(root, ':memory:');
  vault.indexer.rebuild();
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const meeting = (subject: string, location = 'Room 4'): OutlookMeeting => ({
  id: 'R',
  subject,
  startUtc: '2026-10-06T12:00:00Z',
  endUtc: '2026-10-06T13:00:00Z',
  day: '2026-10-06',
  startLocal: '14:00',
  endLocal: '15:00',
  endDay: '2026-10-06',
  allDay: false,
  location,
  organizer: { name: 'Anna Kowalska', email: 'anna@bank.com' },
  attendees: [],
  attendeeCount: 1,
  busy: 'busy',
  isMeeting: true,
  cancelled: false,
  response: 'accepted',
  recurring: false,
  categories: [],
  private: false,
});

const result = (req: ExportRequest, meetings: OutlookMeeting[]): ExportResult => ({
  me: 'me@bank.com',
  outlookVersion: '16.0',
  filter: 'restrict',
  calendar: req.calendar ? { ...req.calendar, meetings, scanned: 1, truncated: false } : null,
  mail: req.mailSince
    ? {
        since: req.mailSince,
        complete: true,
        source: 'todo',
        mails: [
          {
            id: '<m1@bank>',
            subject: 'Budget sign-off',
            from: { name: 'Anna Kowalska', email: 'anna@bank.com' },
            received: `${req.mailSince}T09:00:00`,
            due: null,
            completed: false,
            flag: 'Follow up',
            importance: 'normal',
            categories: [],
            preview: '',
          },
        ],
      }
    : null,
});

describe('Outlook sync service', () => {
  it('writes notes, finds them again after the user moves them, and keeps history', async () => {
    let next = [meeting('Roadmap')];
    const service = new OutlookSyncService(vault, async (req) => result(req, next));
    const [first] = await service.start().completion;
    expect(first).toMatchObject({
      profile: 'calendar',
      created: ['meetings/2026-10-06 Roadmap.md'],
    });
    expect(
      vault.indexer.db
        .prepare("SELECT DISTINCT dst_path FROM links WHERE src_path = ? AND kind = 'property'")
        .all('meetings/2026-10-06 Roadmap.md'),
    ).toEqual([{ dst_path: 'people/anna.md' }]);

    // the user files the note elsewhere and writes in it
    mkdirSync(join(root, 'projects'));
    const moved = 'projects/roadmap meeting.md';
    renameSync(join(root, 'meetings/2026-10-06 Roadmap.md'), join(root, moved));
    writeFileSync(join(root, moved), `${readFileSync(join(root, moved), 'utf8')}My notes.\n`);
    vault.indexer.updatePaths(['meetings/2026-10-06 Roadmap.md', moved]);

    next = [meeting('Roadmap', 'Teams')];
    const [second] = await service.start().completion;
    expect(second).toMatchObject({ created: [], updated: [moved] });
    const text = readFileSync(join(root, moved), 'utf8');
    expect(text).toContain('location: Teams');
    expect(text).toContain('My notes.');
    expect(new OutlookSyncService(vault).history.map((r) => r.outcome)).toEqual([
      'success',
      'success',
    ]);
  });

  it('runs only the enabled sections, and turns flagged mail into indexed tasks', async () => {
    const requests: ExportRequest[] = [];
    const service = new OutlookSyncService(vault, async (req) => {
      requests.push(req);
      return result(req, []);
    });
    vault.config.outlook.calendar.enabled = false;
    expect(() => service.start()).toThrow('Turn on calendar or email sync first');
    vault.config.outlook.mail.enabled = true;
    vault.config.outlook.mail.daysBack = 10;
    const [report] = await service.start().completion;
    expect(requests[0]?.calendar).toBeUndefined();
    expect(requests[0]?.mailSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report).toMatchObject({ profile: 'mail', added: ['Budget sign-off'] });
    expect(vault.indexer.db.prepare('SELECT path, done FROM tasks').all()).toEqual([
      { path: 'notes/Email follow-ups.md', done: 0 },
    ]);
  });

  it('previews decisions without writing', async () => {
    vault.config.outlook.mail.enabled = true;
    const outsider = {
      ...meeting('Vendor pitch'),
      id: 'V',
      organizer: { name: 'X', email: 'x@v.com' },
    };
    const service = new OutlookSyncService(vault, async (req) =>
      result(req, [meeting('Roadmap'), outsider]),
    );
    const preview = await service.preview();
    expect(preview.meetings.map((m) => [m.subject, m.action, m.reason])).toEqual([
      ['Roadmap', 'create', null],
      ['Vendor pitch', 'skip', 'matches no include rule'],
    ]);
    expect(preview.mails).toMatchObject([{ subject: 'Budget sign-off', action: 'add' }]);
    expect(vault.indexer.db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 });
  });

  it('creates notes for meetings picked in the preview, whatever the rules say', async () => {
    const outsider = {
      ...meeting('Vendor pitch'),
      id: 'V',
      organizer: { name: 'X', email: 'x@v.com' },
    };
    let asked = 0;
    const service = new OutlookSyncService(vault, async (req) => {
      asked++;
      return result(req, [meeting('Roadmap'), outsider]);
    });
    expect(() => service.createMeetingNotes(['V'])).toThrow('run Preview again');
    await service.preview();
    const report = service.createMeetingNotes(['V']);
    expect(report.created).toEqual(['meetings/2026-10-06 Vendor pitch.md']);
    expect(asked).toBe(1); // Outlook is not asked again
    // indexed straight away, so the next preview sees it as an existing note
    const again = await service.preview();
    expect(again.meetings.map((m) => [m.subject, m.action, m.path])).toEqual([
      ['Roadmap', 'create', null],
      ['Vendor pitch', 'update', 'meetings/2026-10-06 Vendor pitch.md'],
    ]);
    expect(() => service.createMeetingNotes(['nope'])).toThrow('not in the last preview');
    expect(() => service.createMeetingNotes(['V'], Date.now() + 2 * 3600_000)).toThrow(
      'out of date',
    );
  });

  it("in 'pick' mode a sync creates no new notes and the preview marks suggestions", async () => {
    vault.config.outlook.calendar.newNotes = 'pick';
    const service = new OutlookSyncService(vault, async (req) => result(req, [meeting('Roadmap')]));
    const preview = await service.preview();
    expect(preview.meetings).toMatchObject([{ action: 'skip', suggested: true }]);
    const [report] = await service.start().completion;
    expect(report).toMatchObject({ created: [] });
  });

  it('records exporter failures in history', async () => {
    const service = new OutlookSyncService(vault, async () => {
      throw new Error('could not connect to Outlook: Server execution failed');
    });
    await expect(service.start().completion).rejects.toThrow('Server execution failed');
    expect(service.history[0]).toMatchObject({ outcome: 'failed', error: expect.any(String) });
  });

  it('uses the configured Python, else falls back to PATH when there is no .venv', () => {
    expect(resolvePython(' C:\\py\\python.exe ')).toEqual({
      python: 'C:\\py\\python.exe',
      source: 'configured',
    });
    expect(['venv', 'path']).toContain(resolvePython('').source);
  });
});

describe('Outlook settings API', () => {
  it('validates and persists nested settings, refusing non-Python programs', async () => {
    const app = createApp(vault);
    const put = (body: unknown) =>
      app.request('/api/outlook/config', { method: 'PUT', body: JSON.stringify(body) });
    const res = await put({
      python: '"C:\\Program Files\\Python312\\python.exe"',
      calendar: {
        daysAhead: 21,
        folder: '/meetings/2026/',
        onlyCategories: [' corpoBrain ', 'corpoBrain', ''],
        withPeople: false,
        maxAttendees: 8,
      },
      mail: { enabled: true, daysBack: 60, note: 'notes/Inbox tasks' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      python: 'C:\\Program Files\\Python312\\python.exe',
      pythonSource: 'configured',
      calendar: {
        enabled: true,
        daysBack: 7,
        daysAhead: 21,
        folder: 'meetings/2026',
        onlyCategories: ['corpoBrain'],
        withPeople: false,
        maxAttendees: 8,
      },
      mail: { enabled: true, daysBack: 60, note: 'notes/Inbox tasks.md' },
      exporterFound: true,
    });
    const onDisk = JSON.parse(readFileSync(join(root, '.corpobrain', 'config.json'), 'utf8'));
    expect(onDisk.outlook.calendar.daysAhead).toBe(21);
    expect(onDisk.outlook.mail.daysBack).toBe(60);
    for (const bad of [
      { python: 'C:\\Windows\\System32\\calc.exe' },
      { python: 'python; rm -rf /' },
      { calendar: { folder: '../outside' } },
      { calendar: { daysBack: 400 } },
      { mail: { note: 'private/tasks.md' } },
      { mail: { note: '.corpobrain/x.md' } },
      { mail: { daysBack: 0 } },
    ])
      expect((await put(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await put({ calendar: { newNotes: 'sometimes' } })).status).toBe(400);
    expect((await put({ calendar: { newNotes: 'pick' } })).status).toBe(200);
    expect(vault.config.outlook.calendar.newNotes).toBe('pick');
    const create = (body: unknown) =>
      app.request('/api/outlook/meetings/create', { method: 'POST', body: JSON.stringify(body) });
    expect((await create({ ids: [] })).status).toBe(400);
    expect((await create({ ids: [1] })).status).toBe(400);
    expect((await create({ ids: ['x'] })).status).toBe(409);
    expect((await put({ python: '' })).status).toBe(200);
    expect((await put({ python: 'py' })).status).toBe(200);
  });
});

describe.skipIf(!python)('outlook_export.py against a fake Outlook', () => {
  const run = (over: Partial<ExportRequest> = {}) =>
    pythonExporter({
      python: python as string,
      calendar: { from: '2026-10-05', to: '2026-10-08' },
      timeoutSeconds: 30,
      signal: new AbortController().signal,
      ...over,
    });

  it('exports calendar occurrences in the window with resolved addresses', async () => {
    vi.stubEnv('PYTHONPATH', fakeComtypes);
    const data = await run();
    expect(data).toMatchObject({ me: 'me@bank.com', outlookVersion: '16.0.fake', filter: 'scan' });
    expect(data.mail).toBeNull();
    const meetings = data.calendar?.meetings ?? [];
    expect(meetings.map((m) => m.id)).toEqual(['S:2026-10-05', 'S:2026-10-06', 'R', 'F']);
    const roadmap = meetings.find((m) => m.id === 'R');
    expect(roadmap).toMatchObject({
      subject: 'Roadmap: Q4',
      day: '2026-10-06',
      startLocal: '14:00',
      startUtc: '2026-10-06T12:00:00Z',
      location: 'Room 4',
      organizer: { name: 'Anna Kowalska', email: 'anna@bank.com' },
      categories: ['Planning', 'Team'],
      isMeeting: true,
      attendeeCount: 4,
    });
    expect(roadmap?.attendees).toEqual([
      { name: 'Anna Kowalska', email: 'anna@bank.com', kind: 'required', response: 'organizer' },
      { name: 'Me', email: 'me@bank.com', kind: 'required', response: 'accepted' },
      { name: 'John Vendor', email: 'john@vendor.com', kind: 'optional', response: 'none' },
      { name: 'Team DL', email: 'team@bank.com', kind: 'group', response: 'accepted' },
    ]);
    expect(meetings.find((m) => m.id === 'F')?.isMeeting).toBe(false);
  });

  it('exports flagged mail since a day, skipping tasks and older mail', async () => {
    vi.stubEnv('PYTHONPATH', fakeComtypes);
    const data = await run({ calendar: undefined, mailSince: '2026-09-06' });
    expect(data.calendar).toBeNull();
    expect(data.mail).toMatchObject({ since: '2026-09-06', complete: true, source: 'todo' });
    expect(data.mail?.mails).toMatchObject([
      {
        id: '<m1@bank>',
        subject: 'Budget sign-off',
        from: { email: 'anna@bank.com' },
        due: '2026-10-09',
        completed: false,
        preview: 'Hi, please review.',
      },
      { id: '<m2@vendor>', from: { email: 'john@vendor.com' }, importance: 'high' },
      { id: '<m3@bank>', completed: true },
    ]);
  });

  it('reports a missing Outlook and stops on cancel', async () => {
    vi.stubEnv('PYTHONPATH', fakeComtypes);
    vi.stubEnv('FAKE_OUTLOOK_SCENARIO', 'down');
    await expect(run()).rejects.toThrow('could not connect to Outlook: Server execution failed');

    vi.stubEnv('FAKE_OUTLOOK_SCENARIO', 'slow');
    const controller = new AbortController();
    const pending = run({ signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('Sync cancelled', 'AbortError')), 200);
    const started = Date.now();
    await expect(pending).rejects.toThrow('Sync cancelled');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('explains a missing Python', async () => {
    await expect(run({ python: 'python-does-not-exist' })).rejects.toThrow('Python not found');
  });
});
