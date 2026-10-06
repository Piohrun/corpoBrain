/**
 * Plans a Teambook import as a list of reviewable changes, without writing.
 *
 * Safety model (docs/TEAMBOOK.md):
 *  - Matching: teambook_id, then email (people), then a unique exact title.
 *    Anything ambiguous is blocked, never guessed.
 *  - Three-way merge per field against the baseline (what the last import
 *    wrote): an empty field is filled; a field still equal to the baseline
 *    follows Teambook; a field the user changed is a CONFLICT and is not
 *    selected unless the user opts in.
 *  - Lists only grow, and an item the user removed after an import is not
 *    added back. Nothing is ever cleared, deleted or renamed; note bodies and
 *    keys outside the field lists below are never touched.
 */
import { normalizeCountry } from '../holidays.ts';
import { identitiesOf } from '../identities.ts';
import {
  buildOrganization,
  type OrgKind,
  type OrgSource,
  orgParentAllowed,
  orgStrings,
  orgText,
} from '../organization.ts';
import type { TeambookPod, TeambookSnapshot } from './types.ts';

export type Scope = 'unit' | 'person';
/** Field values in Teambook terms: references are Teambook ids, not paths. */
export type BaselineValue = string | string[] | null;

export interface TeambookBaseline {
  version: 1;
  /** per Teambook id, per field: the value the last import left in the note */
  unit: Record<string, Record<string, BaselineValue>>;
  person: Record<string, Record<string, BaselineValue>>;
  /** change id → the incoming value the user chose to ignore */
  dismissed: Record<string, BaselineValue>;
}

export const emptyBaseline = (): TeambookBaseline => ({
  version: 1,
  unit: {},
  person: {},
  dismissed: {},
});

export type ChangeStatus =
  | 'new' // create a note
  | 'link' // tie an existing note to its Teambook id (matched by email/title)
  | 'fill' // the field is empty locally
  | 'update' // unchanged since the last import; Teambook changed it
  | 'add' // add items to a list
  | 'conflict' // the local value was edited; Teambook says otherwise
  | 'dismissed' // a conflict the user already chose to ignore
  | 'left' // Teambook says the person left / is gone from their POD
  | 'blocked'; // cannot be applied safely (see reason)

export interface TeambookChange {
  /** `${scope}:${teambookId}:${field|create|link|deactivate}` */
  id: string;
  scope: Scope;
  externalId: string;
  title: string;
  /** existing note, or where a new one will be created */
  path: string;
  field: string | null;
  /** frontmatter as it is (raw) and as it would be written */
  current: unknown;
  next: unknown;
  status: ChangeStatus;
  /** pre-selected in the review screen */
  selected: boolean;
  reason: string;
  /** changes that must be applied too (a link or create this depends on) */
  requires: string[];
  /** the value in Teambook terms, recorded in the baseline when applied */
  incoming: BaselineValue;
}

export interface TeambookMatch {
  scope: Scope;
  externalId: string;
  name: string;
  path: string | null;
  by: 'id' | 'email' | 'title' | 'new' | 'ambiguous' | 'skipped';
  detail: string;
}

export interface TeambookPlan {
  snapshotAt: string;
  changes: TeambookChange[];
  matches: TeambookMatch[];
  /** fields already equal to Teambook: recorded in the baseline on apply */
  agreed: { scope: Scope; externalId: string; field: string; value: BaselineValue }[];
  warnings: string[];
}

export interface PlanOptions {
  folders: { people: string; organization: string };
  /** every path in the vault, to keep new file names unique */
  existingPaths: Set<string>;
  createUnits: boolean;
  createPeople: boolean;
}

/** Every field the importer may ever write, per scope. Nothing else is touched. */
export const TEAMBOOK_FIELDS = {
  unit: ['title', 'org_kind', 'parent', 'leads', 'status', 'mandate'],
  person: ['title', 'email', 'role', 'country', 'primary_pod', 'secondary_pods'],
} as const;
export const TEAMBOOK_ID_KEY = 'teambook_id';

const LIST_FIELDS = new Set(['leads', 'email', 'secondary_pods']);

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'unnamed'
  );
}

/**
 * Levels for PODs whose kind Teambook does not state: a root with children
 * is a department, a node with children below that a product area, and a
 * leaf a POD. Deeper trees cannot be represented and surface as blocked
 * parent changes rather than being flattened silently.
 */
export function inferKinds(pods: TeambookPod[]): Map<string, OrgKind> {
  const children = new Map<string, number>();
  for (const p of pods)
    if (p.parentId) children.set(p.parentId, (children.get(p.parentId) ?? 0) + 1);
  const byId = new Map(pods.map((p) => [p.id, p]));
  const depth = (p: TeambookPod) => {
    let d = 0;
    for (let at = p; at.parentId && d < 100; d++) at = byId.get(at.parentId) as TeambookPod;
    return d;
  };
  const kinds = new Map<string, OrgKind>();
  for (const p of pods) {
    if (p.kind) kinds.set(p.id, p.kind);
    else if (!children.has(p.id)) kinds.set(p.id, 'pod');
    else kinds.set(p.id, depth(p) === 0 ? 'department' : 'product_area');
  }
  return kinds;
}

const norm = (s: string) => s.trim().toLowerCase();
const wikilink = (path: string) => `[[${path.replace(/\.md$/i, '')}]]`;
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const sameValue = (a: BaselineValue | undefined, b: BaselineValue | undefined) =>
  Array.isArray(a) && Array.isArray(b) ? sameList(a, b) : a === b;

export function planTeambookImport(
  snapshot: TeambookSnapshot,
  sources: OrgSource[],
  baseline: TeambookBaseline,
  opts: PlanOptions,
): TeambookPlan {
  const plan: TeambookPlan = {
    snapshotAt: snapshot.fetchedAt,
    changes: [],
    matches: [],
    agreed: [],
    warnings: [],
  };
  const model = buildOrganization(sources);
  const units = sources.filter((s) => s.type === 'org_unit');
  const people = sources.filter((s) => s.type === 'person');
  const unitModel = new Map(model.units.map((u) => [u.path, u]));
  const personModel = new Map(model.people.map((p) => [p.path, p]));
  const kinds = inferKinds(snapshot.pods);
  const taken = new Set([...opts.existingPaths].map((p) => p.toLowerCase()));

  // ── local indexes ────────────────────────────────────────────────
  const byExternal = (list: OrgSource[], scope: Scope) => {
    const map = new Map<string, string[]>();
    for (const s of list) {
      const id =
        orgText(s.fm[TEAMBOOK_ID_KEY]) ||
        (typeof s.fm[TEAMBOOK_ID_KEY] === 'number' ? String(s.fm[TEAMBOOK_ID_KEY]) : '');
      if (!id) continue;
      map.set(id, [...(map.get(id) ?? []), s.path]);
    }
    for (const [id, paths] of map)
      if (paths.length > 1)
        plan.warnings.push(
          `${scope === 'unit' ? 'Organization notes' : 'Person notes'} ${paths.join(', ')} share teambook_id ${id}; none of them is updated until that is fixed`,
        );
    return map;
  };
  const unitById = byExternal(units, 'unit');
  const personById = byExternal(people, 'person');
  const linkedPaths = new Set([...unitById.values(), ...personById.values()].flat());
  const byTitle = (list: OrgSource[]) => {
    const map = new Map<string, string[]>();
    for (const s of list) {
      if (linkedPaths.has(s.path)) continue; // already tied to another Teambook id
      for (const t of new Set([s.title, ...orgStrings(s.fm.aliases)].map(norm)))
        map.set(t, [...(map.get(t) ?? []), s.path]);
    }
    return map;
  };
  const unitByTitle = byTitle(units);
  const personByTitle = byTitle(people);
  const personByEmail = new Map<string, string[]>();
  for (const s of people)
    for (const e of identitiesOf(s.fm, 'email'))
      personByEmail.set(e, [...(personByEmail.get(e) ?? []), s.path]);
  const fmOf = new Map(sources.map((s) => [s.path, s.fm]));

  // ── matching ─────────────────────────────────────────────────────
  /** Teambook id → note path (existing or planned), for references */
  const unitPath = new Map<string, string>();
  const personPath = new Map<string, string>();
  /** the change a reference to this note depends on (its link or create) */
  const gate = new Map<string, string>();
  const claimed = new Set<string>();

  const plannedPath = (folder: string, name: string) => {
    const base = `${folder}/${slugify(name)}`;
    for (let n = 1; ; n++) {
      const path = `${base}${n === 1 ? '' : `-${n}`}.md`;
      if (!taken.has(path.toLowerCase())) {
        taken.add(path.toLowerCase());
        return path;
      }
    }
  };

  type Matched = { path: string; by: TeambookMatch['by']; detail: string } | null;
  const settle = (
    scope: Scope,
    externalId: string,
    name: string,
    candidates: [TeambookMatch['by'], string[] | undefined][],
  ): Matched => {
    for (const [by, raw] of candidates) {
      const paths = (raw ?? []).filter((p) => by === 'id' || !claimed.has(p));
      if (!paths.length) continue;
      if (paths.length > 1) {
        plan.matches.push({
          scope,
          externalId,
          name,
          path: null,
          by: 'ambiguous',
          detail: `${by} matches ${paths.join(', ')}`,
        });
        return null;
      }
      const path = paths[0] as string;
      claimed.add(path);
      return { path, by, detail: by === 'id' ? 'teambook_id' : `same ${by}` };
    }
    return { path: '', by: 'new', detail: '' };
  };

  for (const pod of snapshot.pods) {
    const hit = settle('unit', pod.id, pod.name, [
      ['id', unitById.get(pod.id)],
      ['title', unitByTitle.get(norm(pod.name))],
    ]);
    if (!hit) continue;
    if (hit.by === 'new') {
      if (!opts.createUnits) {
        plan.matches.push({
          scope: 'unit',
          externalId: pod.id,
          name: pod.name,
          path: null,
          by: 'skipped',
          detail: 'creating organization notes is off',
        });
        continue;
      }
      hit.path = plannedPath(opts.folders.organization, pod.name);
      gate.set(`unit:${pod.id}`, `unit:${pod.id}:create`);
    } else if (hit.by !== 'id') gate.set(`unit:${pod.id}`, `unit:${pod.id}:link`);
    unitPath.set(pod.id, hit.path);
    plan.matches.push({
      scope: 'unit',
      externalId: pod.id,
      name: pod.name,
      path: hit.path,
      by: hit.by,
      detail: hit.detail,
    });
  }

  for (const user of snapshot.users) {
    const email = user.email ? norm(user.email) : null;
    // A title match is refused when the note's own email says it is someone else.
    const titleHits = (personByTitle.get(norm(user.name)) ?? []).filter((p) => {
      const emails = identitiesOf(fmOf.get(p) ?? {}, 'email');
      return !email || !emails.length || emails.includes(email);
    });
    const hit = settle('person', user.id, user.name, [
      ['id', personById.get(user.id)],
      ['email', email ? personByEmail.get(email) : undefined],
      ['title', titleHits],
    ]);
    if (!hit) continue;
    if (hit.by === 'new') {
      if (!opts.createPeople) {
        plan.matches.push({
          scope: 'person',
          externalId: user.id,
          name: user.name,
          path: null,
          by: 'skipped',
          detail: 'creating person notes is off',
        });
        continue;
      }
      hit.path = plannedPath(opts.folders.people, user.name);
      gate.set(`person:${user.id}`, `person:${user.id}:create`);
    } else if (hit.by !== 'id') gate.set(`person:${user.id}`, `person:${user.id}:link`);
    personPath.set(user.id, hit.path);
    plan.matches.push({
      scope: 'person',
      externalId: user.id,
      name: user.name,
      path: hit.path,
      by: hit.by,
      detail: hit.detail,
    });
  }

  // ── local values in Teambook terms ───────────────────────────────
  const unitIdOfPath = new Map([...unitPath].map(([id, p]) => [p, id]));
  const personIdOfPath = new Map([...personPath].map(([id, p]) => [p, id]));
  for (const [id, paths] of unitById)
    if (paths.length === 1) unitIdOfPath.set(paths[0] as string, id);
  for (const [id, paths] of personById)
    if (paths.length === 1) personIdOfPath.set(paths[0] as string, id);
  // An unlinked local target can never equal a Teambook id.
  const asUnitId = (path: string | null) =>
    path ? (unitIdOfPath.get(path) ?? `local:${path}`) : null;
  const asPersonId = (path: string) => personIdOfPath.get(path) ?? `local:${path}`;

  const localUnit = (path: string, field: string): BaselineValue => {
    const u = unitModel.get(path);
    const fm = fmOf.get(path) ?? {};
    if (field === 'parent') return asUnitId(u?.parent ?? null);
    if (field === 'leads') return (u?.leads ?? []).map(asPersonId);
    return orgText(fm[field]) || null;
  };
  const localPerson = (path: string, field: string): BaselineValue => {
    const p = personModel.get(path);
    const fm = fmOf.get(path) ?? {};
    if (field === 'email') return identitiesOf(fm, 'email');
    if (field === 'primary_pod') return asUnitId(p?.primaryPod ?? null);
    if (field === 'secondary_pods')
      return (p?.secondaryPods ?? []).map((x) => asUnitId(x) as string);
    return orgText(fm[field]) || null;
  };

  // ── incoming values ──────────────────────────────────────────────
  const leadsOf = new Map<string, string[]>();
  const podsOf = new Map<string, { podId: string; primary: boolean | null }[]>();
  for (const m of snapshot.memberships) {
    if (m.lead) leadsOf.set(m.podId, [...(leadsOf.get(m.podId) ?? []), m.userId]);
    podsOf.set(m.userId, [...(podsOf.get(m.userId) ?? []), { podId: m.podId, primary: m.primary }]);
  }
  const incomingUnit = (pod: TeambookPod): Record<string, BaselineValue> => ({
    title: pod.name,
    org_kind: kinds.get(pod.id) ?? 'pod',
    parent: pod.parentId,
    leads: (leadsOf.get(pod.id) ?? []).filter((id) => personPath.has(id)),
    status: pod.status,
    mandate: pod.mandate,
  });
  const primaryOf = (userId: string, localPrimary: BaselineValue): string | null => {
    const memberships = podsOf.get(userId) ?? [];
    const flagged = memberships.filter((m) => m.primary === true);
    if (flagged.length === 1) return (flagged[0] as { podId: string }).podId;
    const unflagged = memberships.filter((m) => m.primary !== false);
    if (memberships.length === 1 && unflagged.length === 1)
      return (unflagged[0] as { podId: string }).podId;
    // Undecided: keep whatever the note says if Teambook lists that POD at all.
    return typeof localPrimary === 'string' && memberships.some((m) => m.podId === localPrimary)
      ? localPrimary
      : null;
  };

  // ── field decisions ──────────────────────────────────────────────
  const render = (scope: Scope, field: string, value: BaselineValue): unknown => {
    const ref = (id: string) => {
      const target = field === 'leads' ? personPath.get(id) : unitPath.get(id);
      return target ? wikilink(target) : null;
    };
    if (field === 'parent' || field === 'primary_pod')
      return typeof value === 'string' ? ref(value) : null;
    if (field === 'leads' || field === 'secondary_pods')
      return (value as string[]).map(ref).filter(Boolean);
    void scope;
    return value;
  };
  const refGates = (field: string, ids: string[]) =>
    ids
      .map((id) => gate.get(`${field === 'leads' ? 'person' : 'unit'}:${id}`))
      .filter((g): g is string => !!g);

  const decide = (
    scope: Scope,
    externalId: string,
    title: string,
    path: string,
    field: string,
    local: BaselineValue,
    incoming: BaselineValue,
    rawLocal: unknown,
    requires: string[],
  ) => {
    const id = `${scope}:${externalId}:${field}`;
    const base = baseline[scope][externalId]?.[field];
    const isRef = ['parent', 'primary_pod', 'leads', 'secondary_pods'].includes(field);
    const push = (
      c: Omit<
        TeambookChange,
        'id' | 'scope' | 'externalId' | 'title' | 'path' | 'field' | 'current' | 'requires'
      > & { requires?: string[] },
    ) =>
      plan.changes.push({
        id,
        scope,
        externalId,
        title,
        path,
        field,
        current: rawLocal ?? null,
        ...c,
        // after the spread: a change keeps its note's own link/create as well
        requires: [...new Set([...requires, ...(c.requires ?? [])])],
      });

    if (incoming === null || (Array.isArray(incoming) && !incoming.length)) return; // never clear
    if (LIST_FIELDS.has(field)) {
      const have = new Set(local as string[]);
      const removedByUser = new Set(Array.isArray(base) ? base.filter((x) => !have.has(x)) : []);
      const missing = (incoming as string[]).filter((x) => !have.has(x) && !removedByUser.has(x));
      if (!missing.length) {
        plan.agreed.push({ scope, externalId, field, value: incoming });
        return;
      }
      const rawList = Array.isArray(rawLocal) ? rawLocal : rawLocal ? [rawLocal] : [];
      const additions = isRef ? (render(scope, field, missing) as string[]) : missing;
      push({
        next: [...rawList, ...additions],
        status: 'add',
        selected: true,
        reason: `add ${missing.length} from Teambook${removedByUser.size ? ` (skipping ${removedByUser.size} you removed)` : ''}`,
        incoming,
        requires: isRef ? refGates(field, missing) : [],
      });
      return;
    }
    const same =
      field === 'country' && typeof local === 'string' && typeof incoming === 'string'
        ? normalizeCountry(local) === normalizeCountry(incoming)
        : sameValue(local, incoming);
    if (same) {
      plan.agreed.push({ scope, externalId, field, value: incoming });
      return;
    }
    const next = isRef ? render(scope, field, incoming) : incoming;
    if (isRef && next === null) return; // target not importable (skipped/ambiguous)
    const extraGates = isRef && typeof incoming === 'string' ? refGates(field, [incoming]) : [];
    if (field === 'parent' && typeof incoming === 'string') {
      const childKind = (orgText(fmOf.get(path)?.org_kind) || kinds.get(externalId)) as OrgKind;
      const parentPath = unitPath.get(incoming);
      const parentKind =
        (parentPath && orgText(fmOf.get(parentPath)?.org_kind)) || kinds.get(incoming);
      if (!parentKind || !orgParentAllowed(childKind, parentKind as OrgKind)) {
        push({
          next,
          status: 'blocked',
          selected: false,
          reason: `a ${childKind} cannot sit under a ${parentKind ?? 'unknown level'} in corpoBrain`,
          incoming,
          requires: extraGates,
        });
        return;
      }
    }
    // Teambook still says what it said last time: your edit stands, silently.
    if (base !== undefined && sameValue(incoming, base)) return;
    if (local === null) {
      push({
        next,
        status: 'fill',
        selected: true,
        reason: 'empty in your note',
        incoming,
        requires: extraGates,
      });
    } else if (base !== undefined && sameValue(local, base)) {
      push({
        next,
        status: 'update',
        selected: true,
        reason: 'changed in Teambook since the last import; you had not edited it',
        incoming,
        requires: extraGates,
      });
    } else if (id in baseline.dismissed && sameValue(baseline.dismissed[id], incoming)) {
      push({
        next,
        status: 'dismissed',
        selected: false,
        reason: 'you chose to keep your value',
        incoming,
        requires: extraGates,
      });
    } else {
      push({
        next,
        status: 'conflict',
        selected: false,
        reason:
          base === undefined
            ? 'your note says otherwise (never imported before)'
            : 'you edited this after the last import',
        incoming,
        requires: extraGates,
      });
    }
  };

  // ── units ────────────────────────────────────────────────────────
  for (const pod of snapshot.pods) {
    const path = unitPath.get(pod.id);
    if (!path) continue;
    const incoming = incomingUnit(pod);
    const ownGate = gate.get(`unit:${pod.id}`);
    if (ownGate?.endsWith(':create')) {
      createChange('unit', pod.id, pod.name, path, incoming);
      continue;
    }
    if (ownGate) linkChange('unit', pod.id, pod.name, path);
    const fm = fmOf.get(path) ?? {};
    for (const field of TEAMBOOK_FIELDS.unit) {
      if (field === 'org_kind') {
        const local = orgText(fm.org_kind) || null;
        if (local && local !== incoming.org_kind && !pod.kind) continue; // inferred levels never argue with yours
        if (local && local !== incoming.org_kind)
          plan.changes.push({
            id: `unit:${pod.id}:org_kind`,
            scope: 'unit',
            externalId: pod.id,
            title: pod.name,
            path,
            field,
            current: local,
            next: incoming.org_kind,
            status: 'blocked',
            selected: false,
            reason: 'changing a level is not done by import; edit the note if Teambook is right',
            requires: [],
            incoming: incoming.org_kind ?? null,
          });
        continue;
      }
      decide(
        'unit',
        pod.id,
        pod.name,
        path,
        field,
        localUnit(path, field),
        incoming[field] ?? null,
        fm[field],
        ownGate ? [ownGate] : [],
      );
    }
  }

  // ── people ───────────────────────────────────────────────────────
  for (const user of snapshot.users) {
    const path = personPath.get(user.id);
    if (!path) continue;
    const ownGate = gate.get(`person:${user.id}`);
    const fm = fmOf.get(path) ?? {};
    const localPrimary = ownGate?.endsWith(':create') ? null : localPerson(path, 'primary_pod');
    const primary = primaryOf(user.id, localPrimary);
    const memberPods = (podsOf.get(user.id) ?? [])
      .map((m) => m.podId)
      .filter((id) => unitPath.has(id));
    const incoming: Record<string, BaselineValue> = {
      title: user.name,
      email: user.email ? [norm(user.email)] : [],
      role: user.role,
      country: user.country,
      primary_pod: primary && unitPath.has(primary) ? primary : null,
      secondary_pods: memberPods.filter((id) => id !== primary && id !== localPrimary),
    };
    if (!primary && memberPods.length > 1)
      plan.warnings.push(
        `${user.name}: Teambook does not say which of ${memberPods.length} PODs is primary; primary POD left as it is`,
      );
    if (ownGate?.endsWith(':create')) {
      createChange('person', user.id, user.name, path, incoming);
      continue;
    }
    if (ownGate) linkChange('person', user.id, user.name, path);
    for (const field of TEAMBOOK_FIELDS.person)
      decide(
        'person',
        user.id,
        user.name,
        path,
        field,
        localPerson(path, field),
        incoming[field] ?? null,
        fm[field],
        ownGate ? [ownGate] : [],
      );
    if (user.active === false && fm.active !== false)
      plan.changes.push({
        id: `person:${user.id}:deactivate`,
        scope: 'person',
        externalId: user.id,
        title: user.name,
        path,
        field: 'active',
        current: fm.active ?? null,
        next: false,
        status: 'left',
        selected: false,
        reason: 'Teambook marks this person inactive',
        requires: ownGate ? [ownGate] : [],
        incoming: null,
      });
  }

  // Linked people missing from a POD they belong to in the fetched tree.
  const inSnapshot = new Set(snapshot.users.map((u) => u.id));
  const fetchedPods = new Set(snapshot.pods.map((p) => p.id));
  for (const [id, paths] of personById) {
    if (inSnapshot.has(id) || paths.length !== 1) continue;
    const path = paths[0] as string;
    const fm = fmOf.get(path) ?? {};
    const primary = asUnitId(personModel.get(path)?.primaryPod ?? null);
    if (fm.active === false || !primary || !fetchedPods.has(primary)) continue;
    plan.changes.push({
      id: `person:${id}:deactivate`,
      scope: 'person',
      externalId: id,
      title: personModel.get(path)?.title ?? path,
      path,
      field: 'active',
      current: fm.active ?? null,
      next: false,
      status: 'left',
      selected: false,
      reason: 'no longer listed in their primary POD in Teambook (moved or left?)',
      requires: [],
      incoming: null,
    });
  }
  for (const [id, paths] of unitById)
    if (!fetchedPods.has(id) && paths.length === 1 && snapshot.rootId !== null) {
      const parent = asUnitId(unitModel.get(paths[0] as string)?.parent ?? null);
      if (parent && fetchedPods.has(parent))
        plan.warnings.push(`${paths[0]} is no longer in Teambook under its parent; left untouched`);
    }

  return plan;

  function linkChange(scope: Scope, externalId: string, title: string, path: string) {
    const match = plan.matches.find((m) => m.scope === scope && m.externalId === externalId);
    plan.changes.push({
      id: `${scope}:${externalId}:link`,
      scope,
      externalId,
      title,
      path,
      field: TEAMBOOK_ID_KEY,
      current: null,
      next: externalId,
      status: 'link',
      selected: true,
      reason: `your note ${path} has the ${match?.by === 'email' ? 'same email' : 'same title'}`,
      requires: [],
      incoming: externalId,
    });
  }

  function createChange(
    scope: Scope,
    externalId: string,
    title: string,
    path: string,
    incoming: Record<string, BaselineValue>,
  ) {
    const fields: Record<string, unknown> = {};
    const requires = new Set<string>();
    for (const field of TEAMBOOK_FIELDS[scope]) {
      const value = incoming[field] ?? null;
      if (value === null || (Array.isArray(value) && !value.length)) continue;
      const isRef = ['parent', 'primary_pod', 'leads', 'secondary_pods'].includes(field);
      if (isRef) {
        const ids = Array.isArray(value) ? value : [value];
        for (const g of refGates(field, ids)) requires.add(g);
        const rendered = render(scope, field, value);
        if (rendered === null || (Array.isArray(rendered) && !rendered.length)) continue;
        fields[field] = rendered;
      } else fields[field] = field === 'email' ? (value as string[])[0] : value;
    }
    if (scope === 'unit' && typeof incoming.parent === 'string') {
      const parentKind =
        orgText(fmOf.get(unitPath.get(incoming.parent) ?? '')?.org_kind) ||
        kinds.get(incoming.parent);
      if (parentKind && !orgParentAllowed(incoming.org_kind as OrgKind, parentKind as OrgKind)) {
        delete fields.parent;
        plan.warnings.push(
          `${title}: a ${incoming.org_kind} cannot sit under a ${parentKind}; created without a parent`,
        );
      }
    }
    plan.changes.push({
      id: `${scope}:${externalId}:create`,
      scope,
      externalId,
      title,
      path,
      field: null,
      current: null,
      next: fields,
      status: 'new',
      selected: true,
      reason: `not in your vault yet`,
      requires: [...requires].filter((g) => g !== `${scope}:${externalId}:create`),
      incoming: null,
    });
    // what a create writes is what the baseline starts from
    for (const [field, value] of Object.entries(incoming))
      if (value !== null && !(Array.isArray(value) && !value.length))
        plan.agreed.push({ scope, externalId, field, value });
  }
}
