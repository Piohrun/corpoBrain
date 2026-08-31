import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

const json = async (r: Response) => (await r.json()) as never;
const post = (url: string, body: object) =>
  app.request(url, { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  root = join(tmpdir(), `cb-priv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'private'), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('protected notes API', () => {
  it('full lifecycle: init, write, list, search, lock, unlock', async () => {
    expect(await json(await app.request('/api/private/status'))).toEqual({
      initialized: false,
      unlocked: false,
      lockAfterMinutes: 10,
    });
    // locked endpoints refuse before init
    expect((await app.request('/api/private/list')).status).toBe(401);

    expect((await post('/api/private/init', { passphrase: 'a fine passphrase' })).status).toBe(200);
    const w = (await json(
      await app.request('/api/private/note', {
        method: 'PUT',
        body: JSON.stringify({ content: '---\ntitle: Comp round\n---\n\nAnna +10%.\n' }),
      }),
    )) as { file: string };
    expect(w.file).toMatch(/^[0-9a-f]{24}\.md\.enc$/);

    // ciphertext on disk, no plaintext
    const raw = readFileSync(join(root, 'private', w.file));
    expect(raw.subarray(0, 4).toString()).toBe('CBV1');
    expect(raw.includes(Buffer.from('Anna'))).toBe(false);

    const list = (await json(await app.request('/api/private/list'))) as { title: string }[];
    expect(list).toMatchObject([{ title: 'Comp round' }]);
    const hits = (await json(await app.request('/api/private/search?q=Anna'))) as {
      file: string;
    }[];
    expect(hits).toHaveLength(1);

    // the main index knows only an opaque protected row; main search finds nothing
    const mainSearch = (await json(await app.request('/api/search?q=Anna'))) as unknown[];
    expect(mainSearch).toEqual([]);
    const notes = (await json(await app.request('/api/notes'))) as {
      path: string;
      title: string;
    }[];
    const priv = notes.find((n) => n.path.startsWith('private/'));
    expect(priv?.title).toBe('Protected note');

    // lock → everything about content is gone
    await post('/api/private/lock', {});
    expect((await app.request('/api/private/list')).status).toBe(401);
    expect((await app.request(`/api/private/note?file=${w.file}`)).status).toBe(401);
    expect((await app.request('/api/private/search?q=Anna')).status).toBe(401);

    // wrong passphrase refused; right one restores access including FTS
    expect((await post('/api/private/unlock', { passphrase: 'nope nope nope' })).status).toBe(401);
    expect((await post('/api/private/unlock', { passphrase: 'a fine passphrase' })).status).toBe(
      200,
    );
    const note = (await json(await app.request(`/api/private/note?file=${w.file}`))) as {
      content: string;
    };
    expect(note.content).toContain('Anna +10%');
    expect((await json(await app.request('/api/private/search?q=Anna'))) as unknown[]).toHaveLength(
      1,
    );
  });

  it('change passphrase re-wraps without touching note files', async () => {
    await post('/api/private/init', { passphrase: 'first passphrase' });
    await app.request('/api/private/note', {
      method: 'PUT',
      body: JSON.stringify({ content: 'secret body' }),
    });
    const fileBefore = readdirSync(join(root, 'private')).filter((f) => f.endsWith('.enc'));
    const bytesBefore = readFileSync(join(root, 'private', fileBefore[0] as string));
    expect(
      (
        await post('/api/private/change-passphrase', {
          oldPassphrase: 'first passphrase',
          newPassphrase: 'second passphrase',
        })
      ).status,
    ).toBe(200);
    const bytesAfter = readFileSync(join(root, 'private', fileBefore[0] as string));
    expect(bytesAfter.equals(bytesBefore)).toBe(true); // notes not re-encrypted
    await post('/api/private/lock', {});
    expect((await post('/api/private/unlock', { passphrase: 'first passphrase' })).status).toBe(
      401,
    );
    expect((await post('/api/private/unlock', { passphrase: 'second passphrase' })).status).toBe(
      200,
    );
  });

  it('rejects non-opaque filenames', async () => {
    await post('/api/private/init', { passphrase: 'a fine passphrase' });
    expect(
      (
        await app.request('/api/private/note', {
          method: 'PUT',
          body: JSON.stringify({ file: '../notes/escape.md.enc', content: 'x' }),
        })
      ).status,
    ).toBe(400);
    expect((await app.request('/api/private/note?file=..%2Fsecrets')).status).toBe(400);
  });
});

describe('inline note secrets', () => {
  const post = (url: string, body: object) =>
    app.request(url, { method: 'POST', body: JSON.stringify(body) });

  it('locked session refuses; unlocked round-trips; ciphertext leaks nothing', async () => {
    expect((await post('/api/private/encrypt', { text: 'Fixed Pay: 123400' })).status).toBe(401);
    await post('/api/private/init', { passphrase: 'a fine passphrase' });
    const enc = (await (
      await post('/api/private/encrypt', { text: 'Fixed Pay: 123400' })
    ).json()) as { data: string };
    expect(enc.data).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(enc.data, 'base64').includes(Buffer.from('123400'))).toBe(false);
    const dec = (await (await post('/api/private/decrypt', { data: enc.data })).json()) as {
      text: string;
    };
    expect(dec.text).toBe('Fixed Pay: 123400');
    await post('/api/private/lock', {});
    expect((await post('/api/private/decrypt', { data: enc.data })).status).toBe(401);
  });

  it('padding hides short-value length differences', async () => {
    await post('/api/private/init', { passphrase: 'a fine passphrase' });
    const a = (await (await post('/api/private/encrypt', { text: '9' })).json()) as {
      data: string;
    };
    const b = (await (
      await post('/api/private/encrypt', { text: 'a much longer but still short secret' })
    ).json()) as { data: string };
    expect(a.data.length).toBe(b.data.length);
    expect((await (await post('/api/private/decrypt', { data: a.data })).json()) as object).toEqual(
      {
        text: '9',
      },
    );
  });

  it('garbage input fails cleanly, not with a 500', async () => {
    await post('/api/private/init', { passphrase: 'a fine passphrase' });
    expect((await post('/api/private/decrypt', { data: 'bm90IGEgY29udGFpbmVy' })).status).toBe(400);
  });
});

describe('batch decrypt', () => {
  it('decrypt-many returns per-item results with nulls for garbage', async () => {
    const post = (url: string, body: object) =>
      app.request(url, { method: 'POST', body: JSON.stringify(body) });
    await post('/api/private/init', { passphrase: 'a fine passphrase' });
    const a = (await (await post('/api/private/encrypt', { text: 'cell A' })).json()) as {
      data: string;
    };
    const b = (await (await post('/api/private/encrypt', { text: 'cell B' })).json()) as {
      data: string;
    };
    const res = (await (
      await post('/api/private/decrypt-many', { items: [a.data, 'garbage!', b.data] })
    ).json()) as { texts: (string | null)[] };
    expect(res.texts).toEqual(['cell A', null, 'cell B']);
    await post('/api/private/lock', {});
    expect((await post('/api/private/decrypt-many', { items: [a.data] })).status).toBe(401);
    expect((await post('/api/private/decrypt-many', { items: [] })).status).toBe(400);
  });
});
