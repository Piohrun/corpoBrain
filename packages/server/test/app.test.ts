import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { applyTemplate, VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  root = join(tmpdir(), `cb-srv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(
    join(root, 'notes', 'a.md'),
    '---\nid: A\ntitle: Alpha\n---\nSee [[Beta]].\n#x\n- [ ] todo\n',
  );
  writeFileSync(join(root, 'notes', 'b.md'), '---\nid: B\ntitle: Beta\n---\nBody beta.\n');
  writeFileSync(join(root, 'private', 'p.md.enc'), 'SECRET');
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

const json = async (res: Response) => (await res.json()) as never;

describe('server API', () => {
  it('lists notes', async () => {
    const res = await app.request('/api/notes');
    const items = (await json(res)) as { path: string }[];
    expect(items.map((i) => i.path)).toEqual(['notes/a.md', 'notes/b.md', 'private/p.md.enc']);
  });

  it('reads a note with meta and backlinks', async () => {
    const res = await app.request('/api/note?path=notes/b.md');
    const body = (await json(res)) as {
      content: string;
      meta: { title: string };
      backlinks: { srcPath: string }[];
    };
    expect(body.content).toContain('Body beta.');
    expect(body.meta.title).toBe('Beta');
    expect(body.backlinks).toMatchObject([{ srcPath: 'notes/a.md' }]);
  });

  it('writes a note and reindexes', async () => {
    const res = await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'notes/b.md',
        content: '---\nid: B\ntitle: Beta\n---\nNew unique word zanzibar.\n',
      }),
    });
    expect(res.status).toBe(200);
    const hits = (await json(await app.request('/api/search?q=zanzibar'))) as { path: string }[];
    expect(hits).toMatchObject([{ path: 'notes/b.md' }]);
  });

  it('refuses paths outside the vault and private/', async () => {
    expect((await app.request('/api/note?path=../etc/passwd')).status).toBe(400);
    expect((await app.request('/api/note?path=private/p.md.enc')).status).toBe(403);
    const w = await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({ path: 'private/x.md', content: 'no' }),
    });
    expect(w.status).toBe(403);
  });

  it('resolves targets: existing, jira, new', async () => {
    expect(await json(await app.request('/api/resolve?target=Beta'))).toEqual({
      path: 'notes/b.md',
      exists: true,
    });
    expect(await json(await app.request('/api/resolve?target=EXEC-12'))).toEqual({
      path: 'jira/EXEC-12.md',
      exists: false,
    });
    expect(await json(await app.request('/api/resolve?target=Brand New'))).toEqual({
      path: 'notes/Brand New.md',
      exists: false,
    });
  });

  it('creates a note and finds it', async () => {
    const res = await app.request('/api/note', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/Brand New.md', title: 'Brand New' }),
    });
    expect((await json(res)) as object).toEqual({ path: 'notes/Brand New.md' });
    const read = (await json(await app.request('/api/note?path=notes/Brand New.md'))) as {
      content: string;
    };
    expect(read.content).toContain('# Brand New');
  });

  it('daily note is created once', async () => {
    const r1 = (await json(await app.request('/api/daily', { method: 'POST', body: '{}' }))) as {
      created: boolean;
      path: string;
    };
    expect(r1.created).toBe(true);
    const r2 = (await json(await app.request('/api/daily', { method: 'POST', body: '{}' }))) as {
      created: boolean;
    };
    expect(r2.created).toBe(false);
  });

  it('tags, tag lookup, tasks, unresolved', async () => {
    expect(await json(await app.request('/api/tags'))).toEqual([{ tag: 'x', count: 1 }]);
    expect(await json(await app.request('/api/tag?tag=x'))).toMatchObject([{ path: 'notes/a.md' }]);
    expect(await json(await app.request('/api/tasks?done=false'))).toMatchObject([
      { text: 'todo' },
    ]);
    expect(await json(await app.request('/api/unresolved'))).toEqual([]);
  });

  it('delete moves to trash and unindexes', async () => {
    const res = await app.request('/api/note?path=notes/b.md', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await app.request('/api/note?path=notes/b.md')).status).toBe(404);
    const unresolved = (await json(await app.request('/api/unresolved'))) as { target: string }[];
    expect(unresolved).toMatchObject([{ target: 'Beta' }]);
  });
});

describe('applyTemplate', () => {
  it('substitutes date variables', () => {
    const out = applyTemplate(
      '# {{date}}\nprev [[{{yesterday}}]] next [[{{tomorrow}}]]',
      '2026-03-01',
    );
    expect(out).toBe(
      '# 2026-03-01\nprev [[2026-02-28]] next [[2026-03-01]]'.replace(
        'next [[2026-03-01]]',
        'next [[2026-03-02]]',
      ),
    );
  });
});
