import { SPEC_VERSION } from '@corpobrain/core';
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, spec: SPEC_VERSION }));
  return app;
}
