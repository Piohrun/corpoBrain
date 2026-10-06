/**
 * Server-owned background sync jobs, shared by every connector (Jira today;
 * Outlook and GitHub next). One job at a time per service, bounded on-disk
 * history that survives restarts, explicit cancellation, and secret redaction
 * for anything that reaches the history or the UI.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '@corpobrain/core';
import { HttpError, type VaultService } from './vault-service.ts';

export type JobOutcome = 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';

export interface JobProgress {
  /** the unit being synced: a Jira profile, an Outlook folder, a GitHub org… */
  profile: string;
  phase: string;
  current: number;
  /** 0 = unknown/indeterminate */
  total: number;
  detail?: string;
  retrying?: boolean;
}

export interface JobRun<TReport, TProgress extends JobProgress, TSettings> {
  id: string;
  /** the units this run covers (Jira profiles, Outlook folders, …) */
  profiles: string[];
  full: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  outcome: JobOutcome;
  retries: number;
  reports: TReport[];
  error: string | null;
  progress: Pick<TProgress, 'profile' | 'phase' | 'current' | 'total'> | null;
  /** connector settings in effect for this run, kept for troubleshooting */
  settings: TSettings;
}

/** What a connector's job body gets to talk back to the service with. */
export interface JobContext<TReport, TProgress extends JobProgress> {
  readonly signal: AbortSignal;
  /** Values (tokens, emails, auth headers) that must never appear in history or errors. */
  addSecrets(values: (string | null | undefined)[]): void;
  redact(message: string): string;
  progress(p: TProgress): void;
  retry(detail: string): void;
  /** Record one completed unit, so it stays in history even if a later unit fails. */
  report(r: TReport): void;
}

const HISTORY_LIMIT = 20;
const OUTCOMES: JobOutcome[] = ['running', 'success', 'failed', 'cancelled', 'interrupted'];

/** A lazily created, per-vault singleton (one job service per vault and connector). */
export function perVault<T>(create: (v: VaultService) => T): (v: VaultService) => T {
  const services = new WeakMap<VaultService, T>();
  return (v) => {
    let service = services.get(v);
    if (!service) {
      service = create(v);
      services.set(v, service);
    }
    return service;
  };
}

export class SyncJobService<TReport, TProgress extends JobProgress, TSettings> {
  readonly history: JobRun<TReport, TProgress, TSettings>[];
  historyError: string | null = null;
  progress: (TProgress & { startedAt: string }) | null = null;
  private active: {
    id: string;
    controller: AbortController;
    completion: Promise<TReport[]>;
  } | null = null;

  constructor(private readonly file: string) {
    this.history = this.readHistory();
    let recovered = false;
    for (const run of this.history) {
      if (run.outcome !== 'running') continue;
      run.outcome = 'interrupted';
      run.error =
        'Server stopped before this sync finished. Start a new sync to refresh the remaining data.';
      run.finishedAt = new Date().toISOString();
      run.durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
      recovered = true;
    }
    if (recovered) this.persist();
  }

  get status() {
    return {
      syncing: this.active !== null,
      runId: this.active?.id ?? null,
      cancelling: this.active?.controller.signal.aborted ?? false,
      progress: this.progress,
      lastReports: this.history.find((r) => r.reports.length > 0)?.reports ?? null,
      lastSyncError: this.active ? null : (this.history[0]?.error ?? null),
      lastRun: this.history[0] ?? null,
      historyError: this.historyError,
    };
  }

  cancel(id: string): void {
    if (!this.active || this.active.id !== id)
      throw new HttpError(409, 'this sync is no longer running');
    this.active.controller.abort(new DOMException('Sync cancelled', 'AbortError'));
  }

  /** Record a new run and execute `body` in the background. */
  protected launch(
    plan: { profiles: string[]; full: boolean; settings: TSettings },
    body: (job: JobContext<TReport, TProgress>) => Promise<TReport[]>,
  ): { id: string; completion: Promise<TReport[]> } {
    if (this.active) throw new HttpError(409, 'sync already running');
    const run: JobRun<TReport, TProgress, TSettings> = {
      id: randomUUID(),
      profiles: plan.profiles,
      full: plan.full,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      outcome: 'running',
      retries: 0,
      reports: [],
      error: null,
      progress: null,
      settings: plan.settings,
    };
    this.history.unshift(run);
    this.history.splice(HISTORY_LIMIT);
    this.persist();
    const controller = new AbortController();
    const secrets: string[] = [];
    const redact = (message: string) =>
      secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message);
    const job: JobContext<TReport, TProgress> = {
      signal: controller.signal,
      addSecrets: (values) => {
        // too short to be a credential, and redacting it would garble every message
        for (const value of values) if (value && value.length >= 4) secrets.push(value);
      },
      redact,
      progress: (p) => {
        this.progress = { ...p, startedAt: run.startedAt };
        run.progress = { profile: p.profile, phase: p.phase, current: p.current, total: p.total };
      },
      retry: (detail) => {
        run.retries++;
        if (this.progress)
          this.progress = { ...this.progress, detail: redact(detail), retrying: true };
        this.persist();
      },
      report: (r) => {
        run.reports.push(r);
        this.persist();
      },
    };
    // Assign the active job before executing setup, which can fail synchronously.
    const completion = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted();
        const reports = await body(job);
        run.outcome = 'success';
        return reports;
      } catch (e) {
        run.outcome = controller.signal.aborted ? 'cancelled' : 'failed';
        run.error =
          run.outcome === 'cancelled' ? null : redact(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        run.finishedAt = new Date().toISOString();
        run.durationMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
        this.progress = null;
        this.active = null;
        this.persist();
      }
    });
    this.active = { id: run.id, controller, completion };
    // Background callers use the history/status endpoints to observe failure.
    void completion.catch(() => {});
    return { id: run.id, completion };
  }

  private readHistory(): JobRun<TReport, TProgress, TSettings>[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (r) =>
            r &&
            typeof r.id === 'string' &&
            typeof r.startedAt === 'string' &&
            Array.isArray(r.reports) &&
            Array.isArray(r.profiles) &&
            OUTCOMES.includes(r.outcome),
        )
      )
        throw new Error('invalid sync history');
      return parsed.slice(0, HISTORY_LIMIT) as JobRun<TReport, TProgress, TSettings>[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        this.historyError = 'Could not read previous sync history.';
      return [];
    }
  }

  private persist(): void {
    try {
      writeFileAtomic(this.file, `${JSON.stringify(this.history, null, 2)}\n`);
    } catch {
      this.historyError =
        'Could not save sync history. Check vault permissions and free disk space.';
    }
  }
}
