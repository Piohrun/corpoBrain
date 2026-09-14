import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { JiraSyncService, syncService } from '../src/jira-sync-service.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;
let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;
const token = 'SECRET-TOKEN-123456';
beforeEach(() => {
  for (const name of [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'CORPOBRAIN_JIRA_TOKEN',
    'CORPOBRAIN_JIRA_EMAIL',
  ])
    vi.stubEnv(name, '');
  root = mkdtempSync(join(tmpdir(), 'cb-jobs-'));
  vault = new VaultService(root, ':memory:');
  vault.config.jira.baseUrl = 'https://jira.test';
  vault.config.jira.deployment = 'datacenter';
  vault.config.jira.profiles = [
    {
      name: 'team',
      jql: 'project = EXEC',
      folder: 'jira',
      boards: [],
      intervalMinutes: 0,
      futureSprints: 0,
    },
  ];
  vault.saveJiraSecrets({ token });
  fetchFn = vi.fn<typeof fetch>(async (input) =>
    new URL(String(input)).pathname.endsWith('/field')
      ? Response.json([])
      : Response.json({ total: 1, issues: [{ key: 'EXEC-1', fields: { summary: 'One' } }] }),
  );
  vi.stubGlobal('fetch', fetchFn);
  app = createApp(vault);
});
afterEach(async () => {
  const service = syncService(vault);
  if (service.status.runId) {
    service.cancel(service.status.runId);
    await vi.waitFor(() => expect(service.status.syncing).toBe(false));
  }
  vault.stop();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('server-owned Jira jobs', () => {
  it('starts asynchronously, preserves results across restart, and bounds history', async () => {
    const res = await app.request('/api/jira/sync/start', { method: 'POST', body: '{}' });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const service = syncService(vault);
    await vi.waitFor(() => expect(service.status.syncing).toBe(false));
    expect(service.history[0]).toMatchObject({
      id,
      outcome: 'success',
      retries: 0,
      reports: [expect.objectContaining({ fetched: 1 })],
    });
    expect(vault.indexer.db.prepare('SELECT key FROM jira').all()).toEqual([{ key: 'EXEC-1' }]);
    const restarted = new JiraSyncService(vault);
    expect(restarted.status).toMatchObject({
      syncing: false,
      lastRun: { id, outcome: 'success' },
      lastReports: [expect.objectContaining({ fetched: 1 })],
    });
    // Fast completed runs retain only the newest 20 entries on disk.
    for (let i = 0; i < 21; i++) await restarted.start().completion;
    expect(restarted.history).toHaveLength(20);
    const stored = readFileSync(join(root, '.corpobrain/jira-cache/sync-history.json'), 'utf8');
    expect(JSON.parse(stored)).toHaveLength(20);
    expect(stored).not.toContain(token);
  });

  it.each(['request', 'backoff'])(
    'cancels a pending %s, prevents overlaps, and allows the next run',
    async (where) => {
      fetchFn.mockImplementation(async (input, init) => {
        if (String(input).includes('/field')) return Response.json([]);
        if (where === 'backoff')
          return new Response('busy', { status: 429, headers: { 'Retry-After': '30' } });
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
      });
      const res = await app.request('/api/jira/sync/start', { method: 'POST', body: '{}' });
      const { id } = (await res.json()) as { id: string };
      const service = syncService(vault);
      await vi.waitFor(() =>
        expect(where === 'backoff' ? service.history[0]?.retries : fetchFn.mock.calls.length).toBe(
          where === 'backoff' ? 1 : 2,
        ),
      );
      // Another app view reconnects to the same job.
      const otherView = createApp(vault);
      expect(await (await otherView.request('/api/jira/status')).json()).toMatchObject({
        syncing: true,
        runId: id,
      });
      expect(
        (await otherView.request('/api/jira/sync/start', { method: 'POST', body: '{}' })).status,
      ).toBe(409);
      expect(
        (
          await otherView.request('/api/jira/sync/cancel', {
            method: 'POST',
            body: JSON.stringify({ id }),
          })
        ).status,
      ).toBe(200);
      await vi.waitFor(() => expect(service.status.syncing).toBe(false));
      expect(service.history[0]).toMatchObject({ outcome: 'cancelled', error: null });
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(existsSync(join(root, '.corpobrain/jira-cache/state.json'))).toBe(false);
      fetchFn.mockImplementation(async (input) =>
        String(input).includes('/field')
          ? Response.json([])
          : Response.json({ total: 0, issues: [] }),
      );
      const next = service.start();
      expect(() => service.cancel(id)).toThrow('no longer running');
      await next.completion;
      expect(service.history[0]?.outcome).toBe('success');
    },
  );

  it('keeps completed profiles indexed when the next profile fails, and redacts errors', async () => {
    vault.config.jira.profiles.push({
      name: 'other',
      jql: 'project = OTHER',
      folder: 'jira',
      boards: [],
      intervalMinutes: 0,
      futureSprints: 0,
    });
    fetchFn.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/field')) return Response.json([]);
      if (url.searchParams.get('jql')?.includes('OTHER'))
        return new Response(`refused ${token}`, { status: 403 });
      return Response.json({ total: 1, issues: [{ key: 'EXEC-1', fields: { summary: 'One' } }] });
    });
    const service = syncService(vault);
    await expect(service.start().completion).rejects.toThrow(/403/);
    expect(service.history[0]).toMatchObject({
      outcome: 'failed',
      reports: [expect.objectContaining({ profile: 'team', fetched: 1 })],
    });
    expect(service.history[0]?.error).toContain('[redacted]');
    expect(JSON.stringify(service.history)).not.toContain(token);
    expect(vault.indexer.db.prepare('SELECT key FROM jira').all()).toEqual([{ key: 'EXEC-1' }]);
    const state = JSON.parse(readFileSync(join(root, '.corpobrain/jira-cache/state.json'), 'utf8'));
    expect(Object.keys(state.lastSyncAt)).toEqual(['team']);
  });

  it('marks a persisted running job as interrupted and leaves no lock after restart', async () => {
    const service = syncService(vault);
    await service.start().completion;
    const unfinished = { ...service.history[0], outcome: 'running', finishedAt: null };
    writeFileSync(
      join(root, '.corpobrain/jira-cache/sync-history.json'),
      JSON.stringify([unfinished]),
    );
    const restarted = new JiraSyncService(vault);
    expect(restarted.status).toMatchObject({
      syncing: false,
      runId: null,
      lastRun: { outcome: 'interrupted' },
      lastSyncError: expect.stringContaining('Server stopped'),
    });
    await restarted.start().completion;
    expect(restarted.history[0]?.outcome).toBe('success');
  });
});
