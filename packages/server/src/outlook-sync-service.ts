/**
 * The Outlook calendar connector: runs python/outlook_export.py against the
 * local classic Outlook, then writes meeting notes through core.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyMeetings,
  IdentityIndex,
  type KnownMeeting,
  localDay,
  type MeetingsReport,
  type OutlookExport,
  type OutlookMeeting,
  type VaultConfig,
} from '@corpobrain/core';
import { type JobProgress, type JobRun, perVault, SyncJobService } from './sync-jobs.ts';
import type { VaultService } from './vault-service.ts';

export interface OutlookProgress extends JobProgress {
  phase: 'export' | 'notes';
}

interface OutlookSyncSettings {
  from: string;
  to: string;
  folder: string;
}

export type OutlookSyncRun = JobRun<MeetingsReport, OutlookProgress, OutlookSyncSettings>;

export interface ExportRequest {
  python: string;
  from: string;
  to: string;
  timeoutSeconds: number;
  signal: AbortSignal;
  /** called with the number of calendar items Outlook has handed over so far */
  onScanned?: (scanned: number) => void;
}

export interface ExportResult extends OutlookExport {
  outlookVersion: string | null;
  scanned: number;
  truncated: boolean;
  filter: string | null;
}

export type Exporter = (req: ExportRequest) => Promise<ExportResult>;

const here = dirname(fileURLToPath(import.meta.url));
/** dist/python next to the bundle, or packages/server/python in development */
export function exporterScript(): string | null {
  return (
    [
      join(here, 'python', 'outlook_export.py'),
      join(here, '..', 'python', 'outlook_export.py'),
    ].find((p) => existsSync(p)) ?? null
  );
}

/** Run the Python exporter and collect its NDJSON. */
export const pythonExporter: Exporter = (req) =>
  new Promise((resolve, reject) => {
    const script = exporterScript();
    if (!script) {
      reject(new Error('outlook_export.py is missing from this build'));
      return;
    }
    req.signal.throwIfAborted();
    const child = spawn(req.python, [script, '--from', req.from, '--to', req.to], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const result: ExportResult = {
      me: null,
      from: req.from,
      to: req.to,
      meetings: [],
      outlookVersion: null,
      scanned: 0,
      truncated: false,
      filter: null,
    };
    let stderr = '';
    let ended = false;
    let failure: Error | null = null;
    const fail = (e: Error) => {
      failure ??= e;
      child.kill();
    };
    const timer = setTimeout(
      () => fail(new Error(`Outlook export timed out after ${req.timeoutSeconds}s`)),
      req.timeoutSeconds * 1000,
    );
    const onAbort = () => fail(req.signal.reason as Error);
    req.signal.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        fail(new Error(`unexpected exporter output: ${line.slice(0, 200)}`));
        return;
      }
      switch (msg.type) {
        case 'start':
          result.me = typeof msg.me === 'string' ? msg.me : null;
          result.outlookVersion = typeof msg.outlook === 'string' ? msg.outlook : null;
          break;
        case 'filter':
          result.filter = typeof msg.mode === 'string' ? msg.mode : null;
          break;
        case 'progress':
          result.scanned = Number(msg.scanned) || result.scanned;
          req.onScanned?.(result.scanned);
          break;
        case 'meeting':
          result.meetings.push(msg as unknown as OutlookMeeting);
          break;
        case 'end':
          ended = true;
          result.scanned = Number(msg.scanned) || result.scanned;
          result.truncated = msg.truncated === true;
          break;
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(
        e.code === 'ENOENT'
          ? new Error(`Python not found: "${req.python}". Set the Python path in Outlook settings.`)
          : e,
      ),
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(stderr.trim().split('\n').slice(-3).join(' ') || `exporter exited ${code}`),
        );
      else if (!ended) reject(new Error('Outlook export ended early'));
      else resolve(result);
    });
  });

/** The local-day export window for a config, ending exclusively. */
export function exportWindow(
  cfg: VaultConfig['outlook'],
  now = new Date(),
): { from: string; to: string } {
  const shift = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return localDay(d);
  };
  return { from: shift(-cfg.daysBack), to: shift(cfg.daysAhead + 1) };
}

export const outlookService = perVault((v) => new OutlookSyncService(v));

export class OutlookSyncService extends SyncJobService<
  MeetingsReport,
  OutlookProgress,
  OutlookSyncSettings
> {
  constructor(
    private readonly vault: VaultService,
    private readonly exporter: Exporter = pythonExporter,
  ) {
    super(join(vault.root, '.corpobrain', 'outlook-cache', 'sync-history.json'));
  }

  start(): { id: string; completion: Promise<MeetingsReport[]> } {
    const config = structuredClone(this.vault.config);
    const window = exportWindow(config.outlook);
    const plan = {
      profiles: ['calendar'],
      full: false,
      settings: { ...window, folder: config.outlook.folder },
    };
    return this.launch(plan, async (job) => {
      job.progress({ profile: 'calendar', phase: 'export', current: 0, total: 0 });
      const data = await this.exporter({
        python: config.outlook.python,
        ...window,
        timeoutSeconds: config.outlook.timeoutSeconds,
        signal: job.signal,
        onScanned: (scanned) =>
          job.progress({ profile: 'calendar', phase: 'export', current: scanned, total: 0 }),
      });
      job.signal.throwIfAborted();
      job.progress({
        profile: 'calendar',
        phase: 'notes',
        current: 0,
        total: data.meetings.length,
      });
      const db = this.vault.indexer.db;
      const emails = IdentityIndex.load(db, 'email');
      const report = applyMeetings(this.vault.root, config, data, {
        known: knownMeetings(this.vault),
        resolve: (email) => emails.match(email),
        syncedAt: new Date().toISOString(),
      });
      if (data.truncated)
        report.warnings.push(
          `Outlook returned more than ${data.scanned} items; the window was cut short. Shorten the days back/ahead.`,
        );
      const touched = [...report.created, ...report.updated, ...report.gone];
      if (touched.length) this.vault.indexer.updatePaths(touched);
      job.progress({
        profile: 'calendar',
        phase: 'notes',
        current: data.meetings.length,
        total: data.meetings.length,
      });
      job.report(report);
      return [report];
    });
  }

  /** A quick look at today's calendar, without writing anything. */
  async test(): Promise<{ outlookVersion: string | null; me: string | null; today: number }> {
    const today = exportWindow({ ...this.vault.config.outlook, daysBack: 0, daysAhead: 0 });
    const data = await this.exporter({
      python: this.vault.config.outlook.python,
      ...today,
      timeoutSeconds: Math.min(60, this.vault.config.outlook.timeoutSeconds),
      signal: AbortSignal.timeout(60_000),
    });
    return { outlookVersion: data.outlookVersion, me: data.me, today: data.meetings.length };
  }
}

/** Existing meeting notes by outlook id, wherever the user has moved them. */
function knownMeetings(v: VaultService): Map<string, KnownMeeting> {
  const rows = v.indexer.db
    .prepare(
      `SELECT path, key, value_json FROM properties
       WHERE key IN ('outlook', 'date')
         AND path IN (SELECT path FROM properties WHERE key = 'outlook')`,
    )
    .all() as { path: string; key: string; value_json: string }[];
  const byPath = new Map<string, { id?: string; day?: string }>();
  for (const row of rows) {
    const entry = byPath.get(row.path) ?? {};
    try {
      const value: unknown = JSON.parse(row.value_json);
      if (row.key === 'date' && typeof value === 'string') entry.day = value;
      if (row.key === 'outlook' && value && typeof value === 'object') {
        const id = (value as { id?: unknown }).id;
        if (typeof id === 'string') entry.id = id;
      }
    } catch {
      /* a malformed property is simply not a known meeting */
    }
    byPath.set(row.path, entry);
  }
  const known = new Map<string, KnownMeeting>();
  for (const [path, entry] of byPath)
    if (entry.id) known.set(entry.id, { path, day: entry.day ?? null });
  return known;
}
