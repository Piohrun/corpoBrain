import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  root = join(tmpdir(), `cb-jc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('jira settings API', () => {
  it('GET returns sanitized defaults', async () => {
    const cfg = (await (await app.request('/api/jira/config')).json()) as Record<string, unknown>;
    expect(cfg).toMatchObject({ baseUrl: '', tokenSet: false, profiles: [] });
    expect(JSON.stringify(cfg)).not.toContain('token"');
  });

  it('PUT persists config.json, token to secrets (0600, never echoed)', async () => {
    const res = await app.request('/api/jira/config', {
      method: 'PUT',
      body: JSON.stringify({
        baseUrl: 'https://jira.example.com/',
        auth: 'bearer',
        projectKeys: ['exec', 'bad key!'],
        estimateField: 'customfield_10016',
        token: 'SEKRET',
        profiles: [{ name: 'team', jql: 'project = EXEC', boards: [7, 'x'], intervalMinutes: 15 }],
      }),
    });
    expect(res.status).toBe(200);
    const cfg = (await res.json()) as Record<string, unknown>;
    expect(cfg).toMatchObject({
      baseUrl: 'https://jira.example.com',
      projectKeys: ['EXEC'],
      tokenSet: true,
      profiles: [{ name: 'team', folder: 'jira', boards: [7], futureSprints: 3 }],
    });
    expect(JSON.stringify(cfg)).not.toContain('SEKRET');
    const onDisk = JSON.parse(readFileSync(join(root, '.corpobrain', 'config.json'), 'utf8'));
    expect(onDisk.jira.baseUrl).toBe('https://jira.example.com');
    expect(JSON.stringify(onDisk)).not.toContain('SEKRET');
    const secrets = JSON.parse(readFileSync(join(root, '.corpobrain', 'secrets.json'), 'utf8'));
    expect(secrets.jiraToken).toBe('SEKRET');
    // live config updated: status now reports configured
    const status = (await (await app.request('/api/jira/status')).json()) as {
      configured: boolean;
    };
    expect(status.configured).toBe(true);
    // a config reload from disk agrees
    const fresh = new VaultService(root, ':memory:');
    expect(fresh.config.jira.projectKeys).toEqual(['EXEC']);
    fresh.stop();
  });

  it('empty token in PUT keeps the existing secret', async () => {
    await app.request('/api/jira/config', {
      method: 'PUT',
      body: JSON.stringify({ token: 'FIRST' }),
    });
    await app.request('/api/jira/config', {
      method: 'PUT',
      body: JSON.stringify({ baseUrl: 'https://x.y', token: '' }),
    });
    const secrets = JSON.parse(readFileSync(join(root, '.corpobrain', 'secrets.json'), 'utf8'));
    expect(secrets.jiraToken).toBe('FIRST');
  });

  it('probe without credentials fails with 502', async () => {
    expect(existsSync(join(root, '.corpobrain', 'secrets.json'))).toBe(false);
    const res = await app.request('/api/jira/probe', { method: 'POST' });
    expect(res.status).toBe(502);
  });
});
