import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect((await app.request('/api/note?path=Private/p.md.enc')).status).toBe(403);
    expect((await app.request('/api/note?path=PRIVATE/.keystore.json')).status).toBe(403);
    expect((await app.request('/api/note?path=.corpobrain/secrets.json')).status).toBe(400);
    expect((await app.request('/api/note?path=.Corpobrain/secrets.json')).status).toBe(400);
    expect((await app.request('/api/note?path=notes/.hidden.md')).status).toBe(400);
    expect((await app.request('/api/note?path=notes//a.md')).status).toBe(400);
    expect((await app.request('/api/note?path=C:/Windows/win.ini')).status).toBe(400);
    expect((await app.request('/api/note?path=notes/a.md')).status).toBe(200);
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

  it('restore brings the newest trashed copy back and re-indexes it', async () => {
    await app.request('/api/note?path=notes/b.md', { method: 'DELETE' });
    expect((await app.request('/api/note?path=notes/b.md')).status).toBe(404);
    const res = await app.request('/api/note/restore', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/b.md' }),
    });
    expect(res.status).toBe(200);
    expect((await app.request('/api/note?path=notes/b.md')).status).toBe(200);
    expect(
      vault.indexer.db.prepare('SELECT 1 FROM notes WHERE path = ?').get('notes/b.md'),
    ).toBeTruthy();
    // nothing left to restore
    expect(
      (
        await app.request('/api/note/restore', {
          method: 'POST',
          body: JSON.stringify({ path: 'notes/b.md' }),
        })
      ).status,
    ).toBe(409);
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

  it('tracks selected note text as an evidence-linked object', async () => {
    const excerpt = 'See [[Beta]].';
    const sourceBefore = readFileSync(join(root, 'notes', 'a.md'), 'utf8');
    const sourceFrom = sourceBefore.indexOf(excerpt);
    const created = await app.request('/api/tracked', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'commitment',
        statement: 'Send the rollout answer to Zoe',
        excerpt,
        sourcePath: 'notes/a.md',
        sourceLine: 6,
        sourceFrom,
        sourceTo: sourceFrom + excerpt.length,
        owner: 'Greg',
        date: '2026-09-08',
      }),
    });
    expect(created.status).toBe(201);
    const result = (await created.json()) as { path: string; trackId: string };
    expect(result.path).toMatch(/^tracked\/commitment-send-the-rollout-answer-to-zoe-/);

    const text = readFileSync(join(root, result.path), 'utf8');
    expect(text).toContain('type: commitment');
    expect(text).toContain('status: open');
    expect(text).toContain('track_id:');
    expect(text).toContain('source: "[[notes/a]]"');
    expect(text).toContain('due: "2026-09-08"');

    const sourceAfter = readFileSync(join(root, 'notes', 'a.md'), 'utf8');
    expect(sourceAfter).toMatch(/<!-- cb-track:[0-9A-Z]+:commitment -->See \[\[Beta\]\]\./);
    expect(sourceAfter).toMatch(/<!-- \/cb-track:[0-9A-Z]+ -->/);

    const listed = (await (await app.request('/api/tracked')).json()) as {
      path: string;
      kind: string;
      owner: string;
      sourceTitle: string;
      sourceState: string;
      currentExcerpt: string;
    }[];
    expect(listed).toMatchObject([
      {
        path: result.path,
        kind: 'commitment',
        owner: 'Greg',
        sourceTitle: 'Alpha',
        sourceState: 'unchanged',
        currentExcerpt: excerpt,
      },
    ]);

    const source = (await (await app.request('/api/note?path=notes/a.md')).json()) as {
      backlinks: { srcPath: string; kind: string }[];
    };
    expect(source.backlinks.filter((backlink) => backlink.srcPath === result.path)).toEqual([
      expect.objectContaining({ srcPath: result.path, kind: 'link' }),
    ]);

    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'notes/a.md',
        content: sourceAfter.replace(excerpt, 'See [[Beta]] after the rollout.'),
      }),
    });
    const edited = (await (await app.request('/api/tracked')).json()) as {
      sourceState: string;
      currentExcerpt: string;
    }[];
    expect(edited[0]).toMatchObject({
      sourceState: 'edited',
      currentExcerpt: 'See [[Beta]] after the rollout.',
    });

    const editedSource = readFileSync(join(root, 'notes', 'a.md'), 'utf8');
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'notes/a.md',
        content: editedSource.replace('See [[Beta]] after the rollout.', ''),
      }),
    });
    const removed = (await (await app.request('/api/tracked')).json()) as {
      sourceState: string;
      currentExcerpt: string;
    }[];
    expect(removed[0]).toMatchObject({ sourceState: 'removed', currentExcerpt: '' });

    const emptySource = readFileSync(join(root, 'notes', 'a.md'), 'utf8');
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'notes/a.md',
        content: emptySource
          .replace(`<!-- cb-track:${result.trackId}:commitment -->`, '')
          .replace(`<!-- /cb-track:${result.trackId} -->`, ''),
      }),
    });
    const missing = (await (await app.request('/api/tracked')).json()) as {
      sourceState: string;
    }[];
    expect(missing[0]?.sourceState).toBe('missing');
  });

  it('can attach a change trace to a legacy tracked item', async () => {
    await app.request('/api/note', {
      method: 'POST',
      body: JSON.stringify({ path: 'tracked/legacy.md', title: 'Legacy', type: 'risk' }),
    });
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'tracked/legacy.md',
        content:
          '---\ntype: risk\ntitle: Legacy\nstatus: open\nsource_path: notes/a.md\nsource_line: 8\nexcerpt: todo\n---\n\n# Legacy\n',
      }),
    });
    const before = (await (await app.request('/api/tracked')).json()) as {
      path: string;
      sourceState: string;
    }[];
    expect(before.find((item) => item.path === 'tracked/legacy.md')?.sourceState).toBe(
      'unanchored',
    );

    const anchored = await app.request('/api/tracked/anchor', {
      method: 'POST',
      body: JSON.stringify({ path: 'tracked/legacy.md' }),
    });
    expect(anchored.status).toBe(200);
    expect(readFileSync(join(root, 'notes', 'a.md'), 'utf8')).toMatch(
      /<!-- cb-track:[0-9A-Z]+:risk -->todo<!-- \/cb-track:[0-9A-Z]+ -->/,
    );
    const after = (await (await app.request('/api/tracked')).json()) as {
      path: string;
      sourceState: string;
    }[];
    expect(after.find((item) => item.path === 'tracked/legacy.md')?.sourceState).toBe('unchanged');
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

describe('jira task items', () => {
  it('lists both kinds and toggles each syntax in place', async () => {
    await app.request('/api/note', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'notes/todo.md',
        content: '# Todo\n\n- [ ] a normal task\n- j[ ] create a jira\n- [j] shorthand jira\n',
      }),
    });
    const all = (await (await app.request('/api/tasks')).json()) as {
      path: string;
      text: string;
      kind: string;
      line: number;
      done: number;
    }[];
    const list = all.filter((t) => t.path === 'notes/todo.md');
    expect(list.map((t) => [t.text, t.kind])).toEqual([
      ['a normal task', 'task'],
      ['create a jira', 'jira'],
      ['shorthand jira', 'jira'],
    ]);
    // the fixture's plain task is untouched by the new syntax
    expect(all.find((t) => t.text === 'todo')?.kind).toBe('task');

    // tick the j[ ] item: state flips, kind marker survives
    const jira = list.find((t) => t.text === 'create a jira');
    const res = await app.request('/api/task/toggle', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/todo.md', line: jira?.line }),
    });
    expect(res.status).toBe(200);
    let text = readFileSync(join(root, 'notes', 'todo.md'), 'utf8');
    expect(text).toContain('- j[x] create a jira');

    // the shorthand normalises to the canonical form when ticked
    const short = list.find((t) => t.text === 'shorthand jira');
    await app.request('/api/task/toggle', {
      method: 'POST',
      body: JSON.stringify({ path: 'notes/todo.md', line: short?.line }),
    });
    text = readFileSync(join(root, 'notes', 'todo.md'), 'utf8');
    expect(text).toContain('- j[x] shorthand jira');

    const after = (await (await app.request('/api/tasks')).json()) as {
      text: string;
      kind: string;
      done: number;
    }[];
    expect(after.filter((t) => t.kind === 'jira' && t.done === 1)).toHaveLength(2);
    expect(after.filter((t) => t.kind === 'task').every((t) => t.done === 0)).toBe(true);
  });
});

describe('local-only guard', () => {
  const body = JSON.stringify({ path: 'notes/csrf.md', title: 'x' });
  it('accepts same-origin loopback requests', async () => {
    const res = await app.request('http://127.0.0.1:4747/api/note', {
      method: 'POST',
      body,
      headers: { origin: 'http://127.0.0.1:4747', 'sec-fetch-site': 'same-origin' },
    });
    expect(res.status).toBe(200);
  });
  it('rejects a cross-site POST from another origin (CSRF)', async () => {
    const res = await app.request('http://127.0.0.1:4747/api/note', {
      method: 'POST',
      body,
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
    expect((await app.request('/api/note?path=notes/csrf.md')).status).toBe(404);
  });
  it('rejects a non-loopback host (DNS rebinding)', async () => {
    const res = await app.request('http://evil.example:4747/api/notes');
    expect(res.status).toBe(403);
  });
  it('rejects an Origin that is not loopback even without Sec-Fetch-Site', async () => {
    const res = await app.request('/api/git/commit', {
      method: 'POST',
      headers: { origin: 'http://attacker.test' },
    });
    expect(res.status).toBe(403);
  });
});

describe('tracked evidence anchors', () => {
  const create = (body: Record<string, unknown>) =>
    app.request('/api/tracked', { method: 'POST', body: JSON.stringify(body) });
  const list = async () =>
    (await (await app.request('/api/tracked')).json()) as {
      path: string;
      sourcePath: string;
      sourceState: string;
      currentLine: number | null;
      currentExcerpt: string | null;
    }[];

  it('starts the anchor after list, task and heading syntax so the line keeps its shape', async () => {
    writeFileSync(
      join(root, 'notes', 'list.md'),
      '---\nid: L\n---\n# Plan\n\n- [ ] ship the gateway by Friday\n> quoted promise\n',
    );
    vault.indexer.update();
    const content = readFileSync(join(root, 'notes', 'list.md'), 'utf8');
    const line = '- [ ] ship the gateway by Friday';
    const from = content.indexOf(line);
    const res = await create({
      kind: 'commitment',
      statement: 'ship the gateway',
      excerpt: line,
      sourcePath: 'notes/list.md',
      sourceLine: 6,
      sourceFrom: from,
      sourceTo: from + line.length,
    });
    expect(res.status).toBe(201);
    const after = readFileSync(join(root, 'notes', 'list.md'), 'utf8');
    expect(after).toMatch(
      /^- \[ \] <!-- cb-track:[0-9A-Z]+:commitment -->ship the gateway by Friday<!-- \/cb-track:[0-9A-Z]+ -->$/m,
    );
    // the task is still a task for the indexer
    const tasks = vault.indexer.db
      .prepare('SELECT text FROM tasks WHERE path = ?')
      .all('notes/list.md') as { text: string }[];
    expect(tasks.map((t) => t.text)).toEqual(['ship the gateway by Friday']);
    const [item] = await list();
    expect(item?.currentExcerpt).toBe('ship the gateway by Friday');
    // a selection of only the syntax is refused
    const bad = await create({
      kind: 'risk',
      statement: 'x',
      excerpt: '- [ ] ',
      sourcePath: 'notes/list.md',
      sourceLine: 6,
      sourceFrom: from,
      sourceTo: from + 6,
    });
    expect(bad.status).toBe(400);
  });

  it('follows a renamed source through the anchor index and reports edits without re-reading', async () => {
    const excerpt = 'See [[Beta]].';
    const before = readFileSync(join(root, 'notes', 'a.md'), 'utf8');
    const from = before.indexOf(excerpt);
    await create({
      kind: 'decision',
      statement: 'Beta it is',
      excerpt,
      sourcePath: 'notes/a.md',
      sourceLine: 6,
      sourceFrom: from,
      sourceTo: from + excerpt.length,
    });
    expect((await list())[0]).toMatchObject({ sourcePath: 'notes/a.md', sourceState: 'unchanged' });

    // rename the source note: the recorded path is stale, the anchor is not
    vault.move('notes/a.md', 'notes/alpha-renamed.md');
    expect((await list())[0]).toMatchObject({
      sourcePath: 'notes/alpha-renamed.md',
      sourceState: 'unchanged',
      currentLine: 6,
    });

    // edit the evidence in place → edited; delete it → removed
    const p = join(root, 'notes', 'alpha-renamed.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('See [[Beta]].', 'See [[Beta]] soon.'));
    vault.indexer.updatePaths(['notes/alpha-renamed.md']);
    expect((await list())[0]).toMatchObject({
      sourceState: 'edited',
      currentExcerpt: 'See [[Beta]] soon.',
    });
    writeFileSync(p, readFileSync(p, 'utf8').replace('See [[Beta]] soon.', ''));
    vault.indexer.updatePaths(['notes/alpha-renamed.md']);
    expect((await list())[0]?.sourceState).toBe('removed');
  });
});
