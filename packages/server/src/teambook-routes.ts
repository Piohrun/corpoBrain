/** Teambook org import: settings, preview job, review plan, apply, undo. */

import { existsSync } from 'node:fs';
import {
  readSecret,
  TEAMBOOK_ADAPTER_READY,
  type VaultConfig,
  writeSecrets,
} from '@corpobrain/core';
import { Hono } from 'hono';
import { teambookService } from './teambook-service.ts';
import { HttpError, type VaultService } from './vault-service.ts';

type TeambookConfig = VaultConfig['teambook'];

function int(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`);
  return value;
}

const ids = (value: unknown, key: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string'))
    throw new HttpError(400, `${key} must be a list of change ids`);
  return value as string[];
};

export function teambookRoutes(v: VaultService): Hono {
  const app = new Hono();
  const service = teambookService(v);

  const settings = () => ({
    ...v.config.teambook,
    tokenSet: !!readSecret(v.root, 'teambookToken'),
    adapterReady: TEAMBOOK_ADAPTER_READY,
    fixtureFound: existsSync(service.fixturePath),
  });

  app.get('/config', (c) => c.json(settings()));

  app.put('/config', async (c) => {
    const body = (await c.req.json()) as Partial<TeambookConfig> & { token?: string };
    const next: Partial<TeambookConfig> = {};
    if (typeof body.baseUrl === 'string') {
      const url = body.baseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s]+$/i.test(url))
        throw new HttpError(400, 'the Teambook URL must start with http:// or https://');
      next.baseUrl = url;
    }
    if (typeof body.rootPodId === 'string') next.rootPodId = body.rootPodId.trim();
    if (typeof body.proxyUrl === 'string') next.proxyUrl = body.proxyUrl.trim();
    if (body.requestTimeoutSeconds !== undefined)
      next.requestTimeoutSeconds = int(body.requestTimeoutSeconds, 'requestTimeoutSeconds', 5, 300);
    if (body.concurrency !== undefined)
      next.concurrency = int(body.concurrency, 'concurrency', 1, 16);
    if (typeof body.createUnits === 'boolean') next.createUnits = body.createUnits;
    if (typeof body.createPeople === 'boolean') next.createPeople = body.createPeople;
    if (Object.keys(next).length) v.updateConfig('teambook', next);
    if (typeof body.token === 'string' && body.token.trim())
      writeSecrets(v.root, { teambookToken: body.token.trim() });
    return c.json(settings());
  });

  app.get('/status', (c) => c.json(service.status));

  /** Start a preview: fetch (or read the fixture) and plan, writing nothing to notes. */
  app.post('/preview', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { source?: string };
    const source = body.source === 'fixture' ? 'fixture' : 'api';
    try {
      return c.json({ ok: true, id: service.preview(source).id }, 202);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e instanceof Error ? e.message : 'cannot start the preview');
    }
  });

  app.post('/preview/cancel', async (c) => {
    const body = (await c.req.json()) as { id?: string };
    if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'preview id required');
    service.cancel(body.id);
    return c.json({ ok: true });
  });

  app.get('/plan', (c) => c.json(service.currentPlan()));

  app.post('/apply', async (c) => {
    const body = (await c.req.json()) as { planId?: unknown; apply?: unknown; dismiss?: unknown };
    if (typeof body.planId !== 'string') throw new HttpError(400, 'planId required');
    return c.json(
      await service.apply(body.planId, ids(body.apply, 'apply'), ids(body.dismiss, 'dismiss')),
    );
  });

  app.get('/imports', (c) => c.json(service.imports()));

  app.post('/undo', async (c) => {
    const body = (await c.req.json()) as { id?: unknown };
    if (typeof body.id !== 'string') throw new HttpError(400, 'import id required');
    return c.json(service.undo(body.id));
  });

  return app;
}
