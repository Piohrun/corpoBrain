import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { VaultService } from '../src/vault-service.ts';

// the smallest valid PNG (1×1)
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
);

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  root = join(tmpdir(), `cb-att-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'notes', 'sub'), { recursive: true });
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(join(root, 'notes', 'a.md'), '# A\n\n![[shot.png]]\n![[Missing note]]\n');
  writeFileSync(join(root, 'notes', 'sub', 'local.png'), PNG);
  writeFileSync(join(root, 'private', 'secret.png'), PNG);
  writeFileSync(join(root, 'notes', 'evil.svg'), '<svg onload="alert(1)"/>');
  vault = new VaultService(root, ':memory:');
  vault.indexer.rebuild();
  app = createApp(vault);
});
afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

const upload = (body: Uint8Array, type: string, query = '') =>
  app.request(`/api/attachments${query}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
  });
const resolve = async (ref: string, from = 'notes/a.md') => {
  const r = await app.request(
    `/api/attachments/resolve?ref=${encodeURIComponent(ref)}&from=${encodeURIComponent(from)}`,
  );
  return r.status === 200 ? ((await r.json()) as { path: string }).path : r.status;
};

describe('images in notes', () => {
  it('saves a pasted image under attachments/ with a unique Obsidian-style name', async () => {
    const first = await upload(PNG, 'image/png');
    expect(first.status).toBe(201);
    const { path, name } = (await first.json()) as { path: string; name: string };
    expect(name).toMatch(/^Pasted image \d{14}\.png$/);
    expect(readFileSync(join(root, path))).toEqual(Buffer.from(PNG));
    const named = (await (await upload(PNG, 'image/png', '?name=Q4%2Fplan:v2.png')).json()) as {
      name: string;
    };
    expect(named.name).toBe('Q4 plan v2.png');
    const again = (await (await upload(PNG, 'image/png', '?name=Q4 plan v2')).json()) as {
      name: string;
    };
    expect(again.name).toBe('Q4 plan v2 2.png');
  });

  it('refuses non-images, SVG uploads and empty bodies', async () => {
    expect((await upload(PNG, 'image/svg+xml')).status).toBe(415);
    expect((await upload(PNG, 'text/html')).status).toBe(415);
    expect((await upload(new Uint8Array(), 'image/png')).status).toBe(400);
  });

  it('resolves embeds like Obsidian: relative, root, attachments, then anywhere by name', async () => {
    const { name } = (await (await upload(PNG, 'image/png', '?name=shot')).json()) as {
      name: string;
    };
    expect(await resolve(name)).toBe('attachments/shot.png');
    expect(await resolve('sub/local.png')).toBe('notes/sub/local.png');
    expect(await resolve('notes/sub/local.png', 'daily/x.md')).toBe('notes/sub/local.png');
    expect(await resolve('local.png', 'daily/x.md')).toBe('notes/sub/local.png');
    expect(await resolve('sub/local%20x.png')).toBe(404);
    expect(await resolve('https://example.com/a.png')).toBe(404);
    expect(await resolve('../../etc/x.png')).toBe(404);
    expect(await resolve('secret.png')).toBe(404); // protected notes stay out
  });

  it('serves images with a sandboxing CSP, never notes or protected files', async () => {
    const ok = await app.request('/api/attachments/file?path=notes/sub/local.png');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    const svg = await app.request('/api/attachments/file?path=notes/evil.svg');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await app.request('/api/attachments/file?path=notes/a.md')).status).toBe(400);
    expect((await app.request('/api/attachments/file?path=private/secret.png')).status).toBe(403);
    const etag = ok.headers.get('etag') as string;
    const cached = await app.request('/api/attachments/file?path=notes/sub/local.png', {
      headers: { 'If-None-Match': etag },
    });
    expect(cached.status).toBe(304);
  });

  it('does not list embedded images as missing notes', () => {
    expect(vault.indexer.unresolved().map((u) => u.target)).toEqual(['Missing note']);
  });
});
