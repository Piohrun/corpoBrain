import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { startSyncScheduler } from './jira-routes.ts';
import { VaultService } from './vault-service.ts';

const vaultRoot = resolve(process.env.CORPOBRAIN_VAULT ?? process.argv[2] ?? process.cwd());
const port = Number(process.env.CORPOBRAIN_PORT ?? 4747);
const hostname = '127.0.0.1'; // never bind externally

const vault = new VaultService(vaultRoot);
vault.startWatching();
startSyncScheduler(vault);
const app = createApp(vault);

// Static UI: dist/ui next to the bundled server, or packages path in dev.
const here = dirname(fileURLToPath(import.meta.url));
const uiDir = [join(here, 'ui'), join(here, '..', '..', '..', 'dist', 'ui')].find((d) =>
  existsSync(join(d, 'index.html')),
);
if (uiDir) {
  const MIME: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  };
  app.get('*', (c) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/')) return c.notFound();
    let file = join(uiDir, url.pathname.replace(/^\//, ''));
    if (!existsSync(file) || url.pathname === '/') file = join(uiDir, 'index.html');
    const body = readFileSync(file);
    return c.body(body, 200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    });
  });
}

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`corpobrain vault: ${vaultRoot}`);
  console.log(`corpobrain listening on http://${info.address}:${info.port}`);
});
