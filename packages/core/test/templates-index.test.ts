import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Indexer } from '../src/indexer.ts';

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `cb-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'templates'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('templates in the index', () => {
  it('reads {{placeholders}} as strings instead of YAML flow mappings', () => {
    writeFileSync(
      join(root, 'templates', 'meeting.md'),
      '---\ntype: meeting\ntitle: "{{title}}"\ndate: {{date}}\nattendees: []\n---\n\n# {{title}}\n',
    );
    const warnings: unknown[] = [];
    const onWarn = (w: unknown) => warnings.push(w);
    process.on('warning', onWarn);
    const idx = new Indexer(root, structuredClone(DEFAULT_CONFIG), openDb(':memory:'));
    idx.update();
    process.off('warning', onWarn);
    const row = idx.db
      .prepare('SELECT frontmatter_json, frontmatter_error FROM notes WHERE path = ?')
      .get('templates/meeting.md') as { frontmatter_json: string; frontmatter_error: number };
    expect(row.frontmatter_error).toBe(0);
    expect(JSON.parse(row.frontmatter_json).date).toBe('{{date}}');
    expect(warnings.filter((w) => String(w).includes('stringified'))).toHaveLength(0);
  });
});
