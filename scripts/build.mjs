// Bundles the server + core + cli into a single dependency-free file so the
// laptop only needs node.exe and the dist/ folder. UI is built by vite into dist/ui.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['node:*'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['packages/server/src/index.ts'],
  outfile: 'dist/corpobrain.js',
});
await build({
  ...common,
  entryPoints: ['packages/cli/src/index.ts'],
  outfile: 'dist/corpobrain-cli.js',
});
