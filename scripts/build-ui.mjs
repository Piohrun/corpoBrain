// Rollup/Vite-free UI build for restricted machines: esbuild only.
// Content-hashed asset names so browsers can never serve a stale bundle.

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist/ui/assets', { recursive: true });
copyFileSync('packages/ui/public/favicon.svg', 'dist/ui/favicon.svg');
// drop old bundles so dist only ever contains the current build
for (const f of readdirSync('dist/ui/assets')) {
  if (/^(index|chunk)[-.].*\.(js|css)$/.test(f)) rmSync(`dist/ui/assets/${f}`);
}

// ESM with code splitting: pages other than Notes load on first use. Names
// carry esbuild's content hash.
const result = await build({
  entryPoints: { index: 'packages/ui/src/main.tsx' },
  bundle: true,
  minify: true,
  format: 'esm',
  splitting: true,
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outdir: 'dist/ui/assets',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  metafile: true,
  logLevel: 'info',
});

const outputs = Object.entries(result.metafile.outputs);
const asset = (path) => path.replace(/^dist\/ui\/assets\//, '');
const entry = outputs.find(([, o]) => o.entryPoint === 'packages/ui/src/main.tsx');
if (!entry) throw new Error('esbuild produced no entry bundle');
const js = asset(entry[0]);
const css = entry[1].cssBundle ? asset(entry[1].cssBundle) : null;

writeFileSync(
  'dist/ui/index.html',
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2" />
    <title>corpoBrain</title>
    ${css ? `<link rel="stylesheet" href="/assets/${css}" />` : ''}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/${js}"></script>
  </body>
</html>
`,
);
console.log(`dist/ui written (esbuild, ${js}, ${outputs.length} files)`);
