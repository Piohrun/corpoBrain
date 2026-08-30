import { Hono } from 'hono';
import { PrivateService } from './private-service.ts';
import { HttpError, type VaultService } from './vault-service.ts';

export function privateRoutes(v: VaultService): { app: Hono; service: PrivateService } {
  const service = new PrivateService(v);
  const app = new Hono();

  const pass = async (c: {
    req: { json: () => Promise<unknown> };
  }): Promise<Record<string, string>> => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
    return body;
  };

  app.get('/status', (c) => c.json(service.status()));

  app.post('/init', async (c) => {
    const { passphrase } = await pass(c);
    if (!passphrase) throw new HttpError(400, 'passphrase required');
    service.init(passphrase);
    return c.json({ ok: true });
  });

  app.post('/unlock', async (c) => {
    const { passphrase } = await pass(c);
    if (!passphrase) throw new HttpError(400, 'passphrase required');
    service.unlock(passphrase);
    return c.json({ ok: true });
  });

  app.post('/lock', (c) => {
    service.lock();
    return c.json({ ok: true });
  });

  app.post('/change-passphrase', async (c) => {
    const { oldPassphrase, newPassphrase } = await pass(c);
    if (!oldPassphrase || !newPassphrase)
      throw new HttpError(400, 'oldPassphrase and newPassphrase required');
    service.changePassphrase(oldPassphrase, newPassphrase);
    return c.json({ ok: true });
  });

  app.get('/list', (c) => c.json(service.list()));

  app.get('/note', (c) => {
    const file = c.req.query('file');
    if (!file) throw new HttpError(400, 'file required');
    return c.json(service.read(file));
  });

  app.put('/note', async (c) => {
    const body = (await c.req.json()) as { file?: string | null; content?: string };
    if (typeof body.content !== 'string') throw new HttpError(400, 'content required');
    return c.json(service.write(body.file ?? null, body.content));
  });

  app.delete('/note', (c) => {
    const file = c.req.query('file');
    if (!file) throw new HttpError(400, 'file required');
    service.delete(file);
    return c.json({ ok: true });
  });

  app.get('/search', (c) => c.json(service.search(c.req.query('q') ?? '')));

  return { app, service };
}
