import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { JiraAdapter, JiraError } from '../src/jira/adapter.ts';
import { createProxyFetch } from '../src/jira/proxy.ts';
import { JiraSync } from '../src/jira/sync.ts';

const auth = { mode: 'bearer' as const, token: 'private-token' };
const json = (body: unknown) => Response.json(body);
const timeout = () => new DOMException('Timed out', 'TimeoutError');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Jira read retries', () => {
  it.each(['datacenter', 'cloud'] as const)(
    '%s: retries only the failed page and completes a 290-issue sync without duplicates',
    async (deployment) => {
      vi.useFakeTimers();
      const root = mkdtempSync(join(tmpdir(), 'cb-retry-'));
      const config = structuredClone(DEFAULT_CONFIG);
      config.jira.profiles = [
        {
          name: 'team',
          jql: 'project = TEST',
          folder: 'jira',
          boards: [],
          intervalMinutes: 0,
          futureSprints: 0,
        },
      ];
      const offsets: number[] = [];
      const signals = new Set<AbortSignal>();
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/field')) return json([]);
        const offset = Number(
          url.searchParams.get('startAt') ?? url.searchParams.get('nextPageToken') ?? 0,
        );
        offsets.push(offset);
        signals.add(init?.signal as AbortSignal);
        expect(url.searchParams.get('maxResults')).toBe('50');
        expect(url.searchParams.get('expand')).toBe('changelog');
        expect(url.searchParams.get('fields')?.split(',')).not.toContain('comment');
        if (offset === 200 && offsets.filter((n) => n === 200).length === 1) throw timeout();
        const issues = Array.from({ length: Math.min(50, 290 - offset) }, (_, i) => ({
          key: `TEST-${offset + i + 1}`,
          fields: { summary: 'Issue' },
        }));
        return json({
          issues,
          total: 290,
          startAt: offset,
          ...(offset + 50 < 290 ? { nextPageToken: String(offset + 50) } : {}),
        });
      };
      try {
        const adapter = new JiraAdapter('https://jira.test', auth, deployment, fetchFn);
        const retries: string[] = [];
        adapter.onRetry = (detail) => retries.push(detail);
        const sync = new JiraSync(root, config, adapter);
        const progress: number[] = [];
        sync.onProgress = (p) => {
          if (p.phase === 'search') progress.push(p.current);
        };
        const pending = sync.run();
        await vi.runAllTimersAsync();
        const [report] = await pending;
        expect(offsets).toEqual([0, 50, 100, 150, 200, 200, 250]);
        expect(signals.size).toBe(offsets.length);
        expect(retries).toHaveLength(1);
        expect(retries[0]).toContain('attempt 2/3');
        expect(progress).toEqual([0, 50, 100, 150, 200, 250, 290, 290]);
        expect(report?.created).toHaveLength(290);
        expect(new Set(report?.created).size).toBe(290);
        expect(readdirSync(join(root, 'jira'))).toHaveLength(290);
        expect(
          JSON.parse(readFileSync(join(root, '.corpobrain/jira-cache/state.json'), 'utf8'))
            .lastSyncAt.team,
        ).toBeTruthy();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('honors Retry-After seconds and HTTP dates while backing off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
    const start = Date.now();
    const times: number[] = [];
    const responses = [
      new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }),
      new Response('limited', {
        status: 429,
        headers: { 'Retry-After': new Date(start + 5000).toUTCString() },
      }),
      json({ version: '10' }),
    ];
    const adapter = new JiraAdapter('https://jira.test', auth, 'datacenter', async () => {
      times.push(Date.now() - start);
      return responses.shift() as Response;
    });
    const pending = adapter.probe();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ version: '10' });
    expect(times).toEqual([0, 2000, 5000]);
  });

  it('reports the failed page and timing after the retry limit, without saving a watermark', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'cb-retry-fail-'));
    const config = structuredClone(DEFAULT_CONFIG);
    config.jira.profiles = [
      {
        name: 'team',
        jql: 'project = PRIVATE',
        folder: 'jira',
        boards: [],
        intervalMinutes: 0,
        futureSprints: 0,
      },
    ];
    const calls: number[] = [];
    const adapter = new JiraAdapter('https://jira.test', auth, 'datacenter', async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/field')) return json([]);
      const offset = Number(url.searchParams.get('startAt'));
      calls.push(offset);
      if (offset === 50) throw timeout();
      return json({
        issues: Array.from({ length: 50 }, (_, i) => ({ key: `TEST-${i + 1}`, fields: {} })),
        total: 100,
      });
    });
    try {
      const pending = new JiraSync(root, config, adapter).run().catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toBeInstanceOf(JiraError);
      expect((error as Error).message).toMatch(
        /search page 2, startAt=50, maxResults=50.*3 attempts.*3.0s elapsed.*limit 60s/,
      );
      expect((error as Error).message).not.toMatch(/PRIVATE|private-token|silently dropped/);
      expect(calls).toEqual([0, 50, 50, 50]);
      expect(existsSync(join(root, '.corpobrain/jira-cache/state.json'))).toBe(false);
      expect(readdirSync(join(root, '.corpobrain/jira-cache/issues'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([400, 401, 403, 404, 429])(
    'does not retry permanent errors or long cooldowns (HTTP %s)',
    async (status) => {
      const fetchFn = vi.fn<typeof fetch>(
        async () => new Response('no', { status, headers: { 'Retry-After': '120' } }),
      );
      const adapter = new JiraAdapter('https://jira.test', auth, 'datacenter', fetchFn);
      await expect(adapter.probe()).rejects.toMatchObject({ status });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry malformed JSON', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('not JSON'));
    const adapter = new JiraAdapter('https://jira.test', auth, 'datacenter', fetchFn);
    await expect(adapter.probe()).rejects.toThrow(/serverInfo.*1 attempt/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps configured page sizes and explicitly requested comments', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => json({ issues: [], total: 0 }));
    const adapter = new JiraAdapter('https://jira.test', auth, 'datacenter', fetchFn, 120_000, 25);
    await adapter.search('project = TEST', [], undefined, { comments: true });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(url.searchParams.get('maxResults')).toBe('25');
    expect(url.searchParams.get('fields')?.split(',')).toContain('comment');
    expect(url.searchParams.get('expand')).toBe('changelog');
  });

  it.each(['network', '503'])('never retries Jira writes after a %s failure', async (failure) => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      if (failure === 'network') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return new Response('busy', { status: 503 });
    });
    const adapter = new JiraAdapter('https://jira.test', auth, 'datacenter', fetchFn);
    await expect(adapter.moveIssuesToBacklog(['TEST-1'])).rejects.toBeInstanceOf(JiraError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('real response body timeouts', () => {
  it.each(['direct', 'proxy'])(
    '%s: retries a stalled body even after HTTP 200 headers arrive',
    async (route) => {
      let requests = 0;
      const server = http.createServer((_req, res) => {
        requests++;
        res.setHeader('content-type', 'application/json');
        if (requests === 1) {
          res.writeHead(200);
          res.write('{');
          return;
        }
        res.end(JSON.stringify({ version: '10' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      try {
        const adapter = new JiraAdapter(
          base,
          auth,
          'datacenter',
          route === 'proxy' ? createProxyFetch(base) : fetch,
          100,
        );
        await expect(adapter.probe()).resolves.toMatchObject({ version: '10' });
        expect(requests).toBe(2);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
