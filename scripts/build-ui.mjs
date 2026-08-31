// Rollup/Vite-free UI build for restricted machines: esbuild only.
// Produces dist/ui/index.html + assets/index.js + assets/index.css.

import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist/ui/assets', { recursive: true });

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

writeFileSync(
  'dist/ui/index.html',
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>corpoBrain</title>
    <link rel="stylesheet" href="/assets/index.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="/assets/index.js"></script>
  </body>
</html>
`,
);
console.log('dist/ui written (esbuild)');
