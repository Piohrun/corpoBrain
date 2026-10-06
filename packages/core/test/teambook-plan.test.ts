import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter.ts';
import type { OrgSource } from '../src/organization.ts';
import { buildTeambookWrites, nextBaseline } from '../src/teambook/apply.ts';
import { normalizeSnapshot } from '../src/teambook/client.ts';
import {
  emptyBaseline,
  inferKinds,
  planTeambookImport,
  type TeambookBaseline,
  type TeambookChange,
  type TeambookPlan,
} from '../src/teambook/plan.ts';
import type { TeambookSnapshot } from '../src/teambook/types.ts';

/** A small vault: notes kept by hand, before any import. */
const VAULT: Record<string, string> = {
  'organization/trading.md':
    '---\ntype: org_unit\ntitle: Trading Technology\norg_kind: department\n---\n# Trading\n\nMy notes.\n',
  'organization/execution.md':
    '---\ntype: org_unit\ntitle: Execution Services\norg_kind: pod\nteambook_id: P-EXE\nparent: "[[organization/trading]]"\nleads: ["[[people/anna]]"]\nmandate: My own words\n---\n# Execution\n\nWorking notes stay.\n',
  'people/anna.md':
    '---\ntype: person\ntitle: Anna Kowalska\nemail: anna@bank.com\nrole: Lead\ncountry: PL\nprimary_pod: "[[organization/execution]]"\ncapacity: 8\n---\nAnna 1:1 notes.\n',
  'people/bob.md': '---\ntype: person\ntitle: Bob Smith\n---\n',
  'people/carl.md':
    '---\ntype: person\ntitle: Carl\nteambook_id: U-CARL\nprimary_pod: "[[organization/execution]]"\n---\n',
  'people/same-1.md': '---\ntype: person\ntitle: Same Name\n---\n',
  'people/same-2.md': '---\ntype: person\ntitle: Same Name\n---\n',
  'people/eve.md': '---\ntype: person\ntitle: Eve Other\nemail: eve.real@bank.com\n---\n',
};

const SNAPSHOT: TeambookSnapshot = {
  version: 1,
  fetchedAt: '2026-10-06T10:00:00Z',
  rootId: 'D1',
  pods: [
    {
      id: 'D1',
      name: 'Trading Technology',
      parentId: null,
      kind: null,
      status: null,
      mandate: null,
    },
    {
      id: 'P-EXE',
      name: 'Execution Services',
      parentId: 'D1',
      kind: null,
      status: 'active',
      mandate: 'Their words',
    },
    {
      id: 'P-MD',
      name: 'Market Data',
      parentId: 'D1',
      kind: null,
      status: 'active',
      mandate: 'Prices',
    },
  ],
  users: [
    {
      id: 'U-ANNA',
      name: 'Anna Kowalska',
      email: 'Anna@Bank.com',
      role: 'Engineering Manager',
      country: 'Poland',
      active: true,
    },
    { id: 'U-BOB', name: 'Bob Smith', email: null, role: null, country: null, active: true },
    {
      id: 'U-NINA',
      name: 'Nina New',
      email: 'nina@bank.com',
      role: 'Engineer',
      country: 'IN',
      active: true,
    },
    { id: 'U-SAME', name: 'Same Name', email: null, role: null, country: null, active: true },
    {
      id: 'U-EVE',
      name: 'Eve Other',
      email: 'eve@vendor.com',
      role: null,
      country: null,
      active: true,
    },
  ],
  memberships: [
    { podId: 'P-EXE', userId: 'U-ANNA', primary: true, lead: true },
    { podId: 'P-EXE', userId: 'U-BOB', primary: null, lead: false },
    { podId: 'P-MD', userId: 'U-NINA', primary: true, lead: true },
    { podId: 'P-MD', userId: 'U-SAME', primary: null, lead: false },
    { podId: 'P-MD', userId: 'U-EVE', primary: null, lead: false },
  ],
};

function sourcesOf(files: Record<string, string>): OrgSource[] {
  return Object.entries(files).map(([path, text]) => {
    const fm = parseFrontmatter(text).data;
    return { path, title: String(fm.title ?? path), type: String(fm.type ?? 'note'), fm };
  });
}

const plan = (files: Record<string, string>, snapshot = SNAPSHOT, baseline = emptyBaseline()) =>
  planTeambookImport(snapshot, sourcesOf(files), baseline, {
    folders: { people: 'people', organization: 'organization' },
    existingPaths: new Set(Object.keys(files)),
    createUnits: true,
    createPeople: true,
  });
const change = (p: TeambookPlan, id: string) =>
  p.changes.find((c) => c.id === id) as TeambookChange;
const selectedIds = (p: TeambookPlan) => p.changes.filter((c) => c.selected).map((c) => c.id);

/** Apply a selection to an in-memory vault, like the server does. */
function apply(
  files: Record<string, string>,
  p: TeambookPlan,
  ids: string[],
  baseline: TeambookBaseline,
  dismiss: string[] = [],
) {
  const result = buildTeambookWrites(
    p,
    ids,
    (path) => files[path] ?? null,
    (c) => (c.scope === 'unit' ? `---\n---\n# ${c.title}\n` : `---\n---\n# ${c.title}\n`),
  );
  const next = { ...files };
  for (const w of result.writes) next[w.path] = w.after;
  return { files: next, result, baseline: nextBaseline(baseline, p, result.applied, dismiss) };
}

describe('Teambook import plan', () => {
  it('infers levels from the tree when Teambook does not say', () => {
    expect([...inferKinds(SNAPSHOT.pods)]).toEqual([
      ['D1', 'department'],
      ['P-EXE', 'pod'],
      ['P-MD', 'pod'],
    ]);
  });

  it('matches by id, then email, then a unique title — never guessing', () => {
    const p = plan(VAULT);
    const by = Object.fromEntries(p.matches.map((m) => [m.externalId, [m.by, m.path]]));
    expect(by).toEqual({
      D1: ['title', 'organization/trading.md'],
      'P-EXE': ['id', 'organization/execution.md'],
      'P-MD': ['new', 'organization/market-data.md'],
      'U-ANNA': ['email', 'people/anna.md'],
      'U-BOB': ['title', 'people/bob.md'],
      'U-NINA': ['new', 'people/nina-new.md'],
      'U-SAME': ['ambiguous', null],
      // same title, but the note's email says it is someone else: a new note, not a merge
      'U-EVE': ['new', 'people/eve-other.md'],
    });
    expect(p.changes.some((c) => c.externalId === 'U-SAME')).toBe(false);
  });

  it('fills empty fields, but leaves every hand-edited value as an unselected conflict', () => {
    const p = plan(VAULT);
    expect(change(p, 'unit:P-EXE:mandate')).toMatchObject({
      status: 'conflict',
      selected: false,
      current: 'My own words',
      next: 'Their words',
    });
    expect(change(p, 'person:U-ANNA:role')).toMatchObject({ status: 'conflict', selected: false });
    // PL and Poland are the same country
    expect(change(p, 'person:U-ANNA:country')).toBeUndefined();
    // references that already point at the right notes agree, even through a by-title link
    expect(change(p, 'unit:P-EXE:parent')).toBeUndefined();
    expect(change(p, 'unit:P-EXE:leads')).toBeUndefined();
    expect(change(p, 'person:U-BOB:primary_pod')).toMatchObject({
      status: 'fill',
      selected: true,
      next: '[[organization/execution]]',
      requires: ['person:U-BOB:link'],
    });
    expect(change(p, 'unit:P-EXE:status')).toMatchObject({ status: 'fill', next: 'active' });
  });

  it('creates missing notes with references to other new notes', () => {
    const p = plan(VAULT);
    expect(change(p, 'unit:P-MD:create')).toMatchObject({
      status: 'new',
      path: 'organization/market-data.md',
      next: {
        title: 'Market Data',
        org_kind: 'pod',
        parent: '[[organization/trading]]',
        leads: ['[[people/nina-new]]'],
        status: 'active',
        mandate: 'Prices',
      },
    });
    expect(change(p, 'unit:P-MD:create').requires.sort()).toEqual([
      'person:U-NINA:create',
      'unit:D1:link',
    ]);
    expect(change(p, 'person:U-NINA:create')).toMatchObject({
      next: {
        title: 'Nina New',
        email: 'nina@bank.com',
        primary_pod: '[[organization/market-data]]',
      },
      requires: ['unit:P-MD:create'],
    });
  });

  it('proposes, but never pre-selects, deactivating someone who left their POD', () => {
    expect(change(plan(VAULT), 'person:U-CARL:deactivate')).toMatchObject({
      status: 'left',
      selected: false,
      next: false,
    });
  });

  it('applies only frontmatter keys it owns, keeping bodies and other keys', () => {
    const p = plan(VAULT);
    const { files, result } = apply(VAULT, p, selectedIds(p), emptyBaseline());
    expect(result.skipped).toEqual([]);
    expect(files['people/anna.md']).toBe(
      '---\ntype: person\ntitle: Anna Kowalska\nemail: anna@bank.com\nrole: Lead\ncountry: PL\nprimary_pod: "[[organization/execution]]"\ncapacity: 8\nteambook_id: U-ANNA\n---\nAnna 1:1 notes.\n',
    );
    expect(files['organization/execution.md']).toContain('mandate: My own words\n');
    expect(files['organization/execution.md']).toContain('Working notes stay.');
    expect(files['organization/trading.md']).toBe(
      '---\ntype: org_unit\ntitle: Trading Technology\norg_kind: department\nteambook_id: D1\n---\n# Trading\n\nMy notes.\n',
    );
    expect(parseFrontmatter(files['organization/market-data.md'] as string).data).toMatchObject({
      type: 'org_unit',
      teambook_id: 'P-MD',
      org_kind: 'pod',
      parent: '[[organization/trading]]',
    });
    // carl was not selected, the duplicates were never touched
    expect(files['people/carl.md']).toBe(VAULT['people/carl.md']);
    expect(files['people/same-1.md']).toBe(VAULT['people/same-1.md']);
  });

  it('drops changes whose prerequisites were not selected', () => {
    const p = plan(VAULT);
    const { result } = apply(
      VAULT,
      p,
      ['person:U-BOB:primary_pod', 'person:U-NINA:create'],
      emptyBaseline(),
    );
    expect(result.writes).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'person:U-BOB:primary_pod', reason: 'needs person:U-BOB:link' },
      { id: 'person:U-NINA:create', reason: 'needs unit:P-MD:create' },
    ]);
  });

  it('refuses changes to notes edited since the preview, and unparseable notes', () => {
    const p = plan(VAULT);
    const edited = {
      ...VAULT,
      'people/bob.md':
        '---\ntype: person\ntitle: Bob Smith\nprimary_pod: "[[organization/trading]]"\n---\n',
      'organization/trading.md': '---\ntitle: [broken\n---\n',
    };
    const { result } = apply(edited, p, selectedIds(p), emptyBaseline());
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.id, s.reason]));
    expect(reasons['person:U-BOB:primary_pod']).toContain('changed since the preview');
    expect(reasons['unit:D1:link']).toContain('frontmatter cannot be parsed');
    // and everything that depended on the department link falls away with it
    expect(reasons['unit:P-MD:create']).toBe('needs unit:D1:link');
  });

  it('follows Teambook on later imports only where you did not edit', () => {
    let p = plan(VAULT);
    let state = apply(VAULT, p, selectedIds(p), emptyBaseline());

    // Teambook renames a mandate and moves Bob; Nina gets a second POD.
    const later: TeambookSnapshot = structuredClone(SNAPSHOT);
    (later.pods[2] as { mandate: string }).mandate = 'Prices and reference data';
    later.memberships.push({ podId: 'P-EXE', userId: 'U-NINA', primary: false, lead: false });
    // meanwhile you rewrote the Market Data status by hand
    state.files['organization/market-data.md'] = (
      state.files['organization/market-data.md'] as string
    ).replace('status: active', 'status: forming');
    p = plan(state.files, later, state.baseline);
    expect(change(p, 'unit:P-MD:mandate')).toMatchObject({ status: 'update', selected: true });
    expect(change(p, 'unit:P-MD:status')).toBeUndefined(); // Teambook did not change it: nothing to say
    expect(change(p, 'person:U-NINA:secondary_pods')).toMatchObject({
      status: 'add',
      next: ['[[organization/execution]]'],
    });
    state = apply(state.files, p, selectedIds(p), state.baseline);

    // You remove the secondary membership again: the next import respects that.
    state.files['people/nina-new.md'] = (state.files['people/nina-new.md'] as string).replace(
      /secondary_pods:\n {2}- "\[\[organization\/execution\]\]"\n/,
      '',
    );
    p = plan(state.files, later, state.baseline);
    expect(change(p, 'person:U-NINA:secondary_pods')).toBeUndefined();
  });

  it('remembers a dismissed conflict until Teambook changes its mind', () => {
    let p = plan(VAULT);
    const state = apply(VAULT, p, selectedIds(p), emptyBaseline(), ['person:U-ANNA:role']);
    p = plan(state.files, SNAPSHOT, state.baseline);
    expect(change(p, 'person:U-ANNA:role')).toMatchObject({ status: 'dismissed', selected: false });
    const later: TeambookSnapshot = structuredClone(SNAPSHOT);
    (later.users[0] as { role: string }).role = 'Director';
    p = plan(state.files, later, state.baseline);
    expect(change(p, 'person:U-ANNA:role')).toMatchObject({ status: 'conflict', next: 'Director' });
  });

  it('blocks a parent that corpoBrain levels cannot express', () => {
    const files = {
      ...VAULT,
      'organization/execution.md': (VAULT['organization/execution.md'] as string).replace(
        'parent: "[[organization/trading]]"\n',
        '',
      ),
    };
    const deep: TeambookSnapshot = structuredClone(SNAPSHOT);
    (deep.pods[1] as { parentId: string }).parentId = 'P-MD'; // a POD under a POD,
    (deep.pods[2] as { kind: string }).kind = 'pod'; // as Teambook states it explicitly
    const p = plan(files, deep);
    expect(change(p, 'unit:P-EXE:parent')).toMatchObject({ status: 'blocked', selected: false });
  });
});

describe('Teambook snapshot validation', () => {
  it('rejects cycles and duplicate PODs, and warns about loose ends', () => {
    const cyclic = structuredClone(SNAPSHOT);
    (cyclic.pods[0] as { parentId: string }).parentId = 'P-EXE';
    expect(() => normalizeSnapshot(cyclic)).toThrow('cycle');
    const dup = structuredClone(SNAPSHOT);
    dup.pods.push(dup.pods[0] as never);
    expect(() => normalizeSnapshot(dup)).toThrow('appears twice');

    const loose = structuredClone(SNAPSHOT);
    loose.memberships.push({ podId: 'NOPE', userId: 'U-ANNA', primary: null, lead: false });
    loose.memberships.push({ podId: 'P-MD', userId: 'U-ANNA', primary: true, lead: false });
    const { snapshot, warnings } = normalizeSnapshot(loose);
    expect(warnings).toEqual([
      'membership U-ANNA → NOPE points outside the snapshot; ignored',
      'Anna Kowalska has 2 primary PODs in Teambook; primary left undecided',
    ]);
    expect(snapshot.memberships.filter((m) => m.userId === 'U-ANNA').map((m) => m.primary)).toEqual(
      [null, null],
    );
  });
});
