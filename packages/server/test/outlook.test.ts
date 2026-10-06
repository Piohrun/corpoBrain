import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import {
  type ExportResult,
  OutlookSyncService,
  pythonExporter,
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

const exportOf = (subject: string, location = 'Room 4'): ExportResult => ({
  me: 'me@bank.com',
  from: '2026-09-29',
  to: '2026-10-21',
  outlookVersion: '16.0',
  scanned: 1,
  truncated: false,
  filter: 'restrict',
  meetings: [
    {
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
      attendeeCount: 0,
      busy: 'busy',
      isMeeting: true,
      cancelled: false,
      response: 'accepted',
      recurring: false,
      categories: [],
      private: false,
    },
  ],
});

describe('Outlook sync service', () => {
  it('writes notes, finds them again after the user moves them, and keeps history', async () => {
    let next = exportOf('Roadmap');
    const service = new OutlookSyncService(vault, async () => next);
    const [first] = await service.start().completion;
    expect(first?.created).toEqual(['meetings/2026-10-06 Roadmap.md']);
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

    next = exportOf('Roadmap', 'Teams');
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

  it('records exporter failures in history', async () => {
    const service = new OutlookSyncService(vault, async () => {
      throw new Error('could not connect to Outlook: Server execution failed');
    });
    await expect(service.start().completion).rejects.toThrow('Server execution failed');
    expect(service.history[0]).toMatchObject({ outcome: 'failed', error: expect.any(String) });
  });
});

describe('Outlook settings API', () => {
  it('validates and persists settings, refusing non-Python programs', async () => {
    const app = createApp(vault);
    const put = (body: unknown) =>
      app.request('/api/outlook/config', { method: 'PUT', body: JSON.stringify(body) });
    const res = await put({
      python: '"C:\\Program Files\\Python312\\python.exe"',
      daysAhead: 21,
      folder: '/meetings/2026/',
      skipSubjects: [' Lunch ', 'Lunch', ''],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      python: 'C:\\Program Files\\Python312\\python.exe',
      daysAhead: 21,
      folder: 'meetings/2026',
      skipSubjects: ['Lunch'],
      exporterFound: true,
    });
    const onDisk = JSON.parse(readFileSync(join(root, '.corpobrain', 'config.json'), 'utf8'));
    expect(onDisk.outlook.daysAhead).toBe(21);
    expect((await put({ python: 'C:\\Windows\\System32\\calc.exe' })).status).toBe(400);
    expect((await put({ python: 'python; rm -rf /' })).status).toBe(400);
    expect((await put({ folder: '../outside' })).status).toBe(400);
    expect((await put({ daysBack: 365 })).status).toBe(400);
    expect((await put({ python: 'py' })).status).toBe(200);
  });
});

describe.skipIf(!python)('outlook_export.py against a fake Outlook', () => {
  const run = (signal = new AbortController().signal) =>
    pythonExporter({
      python: python as string,
      from: '2026-10-05',
      to: '2026-10-08',
      timeoutSeconds: 30,
      signal,
    });

  it('exports occurrences in the window with resolved addresses', async () => {
    vi.stubEnv('PYTHONPATH', fakeComtypes);
    const data = await run();
    expect(data).toMatchObject({ me: 'me@bank.com', outlookVersion: '16.0.fake', filter: 'scan' });
    expect(data.meetings.map((m) => m.id)).toEqual(['S:2026-10-05', 'S:2026-10-06', 'R', 'F']);
    const roadmap = data.meetings.find((m) => m.id === 'R');
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
    expect(data.meetings.find((m) => m.id === 'F')?.isMeeting).toBe(false);
  });

  it('reports a missing Outlook and stops on cancel', async () => {
    vi.stubEnv('PYTHONPATH', fakeComtypes);
    vi.stubEnv('FAKE_OUTLOOK_SCENARIO', 'down');
    await expect(run()).rejects.toThrow('could not connect to Outlook: Server execution failed');

    vi.stubEnv('FAKE_OUTLOOK_SCENARIO', 'slow');
    const controller = new AbortController();
    const pending = run(controller.signal);
    setTimeout(() => controller.abort(new DOMException('Sync cancelled', 'AbortError')), 200);
    const started = Date.now();
    await expect(pending).rejects.toThrow('Sync cancelled');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('explains a missing Python', async () => {
    await expect(
      pythonExporter({
        python: 'python-does-not-exist',
        from: '2026-10-05',
        to: '2026-10-08',
        timeoutSeconds: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Python not found');
  });
});
