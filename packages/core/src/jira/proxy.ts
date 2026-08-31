/**
 * Proxy-aware fetch replacement for the Jira adapter. Node's built-in fetch
 * ignores HTTP(S)_PROXY, which strands corporate users whose Jira is only
 * reachable through a forward proxy. This implements the two classic modes
 * with node:http/node:https/node:tls only (no dependencies):
 *   - https:// targets → CONNECT tunnel through the proxy, then TLS
 *   - http:// targets  → absolute-form request straight to the proxy
 * TLS trust follows Node's normal rules (NODE_EXTRA_CA_CERTS, --use-system-ca).
 * Returns real Response objects so the adapter code is unchanged.
 */
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import tls from 'node:tls';
import type { FetchFn } from './adapter.ts';

function proxyAuthHeader(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'Proxy-Authorization': `Basic ${Buffer.from(cred).toString('base64')}` };
}

function openTunnel(
  proxy: URL,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 8080,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...proxyAuthHeader(proxy) },
      ...(signal ? { signal } : {}),
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT: HTTP ${res.statusCode ?? '?'}`));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

function toHeaderRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(h)) {
    for (const pair of h) {
      if (pair[0] !== undefined && pair[1] !== undefined) out[pair[0]] = pair[1];
    }
  } else {
    Object.assign(out, h);
  }
  return out;
}

function runRequest(req: http.ClientRequest, signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(', '));
        }
        const status = res.statusCode ?? 502;
        resolve(
          new Response(status === 204 ? null : Buffer.concat(chunks), {
            status,
            statusText: res.statusMessage ?? '',
            headers,
          }),
        );
      });
      res.on('error', reject);
    });
    req.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    req.end();
  });
}

/** A fetch-compatible function that routes everything through `proxyUrl`. */
export function createProxyFetch(proxyUrl: string): FetchFn {
  const proxy = new URL(proxyUrl);
  const proxyFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const signal = init?.signal ?? undefined;
    const headers = toHeaderRecord(init);
    const method = init?.method ?? 'GET';

    if (url.protocol === 'http:') {
      // absolute-form via the proxy
      const req = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 8080,
        method,
        path: url.href,
        headers: { ...headers, Host: url.host, ...proxyAuthHeader(proxy) },
      });
      return runRequest(req, signal ?? undefined);
    }

    const port = Number(url.port) || 443;
    const socket = await openTunnel(proxy, url.hostname, port, signal ?? undefined);
    const req = https.request({
      host: url.hostname,
      port,
      method,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: url.host },
      createConnection: () => tls.connect({ socket, servername: url.hostname }),
    });
    return runRequest(req, signal ?? undefined);
  };
  return proxyFetch as FetchFn;
}

/** Resolve the proxy to use: explicit config first, then standard env vars. */
export function resolveProxyUrl(configured: string | undefined): string | null {
  const candidate =
    configured?.trim() ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (!candidate) return null;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return null;
  }
}
