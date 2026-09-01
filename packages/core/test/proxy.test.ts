import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxyFetch, resolveProxyUrl } from '../src/jira/proxy.ts';

let target: http.Server;
let proxy: http.Server;
let targetPort = 0;
let proxyPort = 0;
const proxied: string[] = [];

beforeAll(async () => {
  target = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          path: req.url,
          method: req.method,
          auth: req.headers.authorization ?? null,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
  });
  proxy = http.createServer((req, res) => {
    // absolute-form http proxying
    proxied.push(`${req.method} ${req.url}`);
    const url = new URL(req.url as string);
    const fwd = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(fwd);
  });
  proxy.on('connect', (req, socket: net.Socket) => {
    proxied.push(`CONNECT ${req.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); // we only test the handshake path here
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as net.AddressInfo).port;
  proxyPort = (proxy.address() as net.AddressInfo).port;
});

afterAll(() => {
  target.close();
  proxy.close();
});

describe('createProxyFetch', () => {
  it('routes http targets through the proxy in absolute form, preserving headers', async () => {
    const pf = createProxyFetch(`http://127.0.0.1:${proxyPort}`);
    const res = await pf(`http://127.0.0.1:${targetPort}/rest/api/2/serverInfo?x=1`, {
      headers: { Authorization: 'Bearer T' },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { path: string; auth: string };
    expect(body.path).toBe('/rest/api/2/serverInfo?x=1');
    expect(body.auth).toBe('Bearer T');
    expect(proxied.some((l) => l.includes(`GET http://127.0.0.1:${targetPort}/rest`))).toBe(true);
  });

  it('forwards PUT/POST bodies (write-back goes through the proxy too)', async () => {
    const pf = createProxyFetch(`http://127.0.0.1:${proxyPort}`);
    const payload = JSON.stringify({ fields: { assignee: { name: 'jdoe' } } });
    const res = await pf(`http://127.0.0.1:${targetPort}/rest/api/2/issue/EXEC-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    expect(res.ok).toBe(true);
    const echo = (await res.json()) as { method: string; body: string };
    expect(echo.method).toBe('PUT');
    expect(echo.body).toBe(payload);
  });

  it('https targets attempt a CONNECT tunnel and surface proxy refusals', async () => {
    const pf = createProxyFetch(`http://127.0.0.1:${proxyPort}`);
    await expect(pf('https://blocked.example.com/x')).rejects.toThrow(/CONNECT: HTTP 403/);
    expect(proxied.some((l) => l === 'CONNECT blocked.example.com:443')).toBe(true);
  });

  it('honours abort signals', async () => {
    const pf = createProxyFetch(`http://127.0.0.1:${proxyPort}`);
    await expect(
      pf(`http://127.0.0.1:${targetPort}/slow`, { signal: AbortSignal.timeout(1) }),
    ).rejects.toThrow();
  });
});

describe('resolveProxyUrl', () => {
  it('prefers explicit config, falls back to env, rejects garbage', () => {
    expect(resolveProxyUrl('http://p:1')).toBe('http://p:1');
    expect(resolveProxyUrl('not a url')).toBeNull();
    const old = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://envproxy:8080';
    expect(resolveProxyUrl('')).toBe('http://envproxy:8080');
    if (old === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = old;
  });
});
