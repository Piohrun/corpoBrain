/** The Jira connector on top of the shared sync-job service. */
import { join } from 'node:path';
import { createJiraAdapter, JiraSync, type SyncProgress, type SyncReport } from '@corpobrain/core';
import { type JobRun, perVault, SyncJobService } from './sync-jobs.ts';
import type { VaultService } from './vault-service.ts';

interface JiraSyncSettings {
  requestTimeoutSeconds: number;
  searchPageSize: number;
}

export type SyncRun = JobRun<SyncReport, SyncProgress, JiraSyncSettings>;

export const syncService = perVault((v) => new JiraSyncService(v));

export class JiraSyncService extends SyncJobService<SyncReport, SyncProgress, JiraSyncSettings> {
  constructor(private readonly vault: VaultService) {
    super(join(vault.root, '.corpobrain', 'jira-cache', 'sync-history.json'));
  }

  start(profile?: string, full = false): { id: string; completion: Promise<SyncReport[]> } {
    const config = structuredClone(this.vault.config);
    const plan = {
      profiles: config.jira.profiles
        .filter((p) => !profile || p.name === profile)
        .map((p) => p.name),
      full,
      settings: {
        requestTimeoutSeconds: config.jira.requestTimeoutSeconds,
        searchPageSize: config.jira.searchPageSize,
      },
    };
    return this.launch(plan, async (job) => {
      const adapter = createJiraAdapter(this.vault.root, config, job.signal);
      job.addSecrets([
        adapter.auth.token,
        adapter.auth.email,
        Buffer.from(`${adapter.auth.email ?? ''}:${adapter.auth.token}`).toString('base64'),
      ]);
      const sync = new JiraSync(this.vault.root, config, adapter);
      const db = this.vault.indexer.db;
      sync.lookup = {
        mirroredKeys: (profile) =>
          (
            db
              .prepare(
                'SELECT key FROM jira WHERE profile = ? AND substr(path, 1, ?) = ? ORDER BY key',
              )
              .all(profile.name, profile.folder.length + 1, `${profile.folder}/`) as {
              key: string;
            }[]
          ).map((r) => r.key),
        knownPeopleIds: () => {
          const ids = new Set<string>();
          for (const r of db.prepare('SELECT jira_id FROM people').all() as { jira_id: string }[])
            for (const id of JSON.parse(r.jira_id) as string[]) ids.add(id);
          return ids;
        },
      };
      sync.onProgress = (p) => job.progress(p);
      adapter.onRetry = (detail) => job.retry(detail);
      sync.onReport = (report) => {
        job.report({ ...report, warnings: report.warnings.map(job.redact) });
        // Each completed profile must reach the index even if a later profile fails.
        const folder =
          config.jira.profiles.find((p) => p.name === report.profile)?.folder ??
          config.folders.jira;
        const touched = [...report.created, ...report.updated].map((key) => `${folder}/${key}.md`);
        touched.push(...report.peopleCreated);
        this.vault.indexer.loadSprints();
        if (touched.length) this.vault.indexer.updatePaths(touched);
        this.vault.notifyJiraChanged([report]);
      };
      return await sync.run(profile, { full, signal: job.signal });
    });
  }
}
