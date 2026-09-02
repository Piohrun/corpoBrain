import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The work laptop builds with `npm run build:work` after an install WITHOUT
 * devDependencies (vite's rollup is quarantined there). Everything that
 * script needs must therefore be a runtime dependency. This test exists
 * because a "package hygiene" change once moved esbuild and broke that build.
 */
describe('build:work dependencies', () => {
  it('keeps esbuild (and nothing else the work build needs) out of devDependencies', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build:work']).toContain('scripts/build.mjs');
    expect(
      pkg.dependencies?.esbuild,
      'esbuild must stay a runtime dependency for build:work',
    ).toBeDefined();
    expect(pkg.devDependencies?.esbuild).toBeUndefined();
  });
});
