/** Jira + planning API routes (read side; plan writes arrive in Phase 4). */
import {
  createJiraAdapter,
  JiraError,
  JiraSync,
  loadJiraAuth,
  type SyncProgress,
  type SyncReport,
  type VaultConfig,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';
import {
  type ApplyItem,
  applyChanges,
  collectStaged,
  journalTail,
  previewChanges,
  undoItems,
} from './writeback.ts';

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

/** Module-level sync progress (one vault per server process). */
let liveProgress: (SyncProgress & { startedAt: string }) | null = null;
let lastReports: SyncReport[] | null = null;
let lastSyncError: string | null = null;
/** One sync at a time, whoever asks (button, scheduler, post-write-back). */
let syncInFlight = false;

export function jiraRoutes(v: VaultService): Hono {
  const app = new Hono();

  const sanitizedConfig = () => ({
    baseUrl: v.config.jira.baseUrl,
    proxyUrl: v.config.jira.proxyUrl,
    deployment: v.config.jira.deployment,
    auth: v.config.jira.auth,
    projectKeys: v.config.jira.projectKeys,
    estimateField: v.config.jira.estimateField,
    estimateUnit: v.config.jira.estimateUnit,
    syncComments: v.config.jira.syncComments,
    writeback: v.config.jira.writeback,
    profiles: v.config.jira.profiles,
    tokenSet: loadJiraAuth(v.root, v.config) !== null,
  });

  app.get('/config', (c) => c.json(sanitizedConfig()));

  app.put('/config', async (c) => {
    const body = (await c.req.json()) as Partial<VaultConfig['jira']> & {
      token?: string;
      email?: string;
    };
    const { token, email, ...rest } = body;
    const partial: Partial<VaultConfig['jira']> = {};
    if (typeof rest.baseUrl === 'string') partial.baseUrl = rest.baseUrl.trim().replace(/\/+$/, '');
    if (typeof rest.proxyUrl === 'string') partial.proxyUrl = rest.proxyUrl.trim();
    if (rest.deployment && ['auto', 'datacenter', 'cloud'].includes(rest.deployment))
      partial.deployment = rest.deployment;
    if (rest.auth && ['bearer', 'basic'].includes(rest.auth)) partial.auth = rest.auth;
    if (Array.isArray(rest.projectKeys))
      partial.projectKeys = rest.projectKeys
        .map((k) => String(k).trim().toUpperCase())
        .filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    if (typeof rest.estimateField === 'string') partial.estimateField = rest.estimateField.trim();
    if (rest.estimateUnit && ['points', 'days', 'hours', 'seconds'].includes(rest.estimateUnit))
      partial.estimateUnit = rest.estimateUnit;
    if (typeof rest.syncComments === 'boolean') partial.syncComments = rest.syncComments;
    if (rest.writeback && ['off', 'dry-run', 'on'].includes(rest.writeback))
      partial.writeback = rest.writeback;
    if (Array.isArray(rest.profiles)) {
      partial.profiles = rest.profiles
        .filter((p) => p && typeof p.name === 'string' && typeof p.jql === 'string')
        .map((p) => ({
          name: p.name.trim(),
          jql: p.jql.trim(),
          folder: typeof p.folder === 'string' && p.folder.trim() ? p.folder.trim() : 'jira',
          intervalMinutes: Number(p.intervalMinutes) >= 0 ? Number(p.intervalMinutes) : 0,
          boards: Array.isArray(p.boards)
            ? p.boards.map(Number).filter((b) => Number.isInteger(b) && b > 0)
            : [],
          futureSprints: Number.isInteger(Number(p.futureSprints)) ? Number(p.futureSprints) : 3,
        }));
    }
    if (Object.keys(partial).length) v.updateConfig('jira', partial);
    if (token !== undefined || email !== undefined) {
      v.saveJiraSecrets({
        ...(token !== undefined && token !== '' ? { token } : {}),
        ...(email !== undefined ? { email } : {}),
      });
    }
    return c.json(sanitizedConfig());
  });

  /** Discover agile boards (for the settings page board-id picker). */
  app.get('/boards', async (c) => {
    try {
      const adapter = createJiraAdapter(v.root, v.config);
      const project = c.req.query('project') || v.config.jira.projectKeys[0];
      return c.json(await adapter.boards(project));
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'board lookup failed');
    }
  });

  app.post('/probe', async (c) => {
    try {
      const adapter = createJiraAdapter(v.root, v.config);
      const info = await adapter.probe();
      return c.json({ ok: true, ...info });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'probe failed');
    }
  });

  /**
   * Does this Jira expose the development panel (GitHub/Bitbucket/GitLab
   * integration)? Probed on one mirrored issue — the most recently updated,
   * or the key given — so the answer reflects the real instance.
   */
  app.post('/devstatus/probe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: string };
    const key =
      body.key?.trim() ||
      (
        v.indexer.db.prepare('SELECT key FROM jira ORDER BY updated DESC LIMIT 1').get() as
          | { key: string }
          | undefined
      )?.key;
    if (!key) throw new HttpError(400, 'no mirrored issue to probe with — sync first');
    try {
      const adapter = createJiraAdapter(v.root, v.config);
      const r = await adapter.devStatusSummary(key);
      return c.json({ ok: true, key, ...r });
    } catch (e) {
      if (e instanceof JiraError && e.status === 404)
        return c.json({
          ok: false,
          key,
          reason:
            'this Jira has no development integration (dev-status API not found) — a direct GitHub connection would be needed',
        });
      throw new HttpError(502, e instanceof Error ? e.message : 'dev-status probe failed');
    }
  });

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
          `SELECT id, name, state, start, end, board_id, goal, source, path FROM sprints
           ORDER BY state = 'closed', start IS NULL, start, name`,
        )
        .all(),
    ),
  );

  /** Create a local sprint (a planning/ note with type: sprint). */
  app.post('/sprints', async (c) => {
    const body = (await c.req.json()) as {
      name?: string;
      start?: string;
      end?: string;
      goal?: string;
    };
    const name = body.name?.trim();
    if (!name) throw new HttpError(400, 'name required');
    const exists = v.indexer.db.prepare('SELECT 1 FROM sprints WHERE name = ?').get(name);
    if (exists) throw new HttpError(409, `sprint "${name}" already exists`);
    const date = (x: string | undefined) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined);
    const rel = `${v.config.folders.planning}/${name.replace(/[\\/:*?"<>|]/g, '-')}.md`;
    const fmLines = [
      'type: sprint',
      `title: ${JSON.stringify(name)}`,
      `name: ${JSON.stringify(name)}`,
      'state: future',
      ...(date(body.start) ? [`start: ${date(body.start)}`] : []),
      ...(date(body.end) ? [`end: ${date(body.end)}`] : []),
      ...(body.goal?.trim() ? [`goal: ${JSON.stringify(body.goal.trim())}`] : []),
    ];
    v.create(rel, name, `---\n${fmLines.join('\n')}\n---\n\n# ${name}\n\n`);
    return c.json({ ok: true, path: rel });
  });

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
    if (syncInFlight) throw new HttpError(409, 'sync already running');
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        profile?: string;
        full?: boolean;
      };
      const reports = await runSync(v, body.profile, body.full === true);
      return c.json({ ok: true, reports });
    } catch (e) {
      throw e instanceof HttpError
        ? e
        : new HttpError(502, e instanceof Error ? e.message : 'sync failed');
    }
  });

  // ------------------------------------------------------------ write-back
  let applying = false;

  app.get('/writeback/staged', (c) => c.json(collectStaged(v)));

  app.post('/writeback/preview', async (c) => {
    if (v.config.jira.writeback === 'off')
      throw new HttpError(403, 'write-back is off — enable dry-run in Jira settings first');
    const body = (await c.req.json().catch(() => ({}))) as { keys?: string[] };
    const staged = collectStaged(v).filter(
      (s) => s.writable && (!body.keys || body.keys.includes(s.key)),
    );
    const adapter = createJiraAdapter(v.root, v.config);
    return c.json(await previewChanges(v, adapter, staged));
  });

  app.post('/writeback/apply', async (c) => {
    const mode = v.config.jira.writeback;
    if (mode === 'off')
      throw new HttpError(403, 'write-back is off — enable dry-run in Jira settings first');
    if (applying) throw new HttpError(409, 'a write-back batch is already running');
    applying = true;
    try {
      const body = (await c.req.json()) as { items?: unknown };
      const items = Array.isArray(body.items) ? (body.items as ApplyItem[]) : [];
      if (!items.length) throw new HttpError(400, 'items required');
      for (const i of items) {
        const toOk = typeof i.to === 'string' || (i.to === null && i.field === 'assignee');
        if (!i.key || !['sprint', 'assignee'].includes(i.field) || !toOk)
          throw new HttpError(400, 'invalid item');
      }
      const adapter = createJiraAdapter(v.root, v.config);
      const report = await applyChanges(v, adapter, items, { dryRun: mode === 'dry-run' });
      if (mode === 'on' && report.results.some((r) => r.status === 'applied')) {
        // fire-and-forget resync so the mirror catches up with our own writes
        runSync(v).catch(() => {});
      }
      return c.json(report);
    } finally {
      applying = false;
    }
  });

  app.get('/writeback/journal', (c) =>
    c.json(journalTail(v, Number(c.req.query('limit') ?? 50)).reverse()),
  );

  app.post('/writeback/undo', async (c) => {
    const body = (await c.req.json()) as { batchId?: string };
    if (!body.batchId) throw new HttpError(400, 'batchId required');
    return c.json({ items: undoItems(v, body.batchId) });
  });

  app.get('/status', (c) => {
    const lastSynced = v.indexer.db.prepare('SELECT MAX(synced) AS synced FROM jira').get() as {
      synced: string | null;
    };
    return c.json({
      syncing: liveProgress !== null || syncInFlight,
      progress: liveProgress,
      lastReports,
      lastSyncError,
      configured: v.config.jira.baseUrl !== '' && v.config.jira.profiles.length > 0,
      baseUrl: v.config.jira.baseUrl,
      profiles: v.config.jira.profiles.map((p) => p.name),
      lastSynced: lastSynced.synced,
    });
  });

  return app;
}

export async function runSync(
  v: VaultService,
  profile?: string,
  full = false,
): Promise<SyncReport[]> {
  if (syncInFlight) throw new HttpError(409, 'sync already running');
  syncInFlight = true;
  const adapter = createJiraAdapter(v.root, v.config);
  const sync = new JiraSync(v.root, v.config, adapter);
  const startedAt = new Date().toISOString();
  sync.onProgress = (p) => {
    liveProgress = { ...p, startedAt };
  };
  try {
    const reports = await sync.run(profile, { full });
    lastReports = reports;
    lastSyncError = null;
    v.indexer.loadSprints();
    // Re-index what the sync wrote, not the whole vault: a full walk stats
    // every file, which on a laptop with antivirus is the expensive part.
    const touched = reports.flatMap((r) => [
      ...r.created.map((k) => `${profileFolder(v, r.profile)}/${k}.md`),
      ...r.updated.map((k) => `${profileFolder(v, r.profile)}/${k}.md`),
      ...r.peopleCreated,
    ]);
    if (touched.length) v.indexer.updatePaths(touched);
    v.notifyJiraChanged(reports);
    return reports;
  } catch (e) {
    lastSyncError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    liveProgress = null;
    syncInFlight = false;
  }
}

function profileFolder(v: VaultService, name: string): string {
  return v.config.jira.profiles.find((p) => p.name === name)?.folder ?? v.config.folders.jira;
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
