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
    '---\nid: A\ntitle: Alpha\ntags: [x]\n---\nSee [[Beta]].\n#x\n- [ ] todo\n',
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

describe('jira routes', () => {
  it('status reports unconfigured vault', async () => {
    const res = await app.request('/api/jira/status');
    expect((await res.json()) as object).toMatchObject({ syncing: false, configured: false });
  });

  it('issues and sprints are empty but valid', async () => {
    expect(await (await app.request('/api/jira/issues')).json()).toEqual([]);
    expect(await (await app.request('/api/jira/sprints')).json()).toEqual([]);
    expect(await (await app.request('/api/jira/people')).json()).toEqual([]);
  });

  it('sync without config fails cleanly', async () => {
    const res = await app.request('/api/jira/sync', { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
  });
});

describe('objects and tasks', () => {
  it('lists types and typed notes with frontmatter', async () => {
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'people/zoe.md',
        content: '---\ntype: person\ntitle: Zoe\nrole: SRE\ncapacity: 7\n---\n',
      }),
    });
    const types = (await (await app.request('/api/objects/types')).json()) as {
      type: string;
      count: number;
    }[];
    expect(types).toContainEqual({ type: 'person', count: 1 });
    const list = (await (await app.request('/api/objects/list?type=person')).json()) as {
      title: string;
      frontmatter: { role?: string };
    }[];
    expect(list).toMatchObject([{ title: 'Zoe', frontmatter: { role: 'SRE', capacity: 7 } }]);
  });

  it('toggles a task and detects drift', async () => {
    const res = await app.request('/api/task/toggle', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/a.md', line: 8 }),
    });
    expect(res.status).toBe(200);
    const note = (await (await app.request('/api/note?path=notes/a.md')).json()) as {
      content: string;
    };
    expect(note.content).toContain('- [x] todo');
    // wrong line → 409, file untouched
    const bad = await app.request('/api/task/toggle', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/a.md', line: 2 }),
    });
    expect(bad.status).toBe(409);
  });

  it('creates a typed note from its template', async () => {
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'templates/meeting.md',
        content:
          '---\ntype: meeting\ntitle: "{{title}}"\ndate: {{date}}\nattendees: []\n---\n\n# {{title}}\n\n## Agenda\n\n## Decisions\n\n## Actions\n- [ ] \n',
      }),
    });
    await app.request('/api/note', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/Weekly sync.md', title: 'Weekly sync', type: 'meeting' }),
    });
    const note = (await (await app.request('/api/note?path=notes/Weekly sync.md')).json()) as {
      content: string;
      meta: { type: string };
    };
    expect(note.meta.type).toBe('meeting');
    expect(note.content).toContain('# Weekly sync');
    expect(note.content).toContain('## Decisions');
  });
});

describe('link resolution flags', () => {
  it('note response marks resolved vs placeholder links (jira ghosts included)', async () => {
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'notes/a.md',
        content:
          '---\nid: A\ntitle: Alpha\ntags: [x]\n---\nSee [[Beta]] and [[No Such Note]] and [[EXEC-404]].\n',
      }),
    });
    const note = (await (await app.request('/api/note?path=notes/a.md')).json()) as {
      links: { target: string; resolved: boolean }[];
    };
    const byTarget = Object.fromEntries(note.links.map((l) => [l.target, l.resolved]));
    expect(byTarget.Beta).toBe(true);
    expect(byTarget['No Such Note']).toBe(false);
    expect(byTarget['EXEC-404']).toBe(false); // key resolves to a path, but no mirror file exists
  });
});
