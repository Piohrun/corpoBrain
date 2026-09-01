import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `cb-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, '.corpobrain'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('never hands out the shared defaults object, with or without a file', () => {
    const a = loadConfig(root);
    expect(a).not.toBe(DEFAULT_CONFIG);
    expect(a.jira).not.toBe(DEFAULT_CONFIG.jira);
    a.jira.baseUrl = 'https://mutated';
    a.capacity.unit = 'hours';
    expect(DEFAULT_CONFIG.jira.baseUrl).toBe('');
    expect(DEFAULT_CONFIG.capacity.unit).toBe('days');
    writeFileSync(join(root, '.corpobrain', 'config.json'), '{"jira":{"baseUrl":"https://x"}}');
    const b = loadConfig(root);
    expect(b.jira.baseUrl).toBe('https://x');
    // sections absent from the file are copies too, not the default objects
    expect(b.capacity).not.toBe(DEFAULT_CONFIG.capacity);
    expect(b.capacity.unit).toBe('days');
  });

  it('reports a broken file instead of silently using defaults', () => {
    writeFileSync(join(root, '.corpobrain', 'config.json'), '{ not json');
    const warnings: string[] = [];
    const cfg = loadConfig(root, (m) => warnings.push(m));
    expect(cfg.jira.baseUrl).toBe('');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('config.json');
    writeFileSync(join(root, '.corpobrain', 'config.json'), '[1,2]');
    expect(() => loadConfig(root, (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toHaveLength(2);
  });
});
