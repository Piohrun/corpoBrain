import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { buildTree, type TreeModel } from '../src/tree-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;

const note = (title: string, extra = '') =>
  `---\ntitle: ${title}\n${extra}---\nBody of ${title}.\n`;

beforeEach(() => {
  root = join(tmpdir(), `cb-tree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'projects.md'), note('Projects'));
  writeFileSync(
    join(root, 'notes', 'gateway.md'),
    note('Gateway', 'parent: "[[Projects]]"\norder: 2\n'),
  );
  writeFileSync(join(root, 'notes', 'apac.md'), note('APAC', 'parent: "[[Projects]]"\norder: 1\n'));
  writeFileSync(join(root, 'notes', 'latency.md'), note('Latency work', 'parent: "[[Gateway]]"\n'));
  writeFileSync(join(root, 'notes', 'loose.md'), note('Loose note'));
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});

afterEach(() => {
  vault.stop();
  rmSync(root, { recursive: true, force: true });
});

const flat = (t: TreeModel) =>
  t.folders.flatMap((f) =>
    f.roots.map((r) => ({
      title: r.title,
      children: r.children.map((c) => ({ title: c.title, kids: c.children.map((k) => k.title) })),
    })),
  );

describe('buildTree', () => {
  it('builds the forest with order-then-title sorting', () => {
    expect(flat(buildTree(vault))).toEqual([
      { title: 'Loose note', children: [] },
      {
        title: 'Projects',
        children: [
          { title: 'APAC', kids: [] },
          { title: 'Gateway', kids: ['Latency work'] },
        ],
      },
    ]);
  });

  it('cycles collapse to roots instead of vanishing', () => {
    writeFileSync(join(root, 'notes', 'a.md'), note('A', 'parent: "[[B]]"\n'));
    writeFileSync(join(root, 'notes', 'b.md'), note('B', 'parent: "[[A]]"\n'));
    vault.indexer.update();
    const titles = buildTree(vault)
      .folders.flatMap((f) => f.roots)
      .map((r) => r.title);
    expect(titles).toContain('A'); // one of the two becomes a root, nothing is lost
    const count = (n: { children: { title: string }[] }[]): number => n.length;
    expect(count(buildTree(vault).folders.flatMap((f) => f.roots))).toBeGreaterThanOrEqual(3);
  });
});

describe('PUT /api/tree/meta', () => {
  const put = (body: object) =>
    app.request('/api/tree/meta', { method: 'PUT', body: JSON.stringify(body) });

  it('category change moves the file into the category folder', async () => {
    const res = await put({ path: 'notes/loose.md', type: 'retro' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe('retro/loose.md');
    const text = readFileSync(join(root, 'retro', 'loose.md'), 'utf8');
    expect(text).toContain('type: retro');
    // new category appears as a tree group
    expect(buildTree(vault).folders.map((f) => f.folder)).toContain('retro');
    // back to notes clears type and moves home
    const back = await put({ path: 'retro/loose.md', type: null });
    expect(((await back.json()) as { path: string }).path).toBe('notes/loose.md');
    expect(readFileSync(join(root, 'notes', 'loose.md'), 'utf8')).not.toContain('type:');
    expect((await put({ path: 'notes/loose.md', type: 'bad type!' })).status).toBe(400);
    expect((await put({ path: 'notes/loose.md', type: 'jira' })).status).toBe(400);
  });

  it('category change breaks a cross-category parent link', async () => {
    const res = await put({ path: 'notes/latency.md', type: 'retro' });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'retro', 'latency.md'), 'utf8');
    expect(text).toContain('type: retro');
    expect(text).not.toContain('parent:');
  });

  it('reparents by title, writes a wikilink, and unparents with null', async () => {
    await put({ path: 'notes/loose.md', parent: 'Gateway' });
    expect(readFileSync(join(root, 'notes', 'loose.md'), 'utf8')).toContain(
      'parent: "[[Gateway]]"',
    );
    const tree = buildTree(vault);
    const gateway = tree.folders[0]?.roots
      .find((r) => r.title === 'Projects')
      ?.children.find((c) => c.title === 'Gateway');
    expect(gateway?.children.map((c) => c.title).sort()).toEqual(['Latency work', 'Loose note']);
    await put({ path: 'notes/loose.md', parent: null });
    expect(readFileSync(join(root, 'notes', 'loose.md'), 'utf8')).not.toContain('parent:');
  });

  it('rejects self, descendants, and unknown parents', async () => {
    expect((await put({ path: 'notes/projects.md', parent: 'Projects' })).status).toBe(400);
    expect((await put({ path: 'notes/projects.md', parent: 'Latency work' })).status).toBe(400);
    expect((await put({ path: 'notes/loose.md', parent: 'No Such Note' })).status).toBe(404);
  });

  it('sets order', async () => {
    await put({ path: 'notes/gateway.md', order: 0 });
    const children = buildTree(vault)
      .folders[0]?.roots.find((r) => r.title === 'Projects')
      ?.children.map((c) => c.title);
    expect(children).toEqual(['Gateway', 'APAC']);
  });
});

describe('POST /api/tree/place', () => {
  const place = (body: object) =>
    app.request('/api/tree/place', { method: 'POST', body: JSON.stringify(body) });
  const rootsOf = (folder: string) =>
    buildTree(vault)
      .folders.find((f) => f.folder === folder)
      ?.roots.map((r) => r.title) ?? [];

  it('reorders roots within a folder', async () => {
    // notes folder roots: Loose note, Projects (alphabetical). Move Projects first.
    const res = await place({ path: 'notes/projects.md', folder: 'notes', index: 0 });
    expect(res.status).toBe(200);
    expect(rootsOf('notes')).toEqual(['Projects', 'Loose note']);
    // and back to the end
    await place({ path: 'notes/projects.md', folder: 'notes', index: 5 });
    expect(rootsOf('notes')).toEqual(['Loose note', 'Projects']);
  });

  it('nesting onto a parent in another category pulls the child over', async () => {
    mkdirSync(join(root, 'retro'), { recursive: true });
    writeFileSync(join(root, 'retro', 'boss.md'), note('Boss', 'type: retro\n'));
    vault.indexer.update();
    const res = await place({ path: 'notes/loose.md', parent: 'retro/boss.md', index: 0 });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'retro', 'loose.md'), 'utf8');
    expect(text).toContain('type: retro');
    expect(text).toContain('parent: "[[Boss]]"');
  });

  it('nests at a position among the new siblings', async () => {
    const res = await place({ path: 'notes/loose.md', parent: 'notes/projects.md', index: 1 });
    expect(res.status).toBe(200);
    const projects = buildTree(vault)
      .folders.flatMap((f) => f.roots)
      .find((r) => r.title === 'Projects');
    expect(projects?.children.map((c) => c.title)).toEqual(['APAC', 'Loose note', 'Gateway']);
    const text = readFileSync(join(root, 'notes', 'loose.md'), 'utf8');
    expect(text).toContain('parent: "[[Projects]]"');
    expect(text).toContain('order: 20');
  });

  it('cross-folder drop moves the file and clears parent', async () => {
    mkdirSync(join(root, 'daily'), { recursive: true });
    const res = await place({ path: 'notes/latency.md', folder: 'daily', index: 0 });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'daily', 'latency.md'), 'utf8')).toContain(
      'Body of Latency work.',
    );
    expect(rootsOf('daily')).toContain('Latency work');
    const gateway = buildTree(vault)
      .folders.flatMap((f) => f.roots)
      .find((r) => r.title === 'Projects')
      ?.children.find((c) => c.title === 'Gateway');
    expect(gateway?.children).toEqual([]);
    // backlink-style resolution by title still works: link from another note
    writeFileSync(join(root, 'notes', 'ref.md'), `${note('Ref', '')}See [[Latency work]].\n`);
    vault.indexer.update();
    const links = vault.indexer.db
      .prepare("SELECT dst_path FROM links WHERE src_path='notes/ref.md'")
      .all() as { dst_path: string }[];
    expect(links).toEqual([{ dst_path: 'daily/latency.md' }]);
  });

  it('guards cycles through place too', async () => {
    expect((await place({ path: 'notes/projects.md', parent: 'notes/latency.md' })).status).toBe(
      400,
    );
    expect((await place({ path: 'notes/projects.md', parent: 'notes/projects.md' })).status).toBe(
      400,
    );
  });
});

describe('tags via meta endpoint', () => {
  it('replaces frontmatter tags, cleans input, clears with empty', async () => {
    const put = (body: object) =>
      app.request('/api/tree/meta', { method: 'PUT', body: JSON.stringify(body) });
    await put({ path: 'notes/loose.md', tags: ['#Alpha', 'beta/x', 'bad tag!', 'beta/x'] });
    const text = readFileSync(join(root, 'notes', 'loose.md'), 'utf8');
    expect(text).toContain('tags:');
    expect(text).toContain('- Alpha');
    expect(text).toContain('- beta/x');
    expect(text).not.toContain('bad tag');
    const tags = vault.indexer.db
      .prepare("SELECT tag FROM tags WHERE path='notes/loose.md' ORDER BY tag")
      .all();
    expect(tags).toEqual([{ tag: 'alpha' }, { tag: 'beta/x' }]);
    await put({ path: 'notes/loose.md', tags: [] });
    expect(readFileSync(join(root, 'notes', 'loose.md'), 'utf8')).not.toContain('tags:');
  });
});

describe('generic property writes and category fields', () => {
  it('meta set writes, updates and deletes properties; reserved keys rejected', async () => {
    const put = (body: object) =>
      app.request('/api/tree/meta', { method: 'PUT', body: JSON.stringify(body) });
    const r = await put({
      path: 'notes/loose.md',
      set: { role: 'SRE', capacity: 6, active: true },
    });
    expect(r.status).toBe(200);
    let text = readFileSync(join(root, 'notes', 'loose.md'), 'utf8');
    expect(text).toContain('role: SRE');
    expect(text).toContain('capacity: 6');
    await put({
      path: 'notes/loose.md',
      set: { role: null, capacity_overrides: { 'Sprint 9': 2 } },
    });
    text = readFileSync(join(root, 'notes', 'loose.md'), 'utf8');
    expect(text).not.toContain('role:');
    expect(text).toContain('Sprint 9: 2');
    expect((await put({ path: 'notes/loose.md', set: { id: 'evil' } })).status).toBe(400);
    expect((await put({ path: 'notes/loose.md', set: { plan: 'evil' } })).status).toBe(400);
  });

  it('people category exposes builtin fields; templates and seen keys add more', async () => {
    const { categoryFields } = await import('../src/object-routes.ts');
    mkdirSync(join(root, 'people'), { recursive: true });
    writeFileSync(join(root, 'people', 'zoe.md'), note('Zoe', 'type: person\nlocation: Warsaw\n'));
    mkdirSync(join(root, 'templates'), { recursive: true });
    writeFileSync(
      join(root, 'templates', 'person.md'),
      '---\ntype: person\ntitle: "{{title}}"\nstart_date: ""\n---\n',
    );
    vault.indexer.update();
    const { fields, sprintOverrides } = categoryFields(vault, 'people');
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.region).toMatchObject({ source: 'builtin', kind: 'text' });
    expect(byKey.capacity).toMatchObject({ kind: 'number' });
    expect(byKey.active).toMatchObject({ kind: 'boolean' });
    expect(byKey.start_date).toMatchObject({ source: 'template' });
    expect(byKey.location).toMatchObject({ source: 'seen' });
    expect(sprintOverrides).toEqual([]); // no sprint cache in this fixture
    const none = categoryFields(vault, 'notes');
    expect(none.sprintOverrides).toBeNull();
  });
});

describe('additive category templates', () => {
  it('moving into people seeds blank builtin fields without removing anything', async () => {
    const put = (body: object) =>
      app.request('/api/tree/meta', { method: 'PUT', body: JSON.stringify(body) });
    // give the note a pre-existing custom property that must survive
    await put({ path: 'notes/loose.md', set: { favourite_editor: 'vim' } });
    const res = await put({ path: 'notes/loose.md', type: 'people' });
    expect(res.status).toBe(200);
    const text = readFileSync(join(root, 'people', 'loose.md'), 'utf8');
    expect(text).toContain('type: person');
    expect(text).toContain('favourite_editor: vim'); // never destructive
    for (const key of ['jira:', 'role:', 'region:', 'team:', 'capacity:']) {
      expect(text).toContain(`\n${key}`); // seeded blank
    }
    expect(text).not.toContain(': null');
    // jira id is settable on a people note
    const setJira = await put({ path: 'people/loose.md', set: { jira: 'lnote' } });
    expect(setJira.status).toBe(200);
    expect(readFileSync(join(root, 'people', 'loose.md'), 'utf8')).toContain('jira: lnote');
    // …but stays reserved elsewhere
    expect((await put({ path: 'notes/gateway.md', set: { jira: 'x' } })).status).toBe(400);
  });
});
