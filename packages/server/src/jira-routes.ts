/** Jira + planning API routes (read side; plan writes arrive in Phase 4). */
import { createJiraAdapter, JiraSync, type SyncReport } from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

export interface JiraIssueRow {
  key: string;
  path: string;
  summary: string | null;
  status: string | null;
  status_category: string | null;
  issue_type: string | null;
  priority: string | null;
  assignee: string | null;
  sprint: string | null;
  sprint_id: number | null;
  epic: string | null;
  labels_json: string | null;
  estimate: number | null;
  updated: string | null;
  // plan overlay
  plan_sprint: string | null;
  plan_assignee: string | null;
  plan_rank: number | null;
  plan_effort: number | null;
  plan_risk: string | null;
  plan_confidence: string | null;
  plan_bucket: string | null;
  plan_blocked_on: string | null;
  plan_note: string | null;
}

export function jiraRoutes(v: VaultService): Hono {
  const app = new Hono();
  let syncing = false;

  app.get('/issues', (c) =>
    c.json(
      v.indexer.db
        .prepare(
          `SELECT j.*, p.sprint AS plan_sprint, p.assignee AS plan_assignee,
                  p.rank AS plan_rank, p.effort AS plan_effort, p.risk AS plan_risk,
                  p.confidence AS plan_confidence, p.bucket AS plan_bucket,
                  p.blocked_on_json AS plan_blocked_on, p.note AS plan_note
           FROM jira j LEFT JOIN plan p ON p.key = j.key
           ORDER BY j.key`,
        )
        .all(),
    ),
  );

  app.get('/sprints', (c) =>
    c.json(
      v.indexer.db
        .prepare(
          `SELECT id, name, state, start, end, board_id, goal FROM sprints ORDER BY start IS NULL, start`,
        )
        .all(),
    ),
  );

  app.get('/people', (c) =>
    c.json(
      v.indexer.db
        .prepare(
          'SELECT path, jira_id, name, capacity, overrides_json, active FROM people ORDER BY name',
        )
        .all(),
    ),
  );

  app.post('/sync', async (c) => {
    if (syncing) throw new HttpError(409, 'sync already running');
    syncing = true;
    try {
      const body = (await c.req.json().catch(() => ({}))) as { profile?: string };
      const reports = await runSync(v, body.profile);
      return c.json({ ok: true, reports });
    } catch (e) {
      throw e instanceof HttpError
        ? e
        : new HttpError(502, e instanceof Error ? e.message : 'sync failed');
    } finally {
      syncing = false;
    }
  });

  app.get('/status', (c) => {
    const lastSynced = v.indexer.db.prepare('SELECT MAX(synced) AS synced FROM jira').get() as {
      synced: string | null;
    };
    return c.json({
      syncing,
      configured: v.config.jira.baseUrl !== '' && v.config.jira.profiles.length > 0,
      baseUrl: v.config.jira.baseUrl,
      profiles: v.config.jira.profiles.map((p) => p.name),
      lastSynced: lastSynced.synced,
    });
  });

  return app;
}

export async function runSync(v: VaultService, profile?: string): Promise<SyncReport[]> {
  const adapter = createJiraAdapter(v.root, v.config);
  const sync = new JiraSync(v.root, v.config, adapter);
  const reports = await sync.run(profile);
  v.indexer.loadSprints();
  v.indexer.update();
  v.notifyJiraChanged(reports);
  return reports;
}

/** Background scheduler honouring each profile's intervalMinutes. */
export function startSyncScheduler(v: VaultService): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const profile of v.config.jira.profiles) {
    if (!profile.intervalMinutes || profile.intervalMinutes <= 0) continue;
    const timer = setInterval(
      () => {
        runSync(v, profile.name).catch((e: Error) =>
          console.error(`[jira:${profile.name}] scheduled sync failed: ${e.message}`),
        );
      },
      profile.intervalMinutes * 60 * 1000,
    );
    timer.unref?.();
    timers.push(timer);
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
