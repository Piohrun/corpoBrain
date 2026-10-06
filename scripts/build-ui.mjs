// Rollup/Vite-free UI build for restricted machines: esbuild only.
// Content-hashed asset names so browsers can never serve a stale bundle.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// the page is packages/ui/index.html (splash included) with the bundles swapped in
const template = readFileSync('packages/ui/index.html', 'utf8');
const devScript = '<script type="module" src="/src/main.tsx"></script>';
if (!template.includes(devScript) || !template.includes('</head>'))
  throw new Error('packages/ui/index.html no longer has the expected script tag or </head>');
writeFileSync(
  'dist/ui/index.html',
  template
    .replace(devScript, `<script type="module" src="/assets/${js}"></script>`)
    .replace(
      '</head>',
      css ? `  <link rel="stylesheet" href="/assets/${css}" />\n  </head>` : '</head>',
    ),
);
console.log(`dist/ui written (esbuild, ${js}, ${outputs.length} files)`);
