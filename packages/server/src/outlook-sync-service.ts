/**
 * The Outlook connector: runs python/outlook_export.py against the local
 * classic Outlook, then writes meeting notes and email tasks through core.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyMailTasks,
  applyMeetings,
  IdentityIndex,
  type KnownMeeting,
  localDay,
  type MailTasksReport,
  type MeetingsReport,
  type OutlookMail,
  type OutlookMeeting,
  planMail,
  planMeeting,
  readMailState,
  type VaultConfig,
} from '@corpobrain/core';
import { type JobProgress, type JobRun, perVault, SyncJobService } from './sync-jobs.ts';
import type { VaultService } from './vault-service.ts';

export type OutlookReport = MeetingsReport | MailTasksReport;

export interface OutlookProgress extends JobProgress {
  phase: 'export' | 'notes' | 'tasks';
}

interface OutlookSyncSettings {
  calendar: { from: string; to: string } | null;
  mailSince: string | null;
  python: string;
}

export type OutlookSyncRun = JobRun<OutlookReport, OutlookProgress, OutlookSyncSettings>;

export interface ExportRequest {
  python: string;
  calendar?: { from: string; to: string };
  mailSince?: string;
  timeoutSeconds: number;
  signal: AbortSignal;
  /** called with the number of calendar items Outlook has handed over so far */
  onScanned?: (scanned: number) => void;
}

export interface ExportResult {
  me: string | null;
  outlookVersion: string | null;
  filter: string | null;
  calendar: {
    from: string;
    to: string;
    meetings: OutlookMeeting[];
    scanned: number;
    truncated: boolean;
  } | null;
  mail: { since: string; mails: OutlookMail[]; complete: boolean; source: string | null } | null;
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

/**
 * The Python to run: the configured one, else the `.venv` that
 * scripts/setup-outlook.cmd creates next to dist/ (or at the repo root in
 * development), else `python` from PATH.
 */
export function resolvePython(configured: string): { python: string; source: string } {
  if (configured.trim()) return { python: configured.trim(), source: 'configured' };
  for (const root of [join(here, '..'), join(here, '..', '..', '..')]) {
    for (const exe of [join('Scripts', 'python.exe'), join('bin', 'python')]) {
      const candidate = join(root, '.venv', exe);
      if (existsSync(candidate)) return { python: candidate, source: 'venv' };
    }
  }
  return { python: 'python', source: 'path' };
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
    const args = [script];
    if (req.calendar)
      args.push('--calendar-from', req.calendar.from, '--calendar-to', req.calendar.to);
    if (req.mailSince) args.push('--mail-since', req.mailSince);
    const child = spawn(req.python, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const result: ExportResult = {
      me: null,
      outlookVersion: null,
      filter: null,
      calendar: req.calendar
        ? { ...req.calendar, meetings: [], scanned: 0, truncated: false }
        : null,
      mail: req.mailSince
        ? { since: req.mailSince, mails: [], complete: false, source: null }
        : null,
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
          if (result.calendar) result.calendar.scanned = Number(msg.scanned) || 0;
          req.onScanned?.(Number(msg.scanned) || 0);
          break;
        case 'meeting':
          result.calendar?.meetings.push(msg as unknown as OutlookMeeting);
          break;
        case 'calendar-end':
          if (result.calendar) {
            result.calendar.scanned = Number(msg.scanned) || result.calendar.scanned;
            result.calendar.truncated = msg.truncated === true;
          }
          break;
        case 'mail':
          result.mail?.mails.push(msg as unknown as OutlookMail);
          break;
        case 'mail-end':
          if (result.mail) {
            result.mail.complete = msg.truncated !== true;
            result.mail.source = typeof msg.source === 'string' ? msg.source : null;
          }
          break;
        case 'end':
          ended = true;
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
          ? new Error(
              `Python not found: "${req.python}". Run scripts\\setup-outlook.cmd, or set the Python path in Outlook settings.`,
            )
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

const shiftDay = (now: Date, days: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return localDay(d);
};

/** The local-day calendar window for a config, ending exclusively. */
export function exportWindow(
  cfg: Pick<VaultConfig['outlook']['calendar'], 'daysBack' | 'daysAhead'>,
  now = new Date(),
): { from: string; to: string } {
  return { from: shiftDay(now, -cfg.daysBack), to: shiftDay(now, cfg.daysAhead + 1) };
}

export function mailSince(cfg: VaultConfig['outlook']['mail'], now = new Date()): string {
  return shiftDay(now, -cfg.daysBack);
}

export interface OutlookPreview {
  me: string | null;
  meetings: {
    id: string;
    day: string;
    start: string;
    subject: string;
    attendeeCount: number;
    action: 'create' | 'update' | 'skip';
    reason: string | null;
    path: string | null;
  }[];
  mails: {
    received: string;
    subject: string;
    from: string;
    action: 'add' | 'tick' | 'keep';
    reason: string | null;
  }[];
}

export const outlookService = perVault((v) => new OutlookSyncService(v));

export class OutlookSyncService extends SyncJobService<
  OutlookReport,
  OutlookProgress,
  OutlookSyncSettings
> {
  constructor(
    private readonly vault: VaultService,
    private readonly exporter: Exporter = pythonExporter,
  ) {
    super(join(vault.root, '.corpobrain', 'outlook-cache', 'sync-history.json'));
  }

  private request(config: VaultConfig) {
    const o = config.outlook;
    if (!o.calendar.enabled && !o.mail.enabled)
      throw new Error('Turn on calendar or email sync first.');
    return {
      python: resolvePython(o.python).python,
      ...(o.calendar.enabled ? { calendar: exportWindow(o.calendar) } : {}),
      ...(o.mail.enabled ? { mailSince: mailSince(o.mail) } : {}),
      timeoutSeconds: o.timeoutSeconds,
    };
  }

  private resolver() {
    const emails = IdentityIndex.load(this.vault.indexer.db, 'email');
    return (email: string) => emails.match(email);
  }

  start(): { id: string; completion: Promise<OutlookReport[]> } {
    const config = structuredClone(this.vault.config);
    const req = this.request(config);
    const plan = {
      profiles: [...(req.calendar ? ['calendar'] : []), ...(req.mailSince ? ['mail'] : [])],
      full: false,
      settings: {
        calendar: req.calendar ?? null,
        mailSince: req.mailSince ?? null,
        python: req.python,
      },
    };
    return this.launch(plan, async (job) => {
      job.progress({ profile: 'outlook', phase: 'export', current: 0, total: 0 });
      const data = await this.exporter({
        ...req,
        signal: job.signal,
        onScanned: (scanned) =>
          job.progress({ profile: 'calendar', phase: 'export', current: scanned, total: 0 }),
      });
      job.signal.throwIfAborted();
      const resolve = this.resolver();
      const reports: OutlookReport[] = [];
      const touched: string[] = [];

      if (data.calendar) {
        const total = data.calendar.meetings.length;
        job.progress({ profile: 'calendar', phase: 'notes', current: 0, total });
        const report = applyMeetings(
          this.vault.root,
          config,
          { me: data.me, ...data.calendar },
          { known: knownMeetings(this.vault), resolve, syncedAt: new Date().toISOString() },
        );
        if (data.calendar.truncated)
          report.warnings.push(
            `Outlook returned more than ${data.calendar.scanned} calendar items; the window was cut short. Fewer days back/ahead will fix it.`,
          );
        touched.push(...report.created, ...report.updated, ...report.gone);
        job.report(report);
        reports.push(report);
      }
      if (data.mail) {
        job.progress({
          profile: 'mail',
          phase: 'tasks',
          current: 0,
          total: data.mail.mails.length,
        });
        const report = applyMailTasks(this.vault.root, config, data.mail, {
          resolve,
          locate: (key) => taskLocation(this.vault, key),
        });
        if (!data.mail.complete)
          report.warnings.push(
            'Outlook returned too many flagged items to read them all; unflagged mail was not ticked this time.',
          );
        touched.push(...report.touched);
        job.report(report);
        reports.push(report);
      }
      if (touched.length) this.vault.indexer.updatePaths([...new Set(touched)]);
      return reports;
    });
  }

  /** What a sync would do, without writing anything. */
  async preview(): Promise<OutlookPreview> {
    const config = this.vault.config;
    const data = await this.exporter({
      ...this.request(config),
      signal: AbortSignal.timeout(config.outlook.timeoutSeconds * 1000),
    });
    const ctx = { me: data.me, resolve: this.resolver() };
    const known = knownMeetings(this.vault);
    const state = readMailState(this.vault.root);
    return {
      me: data.me,
      meetings: (data.calendar?.meetings ?? []).map((m) => {
        const plan = planMeeting(m, config.outlook.calendar, ctx, known);
        return {
          id: m.id,
          day: m.day,
          start: m.allDay ? 'all day' : m.startLocal,
          subject: m.subject,
          attendeeCount: m.attendeeCount,
          action: plan.action,
          reason: plan.action === 'skip' ? plan.reason : null,
          path: plan.action === 'update' ? plan.path : null,
        };
      }),
      mails: (data.mail?.mails ?? []).map((m) => {
        const plan = planMail(m, state);
        return {
          received: m.received.slice(0, 10),
          subject: m.subject,
          from: m.from.name || m.from.email || '',
          action: plan.action,
          reason: plan.action === 'keep' ? plan.reason : null,
        };
      }),
    };
  }

  /** A quick look at today's calendar, without writing anything. */
  async test(): Promise<{
    outlookVersion: string | null;
    me: string | null;
    today: number;
    python: string;
  }> {
    const o = this.vault.config.outlook;
    const python = resolvePython(o.python).python;
    const data = await this.exporter({
      python,
      calendar: exportWindow({ daysBack: 0, daysAhead: 0 }),
      timeoutSeconds: Math.min(60, o.timeoutSeconds),
      signal: AbortSignal.timeout(60_000),
    });
    return {
      outlookVersion: data.outlookVersion,
      me: data.me,
      today: data.calendar?.meetings.length ?? 0,
      python,
    };
  }
}

/** Where the task line with this block id lives now, if the index knows it. */
function taskLocation(v: VaultService, key: string): string | null {
  const row = v.indexer.db.prepare('SELECT path FROM tasks WHERE block_id = ? LIMIT 1').get(key) as
    | { path: string }
    | undefined;
  return row?.path ?? null;
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
