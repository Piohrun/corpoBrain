/** Outlook calendar sync: settings, jobs and history. */
import type { VaultConfig } from '@corpobrain/core';
import { Hono } from 'hono';
import { exporterScript, exportWindow, outlookService } from './outlook-sync-service.ts';
import { HttpError, type VaultService } from './vault-service.ts';

const FOLDER = /^(?!\.)(?!.*\.\.)[^\\:*?"<>|]+$/;

export function outlookRoutes(v: VaultService): Hono {
  const app = new Hono();
  const jobs = outlookService(v);

  const settings = () => ({
    ...v.config.outlook,
    window: exportWindow(v.config.outlook),
    exporterFound: exporterScript() !== null,
  });

  app.get('/config', (c) => c.json(settings()));

  app.put('/config', async (c) => {
    const body = (await c.req.json()) as Partial<VaultConfig['outlook']>;
    const partial: Partial<VaultConfig['outlook']> = {};
    if (typeof body.enabled === 'boolean') partial.enabled = body.enabled;
    if (typeof body.includeAppointments === 'boolean')
      partial.includeAppointments = body.includeAppointments;
    if (typeof body.python === 'string') {
      const python = body.python.trim();
      // The server runs this program, so only accept something that is a Python.
      const exe = python.replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? '';
      if (!/^(python[\d.]*w?|py)(\.exe)?$/i.test(exe))
        throw new HttpError(400, 'python must point to a Python executable (python, python3, py…)');
      partial.python = python.replace(/^"|"$/g, '');
    }
    if (typeof body.folder === 'string') {
      const folder = body.folder
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      if (!folder || !FOLDER.test(folder))
        throw new HttpError(400, 'folder must be a relative vault folder');
      partial.folder = folder;
    }
    for (const [key, min, max] of [
      ['daysBack', 0, 90],
      ['daysAhead', 0, 90],
      ['intervalMinutes', 0, 1440],
      ['timeoutSeconds', 10, 1800],
    ] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
        throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`);
      partial[key] = value;
    }
    for (const key of ['skipCategories', 'skipSubjects'] as const) {
      const value = body[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw new HttpError(400, `${key} must be a list`);
      partial[key] = [...new Set(value.map((s) => String(s).trim()).filter(Boolean))];
    }
    if (Object.keys(partial).length) v.updateConfig('outlook', partial);
    return c.json(settings());
  });

  app.post('/test', async (c) => {
    try {
      return c.json(await jobs.test());
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : 'Outlook test failed');
    }
  });

  app.get('/status', (c) => c.json(jobs.status));

  app.post('/sync/start', (c) => c.json({ ok: true, id: jobs.start().id }, 202));

  app.post('/sync/cancel', async (c) => {
    const body = (await c.req.json()) as { id?: string };
    if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'sync id required');
    jobs.cancel(body.id);
    return c.json({ ok: true });
  });

  app.get('/sync/history', (c) => c.json({ runs: jobs.history, warning: jobs.historyError }));

  return app;
}

/** Periodic calendar sync while `outlook.enabled`; re-reads the config each tick. */
export function startOutlookScheduler(v: VaultService): () => void {
  let last = 0;
  const timer = setInterval(() => {
    const cfg = v.config.outlook;
    if (!cfg.enabled || cfg.intervalMinutes <= 0) return;
    if (Date.now() - last < cfg.intervalMinutes * 60_000) return;
    const jobs = outlookService(v);
    if (jobs.status.syncing) return;
    last = Date.now();
    jobs
      .start()
      .completion.catch((e: Error) =>
        console.error(`[outlook] scheduled sync failed: ${e.message}`),
      );
  }, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
