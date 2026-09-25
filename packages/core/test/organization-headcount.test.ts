import { describe, expect, it } from 'vitest';
import {
  buildOrganization,
  type OrgSource,
  orgAnonymousGroups,
  orgFilteredView,
  orgHeadcount,
  orgReportingTotals,
} from '../src/organization.ts';

const person = (name: string, fm: Record<string, unknown> = {}): OrgSource => ({
  path: `people/${name}.md`,
  title: name,
  type: 'person',
  fm,
});
const unit = (name: string, kind: string, fm: Record<string, unknown> = {}): OrgSource => ({
  path: `org/${name}.md`,
  title: name,
  type: 'org_unit',
  fm: { org_kind: kind, ...fm },
});
const sources = (pod: Record<string, unknown> = {}): OrgSource[] => [
  unit('Department', 'department'),
  unit('Area', 'product_area', { parent: '[[Department]]' }),
  unit('Delivery', 'pod', { parent: '[[Area]]', leads: ['[[Functional]]'], headcount: 10, ...pod }),
  person('Root'),
  person('Functional', { functional_manager: '[[Root]]' }),
  person('Entity', { entity_manager: '[[Root]]' }),
  person('Worker', {
    primary_pod: '[[Delivery]]',
    functional_manager: '[[Functional]]',
    entity_manager: '[[Entity]]',
    country: 'PL',
  }),
];
const reports = (
  s: OrgSource[],
  mode: 'functionalManager' | 'entityManager' | 'both',
  person = 'Root',
) => {
  const result = orgReportingTotals(buildOrganization(s), mode).get(`people/${person}.md`);
  if (!result) throw new Error(`Missing person ${person}`);
  return result;
};

describe('POD size and reporting totals', () => {
  it('treats size as a total including named primary members and rolls it up through all ancestors', () => {
    const model = buildOrganization(sources());
    for (const name of ['Delivery', 'Area', 'Department'])
      expect(orgHeadcount(model, `org/${name}.md`)).toEqual({ named: 1, others: 9, total: 10 });
    expect(orgHeadcount(model)).toEqual({ named: 4, others: 9, total: 13 });
  });
  it('replaces an unnamed employee with a named member without inflating the POD or department', () => {
    const model = buildOrganization([
      ...sources(),
      person('New', { primary_pod: '[[Delivery]]', secondary_pods: [] }),
    ]);
    expect(orgHeadcount(model, 'org/Department.md')).toEqual({ named: 2, others: 8, total: 10 });
  });
  it('sums independent PODs and excludes secondary memberships', () => {
    const model = buildOrganization([
      ...sources(),
      unit('Support', 'pod', { parent: '[[Department]]', headcount: 5 }),
      person('Shared', { primary_pod: '[[Delivery]]', secondary_pods: ['[[Support]]'] }),
    ]);
    expect(orgHeadcount(model, 'org/Department.md')).toEqual({ named: 2, others: 13, total: 15 });
    expect(orgHeadcount(model, 'org/Support.md')).toEqual({ named: 0, others: 5, total: 5 });
  });
  it('uses named people only when cleared, accepts zero, and never hides known people under a stale override', () => {
    expect(
      orgHeadcount(buildOrganization(sources({ headcount: null })), 'org/Delivery.md'),
    ).toEqual({ named: 1, others: 0, total: 1 });
    const stale = buildOrganization(sources({ headcount: 0 }));
    expect(stale.problems.some((p) => p.field === 'headcount')).toBe(true);
    expect(orgHeadcount(stale, 'org/Delivery.md').total).toBe(1);
    const empty = buildOrganization([unit('Empty', 'pod', { headcount: 0 })]);
    expect(empty.problems).toEqual([]);
    expect(orgHeadcount(empty).total).toBe(0);
  });
  it('does not consume unnamed capacity with inactive people and can explicitly include inactive named people', () => {
    const model = buildOrganization([
      ...sources(),
      person('Former', { active: false, primary_pod: '[[Delivery]]' }),
    ]);
    expect(orgHeadcount(model, 'org/Delivery.md')).toEqual({ named: 1, others: 9, total: 10 });
    expect(orgHeadcount(model, 'org/Delivery.md', true)).toEqual({
      named: 2,
      others: 9,
      total: 11,
    });
  });
  it('defaults unnamed people to POD leads and supports independent manager overrides', () => {
    expect(reports(sources(), 'functionalManager').total).toEqual({
      named: 2,
      others: 9,
      total: 11,
    });
    expect(reports(sources(), 'entityManager').total).toEqual({ named: 2, others: 0, total: 2 });
    expect(
      reports(sources({ headcount_entity_manager: '[[Entity]]' }), 'entityManager').total,
    ).toEqual({ named: 2, others: 9, total: 11 });
    expect(
      reports(sources({ headcount_functional_manager: '[[Root]]' }), 'functionalManager').direct,
    ).toEqual({ named: 1, others: 9, total: 10 });
  });
  it('deduplicates named people and the same unnamed group reached through two managers or both lines', () => {
    const s = sources({
      leads: ['[[Functional]]', '[[Entity]]'],
      headcount_entity_manager: '[[Entity]]',
    });
    const all = reports(s, 'both');
    expect(all.total).toEqual({ named: 3, others: 9, total: 12 });
    expect(all.direct).toEqual({ named: 2, others: 0, total: 2 });
    expect(new Set(all.people.map((p) => p.path)).size).toBe(all.people.length);
    expect(all.groups).toHaveLength(1);
    const same = sources({
      headcount_functional_manager: '[[Root]]',
      headcount_entity_manager: '[[Root]]',
    });
    same.push(person('Same', { functional_manager: '[[Root]]', entity_manager: '[[Root]]' }));
    expect(reports(same, 'both').direct).toEqual({ named: 3, others: 9, total: 12 });
  });
  it('follows mixed paths in Both, including the full subtree, without counting the manager', () => {
    const s = [
      person('Root'),
      person('Middle', { functional_manager: '[[Root]]' }),
      person('Child', { entity_manager: '[[Middle]]' }),
    ];
    expect(reports(s, 'functionalManager').total.named).toBe(1);
    expect(reports(s, 'entityManager').total.named).toBe(0);
    expect(reports(s, 'both').total.named).toBe(2);
    expect(reports(s, 'both', 'Middle').total.named).toBe(1);
  });
  it('terminates on cross-chain cycles and external self-links, excluding the manager from totals', () => {
    const s = [
      person('Root', { entity_manager: '[[Middle]]' }),
      person('Middle', { functional_manager: '[[Root]]' }),
      person('Child', { functional_manager: '[[Child]]', entity_manager: '[[Root]]' }),
    ];
    expect(reports(s, 'both').total.named).toBe(2);
    expect(reports(s, 'both', 'Middle').total.named).toBe(2);
  });
  it('keeps inactive intermediates in traversal without counting them by default', () => {
    const model = buildOrganization([
      person('Root'),
      person('Former', { active: false, functional_manager: '[[Root]]' }),
      person('Child', { functional_manager: '[[Former]]' }),
    ]);
    expect(orgReportingTotals(model, 'functionalManager').get('people/Root.md')?.total.named).toBe(
      1,
    );
    expect(
      orgReportingTotals(model, 'functionalManager', true).get('people/Root.md')?.total.named,
    ).toBe(2);
  });
  it('keeps unnamed people in size totals even if there is no reporting manager', () => {
    const model = buildOrganization(sources({ headcount_reporting: 'explicit' }));
    expect(orgHeadcount(model, 'org/Delivery.md').total).toBe(10);
    expect(orgReportingTotals(model, 'both').get('people/Root.md')?.total.others).toBe(0);
    expect(orgAnonymousGroups(model)[0]?.functionalManagers).toEqual([]);
  });
  it('splits distinct counted groups by country/entity manager and counts each group once in Both', () => {
    const s = sources({
      headcount_groups: [
        { id: 'india', count: 4, country: 'India', entity_manager: '[[Entity]]' },
        { id: 'poland', count: 3, country: 'Poland', entity_manager: '[[Root]]' },
      ],
    });
    const model = buildOrganization(s);
    expect(model.problems).toEqual([]);
    expect(orgAnonymousGroups(model).map((g) => g.count)).toEqual([4, 3, 2]);
    expect(reports(s, 'entityManager').total.others).toBe(7);
    expect(reports(s, 'both').total.others).toBe(9);
    const view = orgFilteredView(model, { country: 'India' });
    expect(view.people).toEqual([]);
    expect(view.anonymous.reduce((sum, g) => sum + g.count, 0)).toBe(4);
    expect(view.visibleUnits.has('org/Delivery.md')).toBe(true);
    expect(view.countries).toContain('India');
    expect(orgFilteredView(model, { query: 'Area' }).anonymous).toHaveLength(3);
    expect(orgFilteredView(model, { query: 'Worker' }).anonymous).toHaveLength(0);
    expect(orgFilteredView(model, { country: 'PL' }).anonymous).toHaveLength(0);
  });
  it('pauses reporting attribution for oversized allocations or broken manager references rather than guessing', () => {
    for (const fields of [
      { headcount_groups: [{ id: 'too-many', count: 12 }] },
      { headcount_groups: [{ id: 'bad-ref', count: 4, entity_manager: '[[missing]]' }] },
      { headcount_entity_manager: '[[missing]]' },
    ]) {
      const model = buildOrganization(sources(fields));
      expect(model.problems.length).toBeGreaterThan(0);
      expect(orgHeadcount(model, 'org/Delivery.md').total).toBe(10);
      expect(orgReportingTotals(model, 'both').get('people/Root.md')?.total.others).toBe(0);
    }
  });
});
