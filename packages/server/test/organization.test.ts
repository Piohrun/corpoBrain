import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type OrgModel, orgMembers, parseFrontmatter, setFrontmatterKey } from '@corpobrain/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { categoryFields } from '../src/tree-routes.ts';
import { VaultService } from '../src/vault-service.ts';

let root: string;
let vault: VaultService;
let app: ReturnType<typeof createApp>;
const file = (
  path: string,
  data: Record<string, unknown>,
  body = '# Notes\n\nKeep this exact text.\n',
) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  let text = body;
  for (const [key, value] of Object.entries(data)) text = setFrontmatterKey(text, key, value);
  writeFileSync(join(root, path), text);
};
const link = (path: string) => `[[${path.replace(/\.md$/, '')}]]`;
const get = async () => (await (await app.request('/api/organization')).json()) as OrgModel;
const patch = (kind: 'person' | 'unit', path: string, value: Record<string, unknown>) =>
  app.request(`/api/organization/${kind}`, {
    method: 'PUT',
    body: JSON.stringify({ path, patch: value }),
  });
const person = (name: string, more: Record<string, unknown> = {}) =>
  file(`people/${name}.md`, { type: 'person', title: name, ...more });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-org-'));
  file('organization/cash.md', {
    type: 'org_unit',
    title: 'Cash Equities',
    org_kind: 'department',
    leads: [link('people/regional')],
  });
  file('organization/trading.md', {
    type: 'org_unit',
    title: 'Trading',
    org_kind: 'product_area',
    parent: link('organization/cash'),
    leads: [link('people/functional')],
  });
  file('organization/pod.md', {
    type: 'org_unit',
    title: 'Execution',
    org_kind: 'pod',
    parent: link('organization/trading'),
    leads: [link('people/anna')],
  });
  file('organization/support.md', {
    type: 'org_unit',
    title: 'Management',
    org_kind: 'pod',
    pod_kind: 'support',
    parent: link('organization/cash'),
  });
  person('anna', {
    country: 'PL',
    region: 'EMEA',
    primary_pod: link('organization/pod'),
    secondary_pods: [link('organization/support')],
    functional_manager: link('people/functional'),
    entity_manager: link('people/local'),
  });
  person('functional', { country: 'UK', primary_pod: link('organization/pod') });
  person('local', {
    country: 'PL',
    primary_pod: link('organization/support'),
    country_lead_for: ['PL'],
    entity_manager: link('people/regional'),
  });
  person('regional', { country: 'UK', region_lead_for: ['EMEA'] });
  file('people/EMEA.md', { title: 'EMEA', region: 'EMEA', active: false });
  file('templates/person.md', { type: 'person', title: 'Template Person' });
  vault = new VaultService(root, ':memory:');
  app = createApp(vault);
});
afterEach(() => {
  vault.stop();
  vault.indexer.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('organization model', () => {
  it('keeps reporting, membership, leadership and geographic scope independent', async () => {
    const model = await get();
    expect(model.people).toHaveLength(4);
    expect(model.people.find((p) => p.title === 'anna')).toMatchObject({
      functionalManager: 'people/functional.md',
      entityManager: 'people/local.md',
      primaryPod: 'organization/pod.md',
      secondaryPods: ['organization/support.md'],
    });
    expect(model.people.find((p) => p.title === 'local')).toMatchObject({
      entityManager: 'people/regional.md',
      countryLeadFor: ['PL'],
    });
    expect(model.units.find((u) => u.title === 'Execution')?.leads).toEqual(['people/anna.md']);
    expect(model.units.find((u) => u.title === 'Management')).toMatchObject({
      parent: 'organization/cash.md',
      podKind: 'support',
    });
    expect(model.problems).toEqual([]);
    expect(
      orgMembers(model, 'organization/cash.md')
        .map((p) => p.title)
        .sort(),
    ).toEqual(['anna', 'functional', 'local']);
    expect(orgMembers(model, 'organization/support.md').map((p) => p.title)).toEqual(['local']);
  });

  it('reports external cycles and broken links without losing the people or hanging', async () => {
    vault.patchNote('people/functional.md', (text) =>
      setFrontmatterKey(text, 'functional_manager', link('people/anna')),
    );
    vault.patchNote('people/local.md', (text) =>
      setFrontmatterKey(text, 'primary_pod', '[[missing]]'),
    );
    const model = await get();
    expect(model.people).toHaveLength(4);
    expect(model.problems.filter((p) => p.field === 'functional_manager')).toHaveLength(2);
    expect(model.problems.find((p) => p.field === 'primary_pod')?.message).toContain('Missing');
  });

  it('does not arbitrarily resolve people with duplicate titles', async () => {
    person('second', { title: 'local' });
    vault.indexer.update();
    vault.patchNote('people/anna.md', (text) =>
      setFrontmatterKey(text, 'entity_manager', '[[local]]'),
    );
    expect(
      (await get()).problems.some(
        (p) => p.path === 'people/anna.md' && p.field === 'entity_manager',
      ),
    ).toBe(true);
    expect(
      (await patch('person', 'people/anna.md', { entity_manager: link('people/local') })).status,
    ).toBe(200);
  });

  it('honors configured people and organization folders', async () => {
    file('staff/chris.md', { title: 'Chris' });
    vault.config.folders.people = 'staff';
    vault.config.folders.organization = 'org';
    vault.indexer.update();
    expect((await get()).people.some((p) => p.title === 'Chris')).toBe(true);
    const response = await app.request('/api/organization/units', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test', kind: 'department' }),
    });
    expect(await response.json()).toMatchObject({ path: 'org/test.md' });
  });
});

describe('organization editing', () => {
  it('writes frontmatter without touching prose and survives a rebuild', async () => {
    const notifications: string[][] = [];
    const unsubscribe = vault.onChange((paths) => notifications.push(paths));
    const original = readFileSync(join(root, 'people/anna.md'), 'utf8');
    const before = original.slice(parseFrontmatter(original).bodyOffset);
    expect(
      (
        await patch('person', 'people/anna.md', {
          entity_manager: link('people/regional'),
          secondary_pods: [],
        })
      ).status,
    ).toBe(200);
    const written = readFileSync(join(root, 'people/anna.md'), 'utf8');
    expect(written.slice(parseFrontmatter(written).bodyOffset)).toBe(before);
    expect(notifications).toEqual([['people/anna.md']]);
    unsubscribe();
    const expected = await get();
    vault.indexer.rebuild();
    expect(await get()).toEqual(expected);
  });

  it('rejects direct and indirect cycles before any file is changed', async () => {
    const before = vault.read('people/regional.md').content;
    expect(
      (await patch('person', 'people/regional.md', { entity_manager: link('people/anna') })).status,
    ).toBe(400);
    expect(vault.read('people/regional.md').content).toBe(before);
    expect(
      (await patch('person', 'people/anna.md', { functional_manager: link('people/anna') })).status,
    ).toBe(400);
    // Each tree is independent: the reverse relationship in the OTHER chain is legal.
    expect(
      (await patch('person', 'people/functional.md', { entity_manager: link('people/anna') }))
        .status,
    ).toBe(200);
  });

  it('rejects wrong-type links, duplicate primary memberships, and invalid parent kinds', async () => {
    expect(
      (await patch('person', 'people/anna.md', { primary_pod: link('organization/trading') }))
        .status,
    ).toBe(400);
    expect(
      (await patch('person', 'people/anna.md', { secondary_pods: [link('organization/pod')] }))
        .status,
    ).toBe(400);
    expect(
      (await patch('unit', 'organization/pod.md', { leads: [link('organization/trading')] }))
        .status,
    ).toBe(400);
    expect(
      (await patch('unit', 'organization/trading.md', { parent: link('organization/pod') })).status,
    ).toBe(400);
    expect(
      (await patch('unit', 'organization/cash.md', { parent: link('organization/trading') }))
        .status,
    ).toBe(400);
  });

  it('updates leadership on its authoritative group note', async () => {
    expect(
      (
        await patch('unit', 'organization/pod.md', {
          leads: [link('people/anna'), link('people/local')],
        })
      ).status,
    ).toBe(200);
    expect((await get()).units.find((u) => u.path === 'organization/pod.md')?.leads).toEqual([
      'people/anna.md',
      'people/local.md',
    ]);
    expect(parseFrontmatter(vault.read('people/anna.md').content).data).not.toHaveProperty(
      'leads_pods',
    );
  });

  it('preserves organization references and backlinks after a person is renamed', async () => {
    const response = await app.request('/api/tree/rename', {
      method: 'POST',
      body: JSON.stringify({ path: 'people/anna.md', title: 'Anna New' }),
    });
    expect(response.status).toBe(200);
    expect((await get()).units.find((u) => u.path === 'organization/pod.md')?.leads).toEqual([
      'people/Anna New.md',
    ]);
    expect(vault.resolve('people/anna')).toEqual({ path: 'people/Anna New.md', exists: true });
    expect(vault.resolve('people/Anna New')).toEqual({ path: 'people/Anna New.md', exists: true });
    expect(
      vault.indexer
        .backlinks('people/Anna New.md')
        .some((l) => l.srcPath === 'organization/pod.md'),
    ).toBe(true);
  });

  it('supports an unassigned department and uniquely named new notes', async () => {
    const create = () =>
      app.request('/api/organization/units', {
        method: 'POST',
        body: JSON.stringify({ title: 'Cash Equities', kind: 'department' }),
      });
    const first = await create();
    const second = await create();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).not.toEqual(await second.json());
  });

  it('rejects invalid requests and never edits unrelated or protected notes', async () => {
    expect((await patch('person', 'people/anna.md', { functional_manager: 7 })).status).toBe(400);
    expect((await patch('unit', 'organization/pod.md', { leads: 'anna' })).status).toBe(400);
    expect((await patch('person', 'people/anna.md', { type: 'org_unit' })).status).toBe(400);
    expect((await patch('person', 'private/secret.md', { primary_pod: null })).status).toBe(404);
  });

  it('keeps the built-in person template minimal and honors a custom template', async () => {
    vault.create('people/default.md', 'Default', undefined, 'person');
    expect(vault.read('people/default.md').content).toContain('Template Person');
    rmSync(join(root, 'templates/person.md'));
    vault.create('people/new.md', 'New', undefined, 'person');
    const fm = parseFrontmatter(vault.read('people/new.md').content).data;
    expect(fm.type).toBe('person');
    expect(fm).not.toHaveProperty('functional_manager');
    expect(fm).not.toHaveProperty('secondary_pods');
    expect((await patch('person', 'people/new.md', { primary_pod: '[[pod]]' })).status).toBe(200);
    expect((await get()).people.find((p) => p.title === 'New')?.primaryPod).toBe(
      'organization/pod.md',
    );
  });
});

describe('organization review regressions', () => {
  it('resolves short paths, aliases and titles only among allowed note types', async () => {
    person('alex', { title: 'Alex Morgan', aliases: ['AM'] });
    file('notes/alex.md', { title: 'Alex Morgan' });
    file('notes/execution.md', { title: 'Execution' });
    file('organization/alex.md', {
      type: 'org_unit',
      org_kind: 'department',
      title: 'Alex Morgan',
    });
    vault.indexer.update();
    for (const manager of ['[[alex]]', '[[Alex Morgan]]', '[[AM]]', '[[people/alex.md|Alex]]']) {
      expect(
        (
          await patch('person', 'people/anna.md', {
            functional_manager: manager,
            primary_pod: '[[POD.md]]',
            secondary_pods: ['[[support]]'],
          })
        ).status,
      ).toBe(200);
      expect((await get()).people.find((p) => p.path === 'people/anna.md')).toMatchObject({
        functionalManager: 'people/alex.md',
        primaryPod: 'organization/pod.md',
        secondaryPods: ['organization/support.md'],
      });
    }
    expect(
      (
        await patch('unit', 'organization/pod.md', {
          parent: '[[trading]]',
          leads: ['[[Alex Morgan]]'],
        })
      ).status,
    ).toBe(200);
    expect((await get()).problems).toEqual([]);
  });

  it('prefers paths over aliases and aliases over basenames, without guessing ambiguous aliases', async () => {
    person('first', { title: 'First', aliases: ['people/functional', 'local'] });
    person('second', { title: 'Second', aliases: ['duplicate'] });
    person('third', { title: 'Third', aliases: ['duplicate'] });
    person('duplicate', { title: 'Different title' });
    vault.indexer.update();
    expect(
      (await patch('person', 'people/anna.md', { functional_manager: '[[people/functional]]' }))
        .status,
    ).toBe(200);
    expect((await get()).people.find((p) => p.title === 'anna')?.functionalManager).toBe(
      'people/functional.md',
    );
    // Rename the original title to make "local" a basename, shadowed by First's alias.
    vault.patchNote('people/local.md', (text) => setFrontmatterKey(text, 'title', 'Local Lead'));
    expect(
      (await patch('person', 'people/anna.md', { functional_manager: '[[local]]' })).status,
    ).toBe(200);
    expect((await get()).people.find((p) => p.title === 'anna')?.functionalManager).toBe(
      'people/first.md',
    );
    expect(
      (await patch('person', 'people/anna.md', { functional_manager: '[[duplicate]]' })).status,
    ).toBe(400);
  });

  it('does not expose organization fields as generic fields, even from templates or seen keys', () => {
    file('templates/person.md', { functional_manager: '', primary_pod: '', secondary_pods: [] });
    const peopleFields = categoryFields(vault, 'people').fields.map((f) => f.key);
    expect(peopleFields).toContain('country');
    expect(peopleFields).not.toContain('functional_manager');
    expect(peopleFields).not.toContain('primary_pod');
    expect(peopleFields).not.toContain('secondary_pods');
    expect(categoryFields(vault, 'organization').fields).toEqual([]);
  });

  it('rejects generic relationship edits before category changes or any file writes', async () => {
    const before = vault.read('people/anna.md').content;
    const response = await app.request('/api/tree/meta', {
      method: 'PUT',
      body: JSON.stringify({
        path: 'people/anna.md',
        type: 'notes',
        set: { functional_manager: '[[anna]]' },
      }),
    });
    expect(response.status).toBe(400);
    expect(vault.read('people/anna.md').content).toBe(before);
    expect(vault.list().some((n) => n.path === 'notes/anna.md')).toBe(false);
    expect(
      (
        await app.request('/api/tree/meta', {
          method: 'PUT',
          body: JSON.stringify({ path: 'organization/pod.md', set: { leads: ['[[missing]]'] } }),
        })
      ).status,
    ).toBe(400);
  });

  it('validates tree drags and parent-note edits without partially writing invalid moves', async () => {
    const before = vault.list().map((note) => [note.path, vault.read(note.path).content]);
    for (const [url, method] of [
      ['/api/tree/meta', 'PUT'],
      ['/api/tree/place', 'POST'],
    ] as const) {
      const response = await app.request(url, {
        method,
        body: JSON.stringify({
          path: 'organization/trading.md',
          parent: 'organization/support.md',
        }),
      });
      expect(response.status).toBe(400);
      expect(vault.list().map((note) => [note.path, vault.read(note.path).content])).toEqual(
        before,
      );
    }
  });

  it('writes unambiguous parents on valid tree moves and clears them when dropped at the root', async () => {
    file('notes/trading.md', { title: 'Trading' });
    vault.indexer.update();
    expect(
      (
        await app.request('/api/tree/place', {
          method: 'POST',
          body: JSON.stringify({
            path: 'organization/support.md',
            parent: 'organization/trading.md',
          }),
        })
      ).status,
    ).toBe(200);
    expect((await get()).units.find((u) => u.path === 'organization/support.md')?.parent).toBe(
      'organization/trading.md',
    );
    expect(
      (
        await app.request('/api/tree/meta', {
          method: 'PUT',
          body: JSON.stringify({ path: 'organization/support.md', parent: 'organization/cash.md' }),
        })
      ).status,
    ).toBe(200);
    expect((await get()).units.find((u) => u.path === 'organization/support.md')?.parent).toBe(
      'organization/cash.md',
    );
    expect(
      (
        await app.request('/api/tree/place', {
          method: 'POST',
          body: JSON.stringify({
            path: 'organization/support.md',
            parent: null,
            folder: 'organization',
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await get()).units.find((u) => u.path === 'organization/support.md')?.parent,
    ).toBeNull();
  });

  it('marks only participating notes for the relationship panel, including custom folders', async () => {
    file('daily/today.md', { title: 'Today' });
    file('staff/legacy.md', { type: 'note', title: 'Legacy Person' });
    vault.config.folders.people = 'staff';
    vault.indexer.rebuild();
    for (const [path, expected] of [
      ['daily/today.md', false],
      ['templates/person.md', false],
      ['people/EMEA.md', false],
      ['staff/legacy.md', true],
      ['people/anna.md', true],
      ['organization/pod.md', true],
    ] as const) {
      const note = (await (await app.request(`/api/note?path=${path}`)).json()) as {
        meta: { organization: boolean };
      };
      expect(note.meta.organization, path).toBe(expected);
    }
  });

  it('skips path aliases for region/team hubs while retaining them for legacy people', async () => {
    file('people/team.md', { title: 'Team', team: 'Team', active: false });
    file('people/legacy.md', { title: 'Legacy' });
    vault.indexer.update();
    vault.move('people/EMEA.md', 'people/region.md');
    vault.move('people/team.md', 'people/group.md');
    vault.move('people/legacy.md', 'people/moved.md');
    for (const path of ['people/region.md', 'people/group.md'])
      expect(parseFrontmatter(vault.read(path).content).data).not.toHaveProperty('aliases');
    expect(parseFrontmatter(vault.read('people/moved.md').content).data.aliases).toContain(
      'people/legacy',
    );
    file('people/APAC.md', { title: 'APAC', region: 'APAC', active: false });
    vault.indexer.update();
    expect(
      (
        await app.request('/api/tree/rename', {
          method: 'POST',
          body: JSON.stringify({ path: 'people/APAC.md', title: 'Asia' }),
        })
      ).status,
    ).toBe(200);
    expect(parseFrontmatter(vault.read('people/Asia.md').content).data.aliases).toEqual(['APAC']);
  });
});

describe('POD headcount writes', () => {
  it('saves size, overrides and counted groups atomically while preserving the Markdown body', async () => {
    const before = vault.read('organization/pod.md').content;
    const response = await patch('unit', 'organization/pod.md', {
      headcount: 20,
      headcount_entity_manager: '[[local]]',
      headcount_groups: [{ id: 'poland', count: 8, country: 'PL', entity_manager: '[[local]]' }],
    });
    expect(response.status).toBe(200);
    const after = vault.read('organization/pod.md').content;
    expect(after.slice(parseFrontmatter(after).bodyOffset)).toBe(
      before.slice(parseFrontmatter(before).bodyOffset),
    );
    expect((await get()).units.find((u) => u.path === 'organization/pod.md')).toMatchObject({
      headcount: 20,
      headcountEntityManager: 'people/local.md',
      headcountGroups: [{ id: 'poland', count: 8, country: 'PL' }],
    });
    const expected = await get();
    vault.indexer.rebuild();
    expect(await get()).toEqual(expected);
    expect(
      (await patch('unit', 'organization/pod.md', { headcount: null, headcount_groups: [] }))
        .status,
    ).toBe(200);
    expect(parseFrontmatter(vault.read('organization/pod.md').content).data).not.toHaveProperty(
      'headcount',
    );
  });
  it('rejects invalid sizes, wrong note types and broken reporting references without writes', async () => {
    const before = vault.read('organization/pod.md').content;
    for (const headcount of [-1, 1.5, '20', 1, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await patch('unit', 'organization/pod.md', { headcount })).status).toBe(400);
      expect(vault.read('organization/pod.md').content).toBe(before);
    }
    expect((await patch('unit', 'organization/cash.md', { headcount: 200 })).status).toBe(400);
    expect(
      (
        await patch('unit', 'organization/pod.md', {
          headcount_entity_manager: '[[organization/cash]]',
        })
      ).status,
    ).toBe(400);
    expect(
      (await patch('unit', 'organization/pod.md', { headcount_reporting: 'guess' })).status,
    ).toBe(400);
  });
  it('rejects duplicate/oversized groups and prevents decreasing size below allocated groups', async () => {
    for (const headcount_groups of [
      [
        { id: 'x', count: 2 },
        { id: 'x', count: 2 },
      ],
      [{ id: 'x', count: 0 }],
      [{ id: 'x', count: 19 }],
      [{ id: 'x', count: 2, country: 123 }],
      [{ id: 'x', count: 2, entity_manager: '[[missing]]' }],
      [{ id: 'x', count: 2, unknown: true }],
    ])
      expect(
        (await patch('unit', 'organization/pod.md', { headcount: 20, headcount_groups })).status,
      ).toBe(400);
    expect(
      (
        await patch('unit', 'organization/pod.md', {
          headcount: 20,
          headcount_groups: [{ id: 'x', count: 10 }],
        })
      ).status,
    ).toBe(200);
    expect((await patch('unit', 'organization/pod.md', { headcount: 5 })).status).toBe(400);
  });
  it('does not offer unvalidated generic headcount edits', async () => {
    expect(
      (
        await app.request('/api/tree/meta', {
          method: 'PUT',
          body: JSON.stringify({ path: 'organization/pod.md', set: { headcount: -10 } }),
        })
      ).status,
    ).toBe(400);
    await patch('unit', 'organization/pod.md', { headcount: 20 });
    expect(
      categoryFields(vault, 'organization').fields.some((field) => field.key === 'headcount'),
    ).toBe(false);
  });
});
