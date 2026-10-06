/**
 * Fetches a POD subtree from Teambook into a validated snapshot. Wire format
 * lives in parse.ts; this file is transport (base URL, auth, proxy, timeout,
 * pagination, concurrency) and structural validation, and needs no changes
 * to support the real API.
 */
import type { FetchFn } from '../jira/adapter.ts';
import * as adapter from './parse.ts';
import type { TeambookMembership, TeambookPod, TeambookSnapshot, TeambookUser } from './types.ts';
import { TeambookSchemaError } from './types.ts';

export interface TeambookClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchFn;
  timeoutSeconds?: number;
  /** POD member lists fetched in parallel */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: {
    phase: 'hierarchy' | 'pods' | 'members';
    current: number;
    total: number;
  }) => void;
}

/** GET a request and every following page; returns the parsed JSON bodies. */
async function getAll(
  opts: TeambookClientOptions,
  first: adapter.TeambookRequest,
): Promise<unknown[]> {
  const fetchFn = opts.fetch ?? fetch;
  const bodies: unknown[] = [];
  let request: adapter.TeambookRequest | null = first;
  for (let page = 0; request; page++) {
    if (page >= 1000) throw new Error(`Teambook ${first.path}: more than 1000 pages`);
    const url = new URL(request.path.replace(/^\/+/, ''), `${opts.baseUrl.replace(/\/+$/, '')}/`);
    for (const [k, v] of Object.entries(request.query ?? {})) url.searchParams.set(k, v);
    const signals = [AbortSignal.timeout((opts.timeoutSeconds ?? 60) * 1000)];
    if (opts.signal) signals.push(opts.signal);
    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: adapter.authHeaders(opts.token),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      opts.signal?.throwIfAborted();
      throw new Error(`Teambook ${url.pathname}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check the Teambook token)' : '';
      throw new Error(`Teambook ${url.pathname}: HTTP ${res.status}${hint}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TeambookSchemaError(url.pathname, 'the response is not JSON');
    }
    bodies.push(body);
    request = adapter.nextPage(request, body, res.headers);
  }
  return bodies;
}

async function pool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

export async function fetchTeambookSnapshot(
  opts: TeambookClientOptions,
  rootId: string | null,
): Promise<{ snapshot: TeambookSnapshot; warnings: string[] }> {
  const progress = opts.onProgress ?? (() => {});
  progress({ phase: 'hierarchy', current: 0, total: 0 });
  const tree = (await getAll(opts, adapter.endpoints.hierarchy(rootId))).flatMap((b) =>
    adapter.parseHierarchy(b, rootId),
  );

  const detailsRequest = adapter.endpoints.pods();
  let details: TeambookPod[] = [];
  if (detailsRequest) {
    progress({ phase: 'pods', current: 0, total: 0 });
    details = (await getAll(opts, detailsRequest)).flatMap((b) => adapter.parsePods(b));
  }
  const pods = mergePods(tree, details);

  const users: TeambookUser[] = [];
  const memberships: TeambookMembership[] = [];
  let done = 0;
  await pool(pods, opts.concurrency ?? 4, async (pod) => {
    const bodies = await getAll(opts, adapter.endpoints.members(pod.id));
    for (const body of bodies) {
      const parsed = adapter.parseMembers(body, pod.id);
      users.push(...parsed.users);
      memberships.push(...parsed.memberships);
    }
    progress({ phase: 'members', current: ++done, total: pods.length });
  });

  return normalizeSnapshot({
    version: 1,
    fetchedAt: new Date().toISOString(),
    rootId,
    pods,
    users,
    memberships,
  });
}

/** Hierarchy decides which PODs exist and where; details fill in what it lacks. */
function mergePods(tree: TeambookPod[], details: TeambookPod[]): TeambookPod[] {
  const byId = new Map(details.map((p) => [p.id, p]));
  return tree.map((p) => {
    const d = byId.get(p.id);
    if (!d) return p;
    return {
      ...p,
      name: p.name || d.name,
      kind: p.kind ?? d.kind,
      status: p.status ?? d.status,
      mandate: p.mandate ?? d.mandate,
    };
  });
}

/**
 * Structural checks every snapshot passes before planning, whether it came
 * from the API or a fixture file: unique PODs, a parent chain without
 * cycles, memberships that point at known PODs and users, one record per
 * user. Problems that make the data untrustworthy throw; the rest warn.
 */
export function normalizeSnapshot(input: TeambookSnapshot): {
  snapshot: TeambookSnapshot;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (input.version !== 1) throw new TeambookSchemaError('snapshot', 'unsupported version');
  const pods = new Map<string, TeambookPod>();
  for (const p of input.pods) {
    if (!p.id || !p.name) throw new TeambookSchemaError('snapshot', 'a POD without id or name');
    if (pods.has(p.id)) throw new TeambookSchemaError('snapshot', `POD ${p.id} appears twice`);
    pods.set(p.id, p);
  }
  for (const p of pods.values()) {
    if (p.parentId && !pods.has(p.parentId)) {
      warnings.push(
        `POD "${p.name}" has parent ${p.parentId} outside the fetched tree; treated as a root`,
      );
      pods.set(p.id, { ...p, parentId: null });
    }
  }
  for (const start of pods.values()) {
    const seen = new Set<string>();
    for (let at: TeambookPod | undefined = start; at?.parentId; at = pods.get(at.parentId)) {
      if (seen.has(at.id))
        throw new TeambookSchemaError('snapshot', `POD parents form a cycle at "${at.name}"`);
      seen.add(at.id);
    }
  }

  const users = new Map<string, TeambookUser>();
  for (const u of input.users) {
    if (!u.id || !u.name) throw new TeambookSchemaError('snapshot', 'a user without id or name');
    const seen = users.get(u.id);
    if (!seen) users.set(u.id, u);
    else if (seen.email !== u.email || seen.name !== u.name)
      warnings.push(`user ${u.id} differs between POD lists; using the first ("${seen.name}")`);
  }

  const memberships = new Map<string, TeambookMembership>();
  for (const m of input.memberships) {
    if (!pods.has(m.podId) || !users.has(m.userId)) {
      warnings.push(`membership ${m.userId} → ${m.podId} points outside the snapshot; ignored`);
      continue;
    }
    const key = `${m.userId}\u0000${m.podId}`;
    const prev = memberships.get(key);
    memberships.set(
      key,
      prev ? { ...prev, lead: prev.lead || m.lead, primary: prev.primary ?? m.primary } : { ...m },
    );
  }
  const primaries = new Map<string, number>();
  for (const m of memberships.values())
    if (m.primary) primaries.set(m.userId, (primaries.get(m.userId) ?? 0) + 1);
  for (const [userId, n] of primaries)
    if (n > 1) {
      warnings.push(
        `${users.get(userId)?.name ?? userId} has ${n} primary PODs in Teambook; primary left undecided`,
      );
      for (const m of memberships.values()) if (m.userId === userId) m.primary = null;
    }

  return {
    snapshot: {
      ...input,
      pods: [...pods.values()],
      users: [...users.values()],
      memberships: [...memberships.values()],
    },
    warnings,
  };
}
