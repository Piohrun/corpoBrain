/** Outlook sync (calendar → meeting notes, flagged mail → tasks): settings, jobs, history. */
import type { VaultConfig } from '@corpobrain/core';
import { Hono } from 'hono';
import {
  exporterScript,
  exportWindow,
  mailSince,
  outlookService,
  resolvePython,
} from './outlook-sync-service.ts';
import { pythonSetup } from './python-setup.ts';
import { HttpError, type VaultService } from './vault-service.ts';

type OutlookConfig = VaultConfig['outlook'];
type Body = Partial<Omit<OutlookConfig, 'calendar' | 'mail'>> & {
  calendar?: Partial<OutlookConfig['calendar']>;
  mail?: Partial<OutlookConfig['mail']>;
};

const SAFE_PATH = /^(?!\.)(?!.*\.\.)(?!.*\/\.)[^\\:*?"<>|]+$/;

function vaultPath(raw: string, what: string, opts: { markdown?: boolean } = {}): string {
  let path = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (opts.markdown && path && !path.toLowerCase().endsWith('.md')) path += '.md';
  if (!path || !SAFE_PATH.test(path) || /^private(\/|$)/i.test(path))
    throw new HttpError(400, `${what} must be a relative vault path outside private/`);
  return path;
}

function int(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`);
  return value;
}

function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${key} must be a list`);
  return [...new Set(value.map((s) => String(s).trim()).filter(Boolean))];
}

export function outlookRoutes(v: VaultService): Hono {
  const app = new Hono();
  const jobs = outlookService(v);

  const settings = () => {
    const o = v.config.outlook;
    const python = resolvePython(o.python);
    return {
      ...o,
      window: exportWindow(o.calendar),
      mailSince: mailSince(o.mail),
      pythonResolved: python.python,
      pythonSource: python.source,
      exporterFound: exporterScript() !== null,
    };
  };

  app.get('/config', (c) => c.json(settings()));

  app.put('/config', async (c) => {
    const body = (await c.req.json()) as Body;
    const cur = v.config.outlook;
    const next: Partial<OutlookConfig> = {};
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.python === 'string') {
      const python = body.python.trim().replace(/^"|"$/g, '');
      // The server runs this program, so only accept something that is a Python.
      // Empty means automatic: the setup script's .venv, else python on PATH.
      const exe = python.split(/[\\/]/).pop() ?? '';
      if (python && !/^(python[\d.]*w?|py)(\.exe)?$/i.test(exe))
        throw new HttpError(400, 'python must point to a Python executable (python, python3, py…)');
      next.python = python;
    }
    if (body.intervalMinutes !== undefined)
      next.intervalMinutes = int(body.intervalMinutes, 'intervalMinutes', 0, 1440);
    if (body.timeoutSeconds !== undefined)
      next.timeoutSeconds = int(body.timeoutSeconds, 'timeoutSeconds', 10, 1800);

    if (body.calendar) {
      const b = body.calendar;
      const cal = { ...cur.calendar };
      for (const key of ['enabled', 'withPeople', 'recurring', 'includeAppointments'] as const)
        if (typeof b[key] === 'boolean') cal[key] = b[key];
      if (typeof b.folder === 'string') cal.folder = vaultPath(b.folder, 'folder');
      if (b.daysBack !== undefined) cal.daysBack = int(b.daysBack, 'calendar days back', 0, 365);
      if (b.daysAhead !== undefined) cal.daysAhead = int(b.daysAhead, 'calendar days ahead', 0, 90);
      if (b.maxAttendees !== undefined)
        cal.maxAttendees = int(b.maxAttendees, 'maxAttendees', 0, 10000);
      for (const key of [
        'onlyCategories',
        'onlySubjects',
        'skipCategories',
        'skipSubjects',
      ] as const)
        if (b[key] !== undefined) cal[key] = strings(b[key], key);
      next.calendar = cal;
    }
    if (body.mail) {
      const b = body.mail;
      const mail = { ...cur.mail };
      if (typeof b.enabled === 'boolean') mail.enabled = b.enabled;
      if (b.daysBack !== undefined) mail.daysBack = int(b.daysBack, 'email days back', 1, 365);
      if (typeof b.note === 'string')
        mail.note = vaultPath(b.note, 'task note', { markdown: true });
      next.mail = mail;
    }
    if (Object.keys(next).length) v.updateConfig('outlook', next);
    return c.json(settings());
  });

  const outlookError = (e: unknown, what: string) =>
    new HttpError(502, e instanceof Error ? e.message : `Outlook ${what} failed`);

  app.post('/test', async (c) => {
    try {
      return c.json(await jobs.test());
    } catch (e) {
      throw outlookError(e, 'test');
    }
  });

  app.post('/preview', async (c) => {
    try {
      return c.json(await jobs.preview());
    } catch (e) {
      throw outlookError(e, 'preview');
    }
  });

  app.get('/status', (c) => c.json(jobs.status));

  /** The Python environment the exporter needs: is it there, and set it up in one click. */
  app.get('/python', async (c) => {
    const setup = pythonSetup();
    const resolved = resolvePython(v.config.outlook.python);
    return c.json({
      ...setup.status,
      ready: setup.status.running ? false : await setup.ready(),
      configured: resolved.source === 'configured',
      python: resolved.python,
    });
  });

  app.post('/python/setup', (c) => c.json(pythonSetup().start(), 202));

  app.post('/sync/start', (c) => {
    try {
      return c.json({ ok: true, id: jobs.start().id }, 202);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e instanceof Error ? e.message : 'cannot start');
    }
  });

  app.post('/sync/cancel', async (c) => {
    const body = (await c.req.json()) as { id?: string };
    if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'sync id required');
    jobs.cancel(body.id);
    return c.json({ ok: true });
  });

  app.get('/sync/history', (c) => c.json({ runs: jobs.history, warning: jobs.historyError }));

  return app;
}

/** Periodic sync while `outlook.enabled`; re-reads the config each tick. */
export function startOutlookScheduler(v: VaultService): () => void {
  let last = 0;
  const timer = setInterval(() => {
    const cfg = v.config.outlook;
    if (!cfg.enabled || cfg.intervalMinutes <= 0) return;
    if (!cfg.calendar.enabled && !cfg.mail.enabled) return;
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
