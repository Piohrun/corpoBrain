// Rollup/Vite-free UI build for restricted machines: esbuild only.
// Content-hashed asset names so browsers can never serve a stale bundle.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist/ui/assets', { recursive: true });
// drop old bundles so dist only ever contains the current pair
for (const f of readdirSync('dist/ui/assets')) {
  if (/^index[-.].*\.(js|css)$/.test(f)) rmSync(`dist/ui/assets/${f}`);
}

await build({
  entryPoints: ['packages/ui/src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'dist/ui/assets/index.js',
  logLevel: 'info',
});

const hash = createHash('sha256')
  .update(readFileSync('dist/ui/assets/index.js'))
  .digest('hex')
  .slice(0, 8);
renameSync('dist/ui/assets/index.js', `dist/ui/assets/index-${hash}.js`);
try {
  renameSync('dist/ui/assets/index.css', `dist/ui/assets/index-${hash}.css`);
} catch {
  /* no css emitted */
}

writeFileSync(
  'dist/ui/index.html',
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>corpoBrain</title>
    <link rel="stylesheet" href="/assets/index-${hash}.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/assets/index-${hash}.js"></script>
  </body>
</html>
`,
);
console.log(`dist/ui written (esbuild, assets index-${hash}.*)`);
