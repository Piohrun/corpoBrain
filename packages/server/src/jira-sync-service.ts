/** One sync job per vault, with bounded on-disk history and explicit cancellation. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createJiraAdapter,
  JiraSync,
  type SyncProgress,
  type SyncReport,
  writeFileAtomic,
} from '@corpobrain/core';
import { HttpError, type VaultService } from './vault-service.ts';

export interface SyncRun {
  id: string;
  profiles: string[];
  full: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  outcome: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  retries: number;
  reports: SyncReport[];
  error: string | null;
  progress: Pick<SyncProgress, 'profile' | 'phase' | 'current' | 'total'> | null;
  settings: { requestTimeoutSeconds: number; searchPageSize: number };
}

const HISTORY_LIMIT = 20;
const services = new WeakMap<VaultService, JiraSyncService>();
export function syncService(v: VaultService): JiraSyncService {
  let service = services.get(v);
  if (!service) {
    service = new JiraSyncService(v);
    services.set(v, service);
  }
  return service;
}

export class JiraSyncService {
  readonly history: SyncRun[];
  historyError: string | null = null;
  progress: (SyncProgress & { startedAt: string }) | null = null;
  private active: {
    id: string;
    controller: AbortController;
    completion: Promise<SyncReport[]>;
  } | null = null;
  private readonly file: string;

  constructor(private readonly vault: VaultService) {
    this.file = join(vault.root, '.corpobrain', 'jira-cache', 'sync-history.json');
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

  start(profile?: string, full = false): { id: string; completion: Promise<SyncReport[]> } {
    if (this.active) throw new HttpError(409, 'sync already running');
    const config = structuredClone(this.vault.config);
    const run: SyncRun = {
      id: randomUUID(),
      profiles: config.jira.profiles
        .filter((p) => !profile || p.name === profile)
        .map((p) => p.name),
      full,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: 0,
      outcome: 'running',
      retries: 0,
      reports: [],
      error: null,
      progress: null,
      settings: {
        requestTimeoutSeconds: config.jira.requestTimeoutSeconds,
        searchPageSize: config.jira.searchPageSize,
      },
    };
    this.history.unshift(run);
    this.history.splice(HISTORY_LIMIT);
    this.persist();
    const controller = new AbortController();
    // Assign the active job before executing setup, which can fail synchronously.
    const completion = Promise.resolve().then(async () => {
      let redact = (message: string) => message;
      try {
        controller.signal.throwIfAborted();
        const adapter = createJiraAdapter(this.vault.root, config, controller.signal);
        const secrets = [
          adapter.auth.token,
          adapter.auth.email,
          Buffer.from(`${adapter.auth.email ?? ''}:${adapter.auth.token}`).toString('base64'),
        ].filter((s): s is string => !!s);
        redact = (message) =>
          secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message);
        const sync = new JiraSync(this.vault.root, config, adapter);
        sync.onProgress = (p) => {
          this.progress = { ...p, startedAt: run.startedAt };
          run.progress = { profile: p.profile, phase: p.phase, current: p.current, total: p.total };
        };
        adapter.onRetry = (detail) => {
          run.retries++;
          if (this.progress)
            this.progress = { ...this.progress, detail: redact(detail), retrying: true };
          this.persist();
        };
        sync.onReport = (report) => {
          run.reports.push({ ...report, warnings: report.warnings.map(redact) });
          // Each completed profile must reach the index even if a later profile fails.
          const folder =
            config.jira.profiles.find((p) => p.name === report.profile)?.folder ??
            config.folders.jira;
          const touched = [...report.created, ...report.updated].map(
            (key) => `${folder}/${key}.md`,
          );
          touched.push(...report.peopleCreated);
          this.vault.indexer.loadSprints();
          if (touched.length) this.vault.indexer.updatePaths(touched);
          this.vault.notifyJiraChanged([report]);
          this.persist();
        };
        const reports = await sync.run(profile, { full, signal: controller.signal });
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

  cancel(id: string): void {
    if (!this.active || this.active.id !== id)
      throw new HttpError(409, 'this sync is no longer running');
    this.active.controller.abort(new DOMException('Sync cancelled', 'AbortError'));
  }

  private readHistory(): SyncRun[] {
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
            ['running', 'success', 'failed', 'cancelled', 'interrupted'].includes(r.outcome),
        )
      )
        throw new Error('invalid sync history');
      return parsed.slice(0, HISTORY_LIMIT) as SyncRun[];
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
