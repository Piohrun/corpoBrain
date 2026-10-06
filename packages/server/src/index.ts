import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { bootHandler, openBrowser } from './boot.ts';
import { gitFor, startAutoCommit } from './git-service.ts';
import { startSyncScheduler } from './jira-routes.ts';
import { startOutlookScheduler } from './outlook-routes.ts';
import { VaultService } from './vault-service.ts';

const args = process.argv.slice(2);
/** --open: open the browser once the server answers (start.cmd passes it) */
const openOnStart = args.includes('--open');
const vaultRoot = resolve(
  process.env.CORPOBRAIN_VAULT ?? args.find((a) => !a.startsWith('--')) ?? process.cwd(),
);
const port = Number(process.env.CORPOBRAIN_PORT ?? 4747);
const hostname = '127.0.0.1'; // never bind externally

// performance.now() counts from process start: this first line is the cost of
// booting Node itself (flags such as --use-system-ca load before any of our code)
console.log(`node booted in ${Math.round(performance.now())} ms`);

/*
 * Listen first, open the vault second: until the index has caught up every
 * page is a loading screen (boot.ts) that switches to the app by itself.
 * Opening the vault is synchronous, so it starts only once a browser we
 * opened has its loading screen (or after a moment, if none asks).
 */
let bootError: string | null = null;
let handler: (req: Request) => Response | Promise<Response>;
let openAt = Number.POSITIVE_INFINITY;
let opening: NodeJS.Timeout | undefined;
/** open the vault in `ms`, unless it is already due sooner */
const openSoon = (ms: number) => {
  const at = Date.now() + ms;
  if (at >= openAt) return;
  openAt = at;
  clearTimeout(opening);
  opening = setTimeout(openVault, ms);
};
handler = bootHandler(
  vaultRoot,
  () => ({ error: bootError }),
  // give the response a moment to leave before the event loop is busy
  () => openSoon(50),
);

const server = serve({ fetch: (req) => handler(req), port, hostname }, (info) => {
  const url = `http://${info.address}:${info.port}`;
  console.log(`corpobrain vault: ${vaultRoot}`);
  console.log(
    `corpobrain listening on ${url} (${Math.round(performance.now())} ms after process start)`,
  );
  if (openOnStart) {
    openBrowser(url);
    openSoon(3000);
  } else openSoon(0);
});

// Port taken: most likely corpoBrain is already running, so show that one.
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const url = `http://${hostname}:${port}`;
  void fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json() as Promise<{ vault?: string | null }>)
    .then((h) => {
      console.log(`corpoBrain is already running on ${url} (vault: ${h.vault ?? '?'})`);
      if (openOnStart) openBrowser(url);
      process.exit(0);
    })
    .catch(() => {
      console.error(
        `port ${port} is in use by another program: set CORPOBRAIN_PORT to a free port`,
      );
      process.exit(1);
    });
});

function openVault(): void {
  openAt = Number.NEGATIVE_INFINITY; // once
  try {
    handler = startApp();
    console.log(`corpobrain ready ${Math.round(performance.now())} ms after process start`);
  } catch (e) {
    bootError = e instanceof Error ? e.message : String(e);
    console.error(e);
  }
}

function startApp(): (req: Request) => Response | Promise<Response> {
  const vault = new VaultService(vaultRoot);
  {
    const { ms, summary } = vault.startup;
    const total = summary.unchanged + summary.indexed.length;
    const rebuilt = summary.unchanged === 0 && summary.indexed.length > 0;
    console.log(
      `index: ${total} notes, ${summary.indexed.length} re-indexed, ${summary.removed.length} removed in ${ms} ms${
        rebuilt
          ? ' — full rebuild (first start, or the index schema changed with this version)'
          : ''
      }`,
    );
  }
  vault.startWatching();
  startSyncScheduler(vault);
  startOutlookScheduler(vault);
  if (vault.config.git.autoCommit) {
    const git = gitFor(vaultRoot);
    void git.ensureRepo().then((ok) => {
      if (ok) {
        startAutoCommit(git, vault.config.git.intervalMinutes, () => vault.changeSeq);
        console.log(`git auto-commit every ${vault.config.git.intervalMinutes}m`);
      } else {
        console.log('git not available — vault history disabled');
      }
    });
  }
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
      const isFile = (f: string) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      };
      if (url.pathname === '/' || !isFile(file)) file = join(uiDir, 'index.html');
      const body = readFileSync(file);
      return c.body(body, 200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        ...(file.endsWith('index.html')
          ? { 'Cache-Control': 'no-cache' }
          : { 'Cache-Control': 'public, max-age=31536000, immutable' }),
      });
    });
  }
  return (req) => app.fetch(req);
}
