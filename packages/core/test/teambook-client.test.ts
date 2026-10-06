import { describe, expect, it, vi } from 'vitest';

// A made-up wire format stands in for the real adapter, which is completed
// on the work machine. This exercises transport only: auth, paging,
// concurrency, merging hierarchy with details, and error reporting.
vi.mock('../src/teambook/parse.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/teambook/parse.ts')>();
  return {
    ...real,
    authHeaders: (token: string) => ({ 'X-Api-Key': token }),
    endpoints: {
      pods: () => ({ path: 'teams' }),
      hierarchy: (root: string | null) => ({ path: `teams/${root}/tree` }),
      members: (id: string) => ({
        path: `teams/${encodeURIComponent(id)}/members`,
        query: { page: '1' },
      }),
    },
    nextPage: (req: { path: string; query?: Record<string, string> }, body: { more?: boolean }) =>
      body.more ? { ...req, query: { page: String(Number(req.query?.page ?? '1') + 1) } } : null,
    parseHierarchy: (body: unknown) =>
      real.asArray(body, 'tree').map((n, i) => {
        const o = real.asObject(n, `tree[${i}]`);
        return {
          id: real.asId(o.id, `tree[${i}].id`),
          name: '',
          parentId: o.parent == null ? null : real.asId(o.parent, `tree[${i}].parent`),
          kind: null,
          status: null,
          mandate: null,
        };
      }),
    parsePods: (body: unknown) =>
      real.asArray(body, 'teams').map((n, i) => {
        const o = real.asObject(n, `teams[${i}]`);
        return {
          id: real.asId(o.id, `teams[${i}].id`),
          name: real.asText(o.name, `teams[${i}].name`),
          parentId: null,
          kind: null,
          status: real.asOptionalText(o.state, `teams[${i}].state`),
          mandate: null,
        };
      }),
    parseMembers: (body: unknown, podId: string) => {
      const o = real.asObject(body, 'members');
      const people = real.asArray(o.people, 'members.people');
      return {
        users: people.map((p, i) => {
          const u = real.asObject(p, `members.people[${i}]`);
          return {
            id: real.asId(u.uid, `members.people[${i}].uid`),
            name: real.asText(u.name, `members.people[${i}].name`),
            email: real.asOptionalText(u.mail, `members.people[${i}].mail`),
            role: null,
            country: null,
            active: null,
          };
        }),
        memberships: people.map((p) => {
          const u = p as { uid: number; lead?: boolean };
          return { podId, userId: String(u.uid), primary: null, lead: u.lead === true };
        }),
      };
    },
  };
});

const { fetchTeambookSnapshot } = await import('../src/teambook/client.ts');

const API: Record<string, unknown> = {
  '/api/teams/D1/tree': [{ id: 'D1' }, { id: 'P1', parent: 'D1' }, { id: 'P/2', parent: 'D1' }],
  '/api/teams': [
    { id: 'D1', name: 'Dept', state: 'active' },
    { id: 'P1', name: 'Pod One' },
    { id: 'P/2', name: 'Pod Two' },
    { id: 'ELSEWHERE', name: 'Not in the subtree' },
  ],
  '/api/teams/D1/members?page=1': { people: [] },
  '/api/teams/P1/members?page=1': {
    people: [{ uid: 7, name: 'Ann', mail: 'ann@x.com', lead: true }],
    more: true,
  },
  '/api/teams/P1/members?page=2': { people: [{ uid: 8, name: 'Ben' }] },
  '/api/teams/P%2F2/members?page=1': { people: [{ uid: 7, name: 'Ann', mail: 'ann@x.com' }] },
};

function fakeFetch(seen: { url: string; headers: Headers }[] = []) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: `${url.pathname}${url.search}`, headers: new Headers(init?.headers) });
    const body = API[`${url.pathname}${url.search}`];
    return body === undefined ? new Response('nope', { status: 404 }) : Response.json(body);
  }) as unknown as typeof fetch;
}

describe('Teambook client', () => {
  it('fetches the subtree, pages through members, and merges details by id', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const progress: string[] = [];
    const { snapshot, warnings } = await fetchTeambookSnapshot(
      {
        baseUrl: 'https://tb.example.com/api/',
        token: 'KEY',
        fetch: fakeFetch(seen),
        concurrency: 2,
        onProgress: (p) => progress.push(`${p.phase}:${p.current}/${p.total}`),
      },
      'D1',
    );
    expect(seen.every((s) => s.headers.get('X-Api-Key') === 'KEY')).toBe(true);
    expect(snapshot.pods.map((p) => [p.id, p.name, p.parentId, p.status])).toEqual([
      ['D1', 'Dept', null, 'active'],
      ['P1', 'Pod One', 'D1', null],
      ['P/2', 'Pod Two', 'D1', null],
    ]);
    expect(snapshot.users.map((u) => u.id).sort()).toEqual(['7', '8']);
    expect(snapshot.memberships).toHaveLength(3);
    expect(snapshot.memberships.find((m) => m.userId === '7' && m.podId === 'P1')?.lead).toBe(true);
    expect(warnings).toEqual([]);
    expect(progress.at(-1)).toBe('members:3/3');
  });

  it('names the failing endpoint and hints at the token on 401', async () => {
    const denied = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchTeambookSnapshot(
        { baseUrl: 'https://tb.example.com/api', token: 'K', fetch: denied },
        'D1',
      ),
    ).rejects.toThrow('Teambook /api/teams/D1/tree: HTTP 401 (check the Teambook token)');
  });

  it('rejects responses that do not have the expected shape', async () => {
    const odd = vi.fn(async () => Response.json({ not: 'a list' })) as unknown as typeof fetch;
    await expect(
      fetchTeambookSnapshot(
        { baseUrl: 'https://tb.example.com/api', token: 'K', fetch: odd },
        'D1',
      ),
    ).rejects.toThrow('Teambook tree: unexpected response shape — expected a list, got object');
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const slow = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    ) as unknown as typeof fetch;
    const pending = fetchTeambookSnapshot(
      { baseUrl: 'https://tb.example.com/api', token: 'K', fetch: slow, signal: controller.signal },
      'D1',
    );
    controller.abort(new DOMException('Sync cancelled', 'AbortError'));
    await expect(pending).rejects.toThrow('Sync cancelled');
  });
});
