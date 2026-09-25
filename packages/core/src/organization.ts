/** Organization relationships are derived from note properties, never stored in a second database. */
// Imported directly by the browser UI: keep this module free of Node dependencies.
export type OrgKind = 'department' | 'product_area' | 'pod';
export const ORG_KINDS: OrgKind[] = ['department', 'product_area', 'pod'];
export const ORG_LABELS: Record<OrgKind, string> = {
  department: 'Department',
  product_area: 'Product Area',
  pod: 'POD',
};

export interface OrgSource {
  path: string;
  title: string;
  type: string;
  fm: Record<string, unknown>;
}

export interface OrgPerson {
  path: string;
  title: string;
  role: string;
  country: string;
  region: string;
  active: boolean;
  functionalManager: string | null;
  entityManager: string | null;
  primaryPod: string | null;
  secondaryPods: string[];
  countryLeadFor: string[];
  regionLeadFor: string[];
}

export interface OrgUnit {
  path: string;
  title: string;
  kind: OrgKind;
  parent: string | null;
  leads: string[];
  mandate: string;
  status: string;
  podKind: string;
  headcount: number | null;
  headcountReporting: 'pod_leads' | 'explicit';
  headcountFunctionalManager: string | null;
  headcountEntityManager: string | null;
  headcountGroups: OrgHeadcountGroup[];
}

export interface OrgHeadcountGroup {
  id: string;
  count: number;
  country: string;
  functionalManager: string | null;
  entityManager: string | null;
}

export interface OrgProblem {
  path: string;
  field: string;
  message: string;
}

export interface OrgModel {
  people: OrgPerson[];
  units: OrgUnit[];
  problems: OrgProblem[];
}

export const orgText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Legacy people notes are supported, but region/team hubs are organizational filing aids. */
export function orgSourceType(source: OrgSource, peopleFolder: string): string {
  const { path, title, fm, type } = source;
  if (fm.type === 'person' || fm.type === 'org_unit') return fm.type;
  if (!path.startsWith(`${peopleFolder}/`)) return type;
  if (title === orgText(fm.region) || title === orgText(fm.team)) return 'note';
  return !fm.type || fm.type === 'note' ? 'person' : type;
}

export function orgStrings(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : [value]).map(orgText).filter(Boolean))];
}

export function orgTarget(value: unknown): string {
  const raw = orgText(value);
  return (/^\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]$/.exec(raw)?.[1] ?? raw).replace(/\.md$/i, '');
}

export function orgParentAllowed(child: OrgKind, parent: OrgKind): boolean {
  return child === 'product_area'
    ? parent === 'department'
    : child === 'pod' && (parent === 'product_area' || parent === 'department');
}

/** Every participant in a cycle is reported. This also works on externally edited notes. */
export function orgCyclePaths(parents: Map<string, string | null>): Set<string> {
  const done = new Set<string>();
  const cycles = new Set<string>();
  for (const start of parents.keys()) {
    const route: string[] = [];
    const positions = new Map<string, number>();
    let next: string | null | undefined = start;
    while (next && parents.has(next) && !done.has(next)) {
      const index = positions.get(next);
      if (index !== undefined) {
        for (const path of route.slice(index)) cycles.add(path);
        break;
      }
      positions.set(next, route.length);
      route.push(next);
      next = parents.get(next);
    }
    for (const path of route) done.add(path);
  }
  return cycles;
}

export function buildOrganization(sources: OrgSource[]): OrgModel {
  const peopleSources = sources.filter((s) => s.type === 'person');
  const unitSources = sources.filter((s) => s.type === 'org_unit');
  const peoplePaths = new Set(peopleSources.map((p) => p.path));
  const unitKinds = new Map(unitSources.map((u) => [u.path, orgText(u.fm.org_kind)]));
  const problems: OrgProblem[] = [];
  const issue = (path: string, field: string, message: string) =>
    problems.push({ path, field, message });
  const resolvers = new Map<Set<string>, (target: string) => string | null>();
  const resolve = (target: string, allowed: Set<string>): string | null => {
    let resolver = resolvers.get(allowed);
    if (!resolver) {
      const paths = new Map<string, string>();
      const aliases = new Map<string, Set<string>>();
      const basenames = new Map<string, Set<string>>();
      const add = (map: Map<string, Set<string>>, key: string, path: string) => {
        const hits = map.get(key) ?? new Set<string>();
        hits.add(path);
        map.set(key, hits);
      };
      for (const source of sources) {
        if (!allowed.has(source.path)) continue;
        const path = source.path.replace(/\.md$/i, '').toLowerCase();
        paths.set(path, source.path);
        add(basenames, path.split('/').pop() ?? path, source.path);
        for (const alias of [source.title, ...orgStrings(source.fm.aliases)])
          add(aliases, alias.toLowerCase(), source.path);
      }
      resolver = (raw) => {
        const key = raw.trim().replace(/\.md$/i, '').toLowerCase();
        const exact = paths.get(key);
        if (exact) return exact;
        // Same precedence as the indexer, scoped to the relationship's allowed note types.
        const matches = aliases.get(key) ?? basenames.get(key);
        return matches?.size === 1 ? ([...matches][0] ?? null) : null;
      };
      resolvers.set(allowed, resolver);
    }
    return resolver(target);
  };
  const reference = (s: OrgSource, field: string, raw: unknown, allowed: Set<string>) => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string') {
      issue(s.path, field, 'Expected a linked note.');
      return null;
    }
    const path = resolve(orgTarget(raw), allowed);
    if (!path || !allowed.has(path)) {
      issue(s.path, field, `Missing, ambiguous, or wrong-type reference: ${raw}`);
      return null;
    }
    return path;
  };
  const references = (s: OrgSource, field: string, allowed: Set<string>): string[] => {
    const raw = s.fm[field];
    if (raw !== undefined && raw !== null && !Array.isArray(raw))
      issue(s.path, field, 'Expected a list of linked notes.');
    return [
      ...new Set(
        orgStrings(raw)
          .map((value) => reference(s, field, value, allowed))
          .filter((p): p is string => p !== null),
      ),
    ];
  };
  const pods = new Set([...unitKinds].filter(([, kind]) => kind === 'pod').map(([path]) => path));
  const unitPaths = new Set(unitSources.map((u) => u.path));
  const units: OrgUnit[] = unitSources.map((s) => {
    const rawKind = orgText(s.fm.org_kind);
    const kind = ORG_KINDS.includes(rawKind as OrgKind) ? (rawKind as OrgKind) : 'pod';
    if (!ORG_KINDS.includes(rawKind as OrgKind))
      issue(s.path, 'org_kind', 'Choose department, product_area, or pod.');
    const rawCount = s.fm.headcount;
    const headcount =
      typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0
        ? rawCount
        : null;
    if (rawCount != null && (headcount === null || kind !== 'pod'))
      issue(s.path, 'headcount', 'POD size must be a non-negative whole number on a POD.');
    const reporting = s.fm.headcount_reporting ?? 'pod_leads';
    if (!['pod_leads', 'explicit'].includes(String(reporting)))
      issue(s.path, 'headcount_reporting', 'Choose pod_leads or explicit.');
    const headcountGroups: OrgHeadcountGroup[] = [];
    const groupIds = new Set<string>();
    if (s.fm.headcount_groups != null && !Array.isArray(s.fm.headcount_groups))
      issue(s.path, 'headcount_groups', 'Expected a list of counted groups.');
    for (const raw of Array.isArray(s.fm.headcount_groups) ? s.fm.headcount_groups : []) {
      const group = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const id = orgText(group.id);
      if (
        !id ||
        id === '__remainder__' ||
        groupIds.has(id) ||
        !Number.isSafeInteger(group.count) ||
        Number(group.count) <= 0
      ) {
        issue(
          s.path,
          'headcount_groups',
          'Each group needs a unique id and a positive whole-number count.',
        );
        continue;
      }
      groupIds.add(id);
      headcountGroups.push({
        id,
        count: group.count as number,
        country: orgText(group.country),
        functionalManager: reference(s, 'headcount_groups', group.functional_manager, peoplePaths),
        entityManager: reference(s, 'headcount_groups', group.entity_manager, peoplePaths),
      });
    }
    for (const field of [
      'headcount_reporting',
      'headcount_functional_manager',
      'headcount_entity_manager',
      'headcount_groups',
    ])
      if (kind !== 'pod' && s.fm[field] != null)
        issue(s.path, field, 'Unnamed employee settings belong on a POD.');
    const parent = reference(s, 'parent', s.fm.parent, unitPaths);
    if (parent && !orgParentAllowed(kind, unitKinds.get(parent) as OrgKind))
      issue(
        s.path,
        'parent',
        'Product Areas belong to Departments; PODs belong to Product Areas or Departments.',
      );
    return {
      path: s.path,
      title: s.title,
      kind,
      parent,
      leads: references(s, 'leads', peoplePaths),
      mandate: orgText(s.fm.mandate),
      status: orgText(s.fm.status),
      podKind: orgText(s.fm.pod_kind),
      headcount,
      headcountReporting: reporting === 'explicit' ? 'explicit' : 'pod_leads',
      headcountFunctionalManager: reference(
        s,
        'headcount_functional_manager',
        s.fm.headcount_functional_manager,
        peoplePaths,
      ),
      headcountEntityManager: reference(
        s,
        'headcount_entity_manager',
        s.fm.headcount_entity_manager,
        peoplePaths,
      ),
      headcountGroups,
    };
  });
  const people: OrgPerson[] = peopleSources.map((s) => {
    const primaryPod = reference(s, 'primary_pod', s.fm.primary_pod, pods);
    const secondaryPods = references(s, 'secondary_pods', pods);
    if (primaryPod && secondaryPods.includes(primaryPod))
      issue(s.path, 'secondary_pods', 'The primary POD is also listed as a secondary membership.');
    return {
      path: s.path,
      title: s.title,
      role: orgText(s.fm.role),
      country: orgText(s.fm.country),
      region: orgText(s.fm.region),
      active: s.fm.active !== false,
      functionalManager: reference(s, 'functional_manager', s.fm.functional_manager, peoplePaths),
      entityManager: reference(s, 'entity_manager', s.fm.entity_manager, peoplePaths),
      primaryPod,
      secondaryPods: secondaryPods.filter((p) => p !== primaryPod),
      countryLeadFor: orgStrings(s.fm.country_lead_for),
      regionLeadFor: orgStrings(s.fm.region_lead_for),
    };
  });
  for (const unit of units) {
    const named = people.filter((p) => p.active && p.primaryPod === unit.path).length;
    if (unit.headcount !== null && unit.headcount < named)
      issue(
        unit.path,
        'headcount',
        `POD size is below its ${named} active named primary members. Named people are still counted.`,
      );
    if (
      unit.headcountGroups.reduce((sum, group) => sum + group.count, 0) >
      Math.max(0, (unit.headcount ?? named) - named)
    )
      issue(
        unit.path,
        'headcount_groups',
        'Counted groups exceed the unnamed people remaining in this POD. Adjust the groups; reporting attribution is paused until corrected.',
      );
  }
  const checkCycle = (field: string, parents: Map<string, string | null>) => {
    for (const path of orgCyclePaths(parents))
      issue(path, field, 'Circular hierarchy: this note is part of a reporting or parent cycle.');
  };
  checkCycle('parent', new Map(units.map((u) => [u.path, u.parent])));
  checkCycle('functional_manager', new Map(people.map((p) => [p.path, p.functionalManager])));
  checkCycle('entity_manager', new Map(people.map((p) => [p.path, p.entityManager])));
  return { people, units, problems };
}

/** Unique primary members of a whole subtree. Secondary membership never inflates headcount. */
export function orgMembers(model: OrgModel, unit: string): OrgPerson[] {
  const paths = orgUnitPaths(model, unit);
  return model.people.filter((p) => p.primaryPod && paths.has(p.primaryPod));
}

export function orgUnitPaths(model: OrgModel, unit: string): Set<string> {
  const paths = new Set([unit]);
  const queue = [unit];
  for (let index = 0; index < queue.length; index++) {
    for (const child of model.units.filter((u) => u.parent === queue[index])) {
      if (!paths.has(child.path)) {
        paths.add(child.path);
        queue.push(child.path);
      }
    }
  }
  return paths;
}

export type OrgChain = 'functionalManager' | 'entityManager';
export type OrgReportingMode = OrgChain | 'both';
export interface OrgCount {
  named: number;
  others: number;
  total: number;
}
export interface OrgAnonymousGroup {
  id: string;
  pod: string;
  count: number;
  country: string;
  functionalManagers: string[];
  entityManagers: string[];
}

export function orgCount(named: number, others: number): OrgCount {
  return { named, others, total: named + others };
}

/** A counted group has one identity across both reporting lines, without fake person notes. */
export function orgAnonymousGroups(model: OrgModel): OrgAnonymousGroup[] {
  return model.units.flatMap((unit) => {
    if (unit.kind !== 'pod' || unit.headcount === null) return [];
    const named = model.people.filter((p) => p.active && p.primaryPod === unit.path).length;
    const others = Math.max(0, unit.headcount - named);
    if (!others) return [];
    const base = { pod: unit.path, country: '' };
    // Inconsistent raw edits must never silently attribute an arbitrary subset to managers.
    if (model.problems.some((p) => p.path === unit.path && p.field.startsWith('headcount')))
      return [
        {
          ...base,
          id: `${unit.path}:__remainder__`,
          count: others,
          functionalManagers: [],
          entityManagers: [],
        },
      ];
    const fallback = unit.headcountReporting === 'pod_leads' ? unit.leads : [];
    const functionalManagers = unit.headcountFunctionalManager
      ? [unit.headcountFunctionalManager]
      : fallback;
    const entityManagers = unit.headcountEntityManager ? [unit.headcountEntityManager] : fallback;
    const groups = unit.headcountGroups.map((group) => ({
      ...base,
      id: `${unit.path}:${group.id}`,
      count: group.count,
      country: group.country,
      functionalManagers: group.functionalManager ? [group.functionalManager] : functionalManagers,
      entityManagers: group.entityManager ? [group.entityManager] : entityManagers,
    }));
    const remainder = others - groups.reduce((sum, group) => sum + group.count, 0);
    if (remainder > 0)
      groups.push({
        ...base,
        id: `${unit.path}:__remainder__`,
        count: remainder,
        functionalManagers,
        entityManagers,
      });
    return groups;
  });
}

/** Department/Product Area totals are sums of unique PODs, never secondary memberships. */
export function orgHeadcount(model: OrgModel, unit?: string, includeInactive = false): OrgCount {
  const scope = unit ? orgUnitPaths(model, unit) : null;
  const named = model.people.filter(
    (p) => (includeInactive || p.active) && (!scope || (p.primaryPod && scope.has(p.primaryPod))),
  ).length;
  const others = orgAnonymousGroups(model)
    .filter((group) => !scope || scope.has(group.pod))
    .reduce((sum, group) => sum + group.count, 0);
  return orgCount(named, others);
}

export interface OrgReportSummary {
  direct: OrgCount;
  total: OrgCount;
  people: OrgPerson[];
  groups: OrgAnonymousGroup[];
}

/** Both follows either kind of edge at each level, counting a person or group only once. */
export function orgReportingTotals(
  model: OrgModel,
  mode: OrgReportingMode,
  includeInactive = false,
): Map<string, OrgReportSummary> {
  const children = new Map<string, Set<string>>();
  for (const person of model.people) {
    const managers =
      mode === 'both' ? [person.functionalManager, person.entityManager] : [person[mode]];
    for (const manager of managers) {
      if (!manager || manager === person.path) continue;
      const reports = children.get(manager) ?? new Set<string>();
      reports.add(person.path);
      children.set(manager, reports);
    }
  }
  const anonymous = orgAnonymousGroups(model);
  const managersOf = (group: OrgAnonymousGroup) =>
    mode === 'both'
      ? [...group.functionalManagers, ...group.entityManagers]
      : mode === 'functionalManager'
        ? group.functionalManagers
        : group.entityManagers;
  const result = new Map<string, OrgReportSummary>();
  for (const manager of model.people) {
    const reached = new Set([manager.path]);
    const queue = [manager.path];
    for (let index = 0; index < queue.length; index++) {
      for (const child of children.get(queue[index] as string) ?? []) {
        if (reached.has(child)) continue;
        reached.add(child);
        queue.push(child);
      }
    }
    const direct = children.get(manager.path) ?? new Set<string>();
    const people = model.people.filter(
      (p) => p.path !== manager.path && (includeInactive || p.active) && reached.has(p.path),
    );
    const groups = anonymous.filter((group) => managersOf(group).some((path) => reached.has(path)));
    result.set(manager.path, {
      direct: orgCount(
        people.filter((p) => direct.has(p.path)).length,
        groups
          .filter((group) => managersOf(group).includes(manager.path))
          .reduce((sum, group) => sum + group.count, 0),
      ),
      total: orgCount(
        people.length,
        groups.reduce((sum, group) => sum + group.count, 0),
      ),
      people,
      groups,
    });
  }
  return result;
}

/** Follow a parent chain without repeating the start or looping on malformed Markdown. */
export function orgAncestors(start: string, parents: Map<string, string | null>): string[] {
  const result: string[] = [];
  const seen = new Set([start]);
  let parent = parents.get(start);
  while (parent && !seen.has(parent)) {
    result.push(parent);
    seen.add(parent);
    parent = parents.get(parent);
  }
  return result;
}

/** Each visible node occurs once; cycle participants become independent roots. */
export function orgForest<T extends { path: string }>(
  items: T[],
  parents: Map<string, string | null>,
  visible: Set<string>,
): { roots: T[]; children: Map<string, T[]> } {
  const cycles = orgCyclePaths(parents);
  const paths = new Set(items.filter((item) => visible.has(item.path)).map((item) => item.path));
  const roots: T[] = [];
  const children = new Map<string, T[]>();
  for (const item of items) {
    if (!paths.has(item.path)) continue;
    const parent = parents.get(item.path);
    if (!parent || !paths.has(parent) || cycles.has(item.path)) roots.push(item);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(item);
      children.set(parent, siblings);
    }
  }
  return { roots, children };
}

export interface OrgFilters {
  query?: string;
  country?: string;
  department?: string;
  showInactive?: boolean;
}

export function orgFilteredAnonymous(
  model: OrgModel,
  filters: OrgFilters = {},
): OrgAnonymousGroup[] {
  const scope = filters.department ? orgUnitPaths(model, filters.department) : null;
  const parents = new Map(model.units.map((unit) => [unit.path, unit.parent]));
  const titles = new Map(model.units.map((unit) => [unit.path, unit.title.toLowerCase()]));
  const needle = filters.query?.trim().toLowerCase();
  return orgAnonymousGroups(model).filter(
    (group) =>
      (!scope || scope.has(group.pod)) &&
      (!filters.country || group.country === filters.country) &&
      (!needle ||
        group.country.toLowerCase().includes(needle) ||
        [group.pod, ...orgAncestors(group.pod, parents)].some((path) =>
          titles.get(path)?.includes(needle),
        )),
  );
}

/** Shared structure/matrix filters, retaining ancestors as navigational context. */
export function orgFilteredView(model: OrgModel, filters: OrgFilters = {}) {
  const { query = '', country = '', department = '', showInactive = false } = filters;
  const personByPath = new Map(model.people.map((p) => [p.path, p]));
  const unitByPath = new Map(model.units.map((u) => [u.path, u]));
  const membersByUnit = new Map(model.units.map((u) => [u.path, orgMembers(model, u.path)]));
  const parents = new Map(model.units.map((u) => [u.path, u.parent]));
  const scope = department
    ? new Set((membersByUnit.get(department) ?? []).map((p) => p.path))
    : null;
  const needle = query.trim().toLowerCase();
  const groupMatches = new Set(
    needle
      ? model.units
          .filter((u) => u.title.toLowerCase().includes(needle))
          .flatMap((u) => (membersByUnit.get(u.path) ?? []).map((p) => p.path))
      : [],
  );
  const people = model.people.filter(
    (p) =>
      (!scope || scope.has(p.path)) &&
      (!country || p.country === country) &&
      (showInactive || p.active) &&
      (!needle ||
        groupMatches.has(p.path) ||
        `${p.title} ${p.role} ${p.country} ${p.region} ${unitByPath.get(p.primaryPod ?? '')?.title ?? ''}`
          .toLowerCase()
          .includes(needle)),
  );
  const peoplePaths = new Set(people.map((p) => p.path));
  const anonymous = orgFilteredAnonymous(model, filters);
  const visibleUnits = new Set(
    model.units
      .filter((u) => {
        if (
          department &&
          u.path !== department &&
          !orgAncestors(u.path, parents).includes(department)
        )
          return false;
        return (
          (!needle && !country) ||
          (Boolean(needle) && u.title.toLowerCase().includes(needle)) ||
          (membersByUnit.get(u.path) ?? []).some((p) => peoplePaths.has(p.path)) ||
          anonymous.some((group) => orgUnitPaths(model, u.path).has(group.pod))
        );
      })
      .map((u) => u.path),
  );
  for (const path of [...visibleUnits])
    for (const ancestor of orgAncestors(path, parents)) visibleUnits.add(ancestor);
  return {
    personByPath,
    unitByPath,
    membersByUnit,
    people,
    peoplePaths,
    anonymous,
    visibleUnits,
    totalActive: model.people.filter((p) => showInactive || p.active).length,
    countries: [
      ...new Set(
        [
          ...model.people.map((p) => p.country),
          ...orgAnonymousGroups(model).map((group) => group.country),
        ].filter(Boolean),
      ),
    ].sort(),
    primaryUnplaced: people.filter((p) => !p.primaryPod),
    structure: orgForest(model.units, parents, visibleUnits),
  };
}

/** A filtered reporting forest with managers retained, and optional focus on one subtree. */
export function orgReportingView(
  model: OrgModel,
  matchingPaths: Set<string>,
  chain: OrgChain,
  focus: string | null = null,
) {
  const parents = new Map(model.people.map((p) => [p.path, p[chain]]));
  const paths = new Set(
    [...matchingPaths].filter(
      (path) => !focus || path === focus || orgAncestors(path, parents).includes(focus),
    ),
  );
  if (focus && parents.has(focus)) paths.add(focus);
  for (const path of [...paths])
    for (const ancestor of orgAncestors(path, parents)) paths.add(ancestor);
  return { paths, parents, ...orgForest(model.people, parents, paths) };
}
