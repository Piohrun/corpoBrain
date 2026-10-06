/**
 * Startup before the vault is open: the server listens at once and answers
 * every page with a loading screen that waits for /api/boot, so the browser
 * never sees a connection error or a half-ready app while the index catches up.
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The app's logo, inline: a request for /favicon.svg would wait for the index too. */
const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#5b6ee1"/><path d="M16 8C14 4 9 5 9 9C5 9 4 13 6.5 16C3.5 19 5.5 23 9 23C9 27 14 28 16 24C18 28 23 27 23 23C26.5 23 28.5 19 25.5 16C28 13 27 9 23 9C23 5 18 4 16 8Z" fill="#fff"/><path d="M16 8V24M9 9V12A3 3 0 0 0 12 15M9 23V21A3 3 0 0 1 12 18M16 13H20V10M16 20H22V17" fill="none" stroke="#5b6ee1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><g fill="#5b6ee1"><circle cx="20" cy="10" r="1.5"/><circle cx="22" cy="17" r="1.5"/></g></svg>`;

/** Self-contained: no request may depend on the server being free. */
export function loadingPage(vaultRoot: string): string {
  const name = escapeHtml(basename(vaultRoot) || vaultRoot);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>corpoBrain</title>
<style>
:root { --bg: #fafaf8; --fg: #1d1d1b; --muted: #6f6f68; --accent: #5b6ee1; --track: #e7e7e2; --danger: #c0392b; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #1e1e20; --fg: #e4e4e0; --muted: #96968e; --accent: #8b9cf0; --track: #2e2e32; --danger: #e07060; }
}
:root[data-theme="dark"] { --bg: #1e1e20; --fg: #e4e4e0; --muted: #96968e; --accent: #8b9cf0; --track: #2e2e32; --danger: #e07060; }
html, body { height: 100%; }
body { margin: 0; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px system-ui, "Segoe UI", sans-serif; }
.box { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 16px; text-align: center; max-width: 420px; }
.logo { width: 56px; height: 56px; animation: pulse 1.8s ease-in-out infinite; }
h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.bar { width: 220px; height: 3px; border-radius: 2px; background: var(--track); overflow: hidden; position: relative; }
.bar::after { content: ""; position: absolute; top: 0; bottom: 0; width: 40%; background: var(--accent); border-radius: 2px; animation: slide 1.3s ease-in-out infinite; }
.status { color: var(--muted); font-size: 13px; min-height: 1.4em; font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: 12px; line-height: 1.5; }
.error { color: var(--danger); font-size: 13px; white-space: pre-wrap; text-align: left; }
.failed .bar, .failed .logo { animation: none; }
.failed .bar::after { display: none; }
@keyframes slide { from { left: -40%; } to { left: 100%; } }
@keyframes pulse { 50% { transform: scale(0.93); opacity: 0.8; } }
@media (prefers-reduced-motion: reduce) { .logo, .bar::after { animation: none; } .bar::after { left: 30%; } }
</style>
<script>try { var t = localStorage.getItem('cb.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}</script>
</head>
<body>
<main class="box" role="status" aria-live="polite">
${LOGO}
<h1>corpoBrain</h1>
<div class="bar"></div>
<div class="status" id="status">Opening ${name}…</div>
<div class="hint" id="hint" hidden>The first start after an update re-reads every note; on a large vault this can take a minute. Later starts only look at what changed.</div>
</main>
<script>
(function () {
  var started = Date.now();
  var status = document.getElementById('status');
  var hint = document.getElementById('hint');
  var done = false;
  var tick = setInterval(function () {
    var s = Math.round((Date.now() - started) / 1000);
    if (s >= 2) status.textContent = 'Indexing ${name}… ' + s + ' s';
    if (s >= 10) hint.hidden = false;
  }, 500);
  function fail(message) {
    done = true;
    clearInterval(tick);
    document.body.classList.add('failed');
    status.textContent = 'corpoBrain could not open ${name}';
    hint.hidden = false;
    hint.className = 'error';
    hint.textContent = message + '\\n\\nThe console window has the details.';
  }
  function poll() {
    if (done) return;
    fetch('/api/boot', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (b.ready) { done = true; location.reload(); }
        else if (b.error) fail(b.error);
        else setTimeout(poll, 250);
      })
      .catch(function () { setTimeout(poll, 1000); });
  }
  poll();
})();
</script>
</body>
</html>
`;
}

type Fetch = (req: Request) => Response | Promise<Response>;

/**
 * The handler while the vault opens: /api/boot reports progress (or the
 * error that stopped it), other API calls are told to wait, pages get the
 * loading screen. `onPage` fires when a browser has received it.
 */
export function bootHandler(
  vaultRoot: string,
  state: () => { error: string | null },
  onPage: () => void,
): Fetch {
  const page = loadingPage(vaultRoot);
  return (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === '/api/boot') {
      const { error } = state();
      return Response.json({ ready: false, error }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (pathname.startsWith('/api/'))
      return Response.json({ error: 'corpoBrain is starting' }, { status: 503 });
    if (req.method === 'GET' && !/\.[a-z0-9]+$/i.test(pathname)) onPage();
    return new Response(page, {
      status: pathname.includes('.') ? 404 : 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  };
}

/** The default browser on this machine; failures are only logged. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    child.on('error', (e) => console.log(`could not open a browser (${e.message}); open ${url}`));
    child.unref();
  } catch (e) {
    console.log(`could not open a browser (${(e as Error).message}); open ${url}`);
  }
}
