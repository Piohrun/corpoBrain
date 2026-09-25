import { describe, expect, it } from 'vitest';
import {
  buildOrganization,
  type OrgSource,
  orgAncestors,
  orgFilteredView,
  orgForest,
  orgMembers,
  orgReportingView,
} from '../src/organization.ts';

const person = (name: string, fm: Record<string, unknown> = {}): OrgSource => ({
  path: `people/${name}.md`,
  title: name,
  type: 'person',
  fm,
});
const unit = (name: string, org_kind: string, parent?: string): OrgSource => ({
  path: `org/${name}.md`,
  title: name,
  type: 'org_unit',
  fm: { org_kind, parent },
});
const model = () =>
  buildOrganization([
    unit('Cash', 'department'),
    unit('Trading', 'product_area', '[[Cash]]'),
    unit('Execution', 'pod', '[[Trading]]'),
    unit('Support', 'pod', '[[Cash]]'),
    unit('Other', 'department'),
    unit('OtherPod', 'pod', '[[Other]]'),
    person('Maya', {
      country: 'PL',
      role: 'Engineer',
      primary_pod: '[[Execution]]',
      secondary_pods: ['[[Support]]'],
      functional_manager: '[[Alex]]',
      entity_manager: '[[CountryLead]]',
    }),
    person('Alex', {
      country: 'UK',
      primary_pod: '[[OtherPod]]',
      functional_manager: '[[Director]]',
      active: false,
    }),
    person('Director', { country: 'US' }),
    person('CountryLead', {
      country: 'PL',
      primary_pod: '[[Support]]',
      entity_manager: '[[RegionLead]]',
    }),
    person('RegionLead', { country: 'UK' }),
    person('Peer', {
      country: 'PL',
      primary_pod: '[[Execution]]',
      functional_manager: '[[Director]]',
    }),
  ]);
const paths = (items: { path: string }[]) => items.map((p) => p.path);

describe('organization view derivations', () => {
  it('intersects country, department, search and activity filters while keeping group ancestors', () => {
    const view = orgFilteredView(model(), {
      country: 'PL',
      department: 'org/Cash.md',
      query: 'engineer',
    });
    expect(paths(view.people)).toEqual(['people/Maya.md']);
    expect([...view.visibleUnits].sort()).toEqual([
      'org/Cash.md',
      'org/Execution.md',
      'org/Trading.md',
    ]);
    expect(paths(view.structure.roots)).toEqual(['org/Cash.md']);
    expect(paths(view.structure.children.get('org/Cash.md') ?? [])).toEqual(['org/Trading.md']);
    expect(paths(orgFilteredView(model(), { query: 'Alex' }).people)).toEqual([]);
    expect(paths(orgFilteredView(model(), { query: 'Alex', showInactive: true }).people)).toEqual([
      'people/Alex.md',
    ]);
  });

  it('matches product areas and departments through primary membership without counting secondary membership twice', () => {
    expect(paths(orgFilteredView(model(), { query: 'trading' }).people)).toEqual([
      'people/Maya.md',
      'people/Peer.md',
    ]);
    expect(paths(orgFilteredView(model(), { query: 'Cash' }).people)).toEqual([
      'people/Maya.md',
      'people/CountryLead.md',
      'people/Peer.md',
    ]);
    expect(paths(orgMembers(model(), 'org/Support.md'))).toEqual(['people/CountryLead.md']);
    expect(orgMembers(model(), 'org/Cash.md')).toHaveLength(3);
    expect(paths(orgFilteredView(model()).primaryUnplaced)).toEqual([
      'people/Director.md',
      'people/RegionLead.md',
    ]);
  });

  it('retains inactive and out-of-country managers as context without broadening the matched people', () => {
    const m = model();
    const filtered = orgFilteredView(m, {
      country: 'PL',
      department: 'org/Cash.md',
      query: 'Maya',
    });
    const reporting = orgReportingView(m, filtered.peoplePaths, 'functionalManager');
    expect([...reporting.paths].sort()).toEqual([
      'people/Alex.md',
      'people/Director.md',
      'people/Maya.md',
    ]);
    expect(paths(reporting.roots)).toEqual(['people/Director.md']);
    expect(paths(reporting.children.get('people/Director.md') ?? [])).toEqual(['people/Alex.md']);
    expect(paths(filtered.people)).toEqual(['people/Maya.md']);
  });

  it('focuses on the chosen reporting subtree and uses an independent entity chain', () => {
    const m = model();
    const filtered = orgFilteredView(m, { country: 'PL' });
    const functional = orgReportingView(
      m,
      filtered.peoplePaths,
      'functionalManager',
      'people/Alex.md',
    );
    expect([...functional.paths].sort()).toEqual([
      'people/Alex.md',
      'people/Director.md',
      'people/Maya.md',
    ]);
    expect(functional.paths.has('people/Peer.md')).toBe(false);
    const entity = orgReportingView(
      m,
      filtered.peoplePaths,
      'entityManager',
      'people/CountryLead.md',
    );
    expect([...entity.paths].sort()).toEqual([
      'people/CountryLead.md',
      'people/Maya.md',
      'people/RegionLead.md',
    ]);
    expect(paths(entity.roots)).toEqual(['people/RegionLead.md']);
    expect(orgReportingView(m, filtered.peoplePaths, 'entityManager', 'missing').roots).toEqual([]);
  });

  it('retains the focused manager and their ancestors even if filters hide every report', () => {
    const view = orgReportingView(model(), new Set(), 'functionalManager', 'people/Alex.md');
    expect([...view.paths].sort()).toEqual(['people/Alex.md', 'people/Director.md']);
    expect(paths(view.roots)).toEqual(['people/Director.md']);
  });

  it('renders cycles, missing parents and self-links once each without recursion loops', () => {
    const parents = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
      ['child', 'a'],
      ['self', 'self'],
      ['orphan', 'missing'],
    ]);
    expect(orgAncestors('a', parents)).toEqual(['b']);
    expect(orgAncestors('self', parents)).toEqual([]);
    expect(orgAncestors('orphan', parents)).toEqual(['missing']);
    const forest = orgForest(
      [...parents.keys()].map((path) => ({ path })),
      parents,
      new Set(parents.keys()),
    );
    const visited: string[] = [];
    const walk = (items: { path: string }[]) => {
      for (const item of items) {
        expect(visited).not.toContain(item.path);
        visited.push(item.path);
        walk(forest.children.get(item.path) ?? []);
      }
    };
    walk(forest.roots);
    expect(visited.sort()).toEqual([...parents.keys()].sort());
  });

  it('keeps invalid organizational cycles navigable and primary headcount unique', () => {
    const m = buildOrganization([
      unit('One', 'pod', '[[Two]]'),
      unit('Two', 'pod', '[[One]]'),
      person('Person', { primary_pod: '[[One]]', functional_manager: '[[Person]]' }),
    ]);
    const view = orgFilteredView(m, { department: 'org/One.md', query: 'Person' });
    expect(paths(view.structure.roots)).toEqual(['org/One.md', 'org/Two.md']);
    expect(orgMembers(m, 'org/One.md')).toHaveLength(1);
    const reporting = orgReportingView(
      m,
      view.peoplePaths,
      'functionalManager',
      'people/Person.md',
    );
    expect(paths(reporting.roots)).toEqual(['people/Person.md']);
    expect(reporting.children.size).toBe(0);
  });
});
