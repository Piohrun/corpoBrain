/**
 * Jira HTTP adapter per docs/PLAN.md: supports Data Center (/rest/api/2,
 * startAt paging, Bearer PAT) and Cloud (/rest/api/3/search/jql,
 * nextPageToken paging, Basic email+token). Deployment is probed once via
 * /rest/api/2/serverInfo when config says "auto".
 */

export interface JiraAuth {
  /** bearer: PAT. basic: email + token. */
  mode: 'bearer' | 'basic';
  token: string;
  email?: string;
}

export interface RawIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
  originBoardId?: number;
}

export interface JiraDeploymentInfo {
  deployment: 'datacenter' | 'cloud';
  version: string;
}

export type FetchFn = typeof fetch;

const DEFAULT_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'components',
  'fixVersions',
  'created',
  'updated',
  'resolutiondate',
  'issuelinks',
  'parent',
  'comment',
];

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class JiraAdapter {
  private deployment: 'datacenter' | 'cloud' | null;

  constructor(
    readonly baseUrl: string,
    readonly auth: JiraAuth,
    deployment: 'auto' | 'datacenter' | 'cloud' = 'auto',
    private readonly fetchFn: FetchFn = fetch,
    /** per-request timeout; a blackholed connection fails fast instead of hanging */
    private readonly timeoutMs = 30_000,
  ) {
    this.deployment = deployment === 'auto' ? null : deployment;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.auth.mode === 'bearer') {
      h.Authorization = `Bearer ${this.auth.token}`;
    } else {
      const cred = Buffer.from(`${this.auth.email ?? ''}:${this.auth.token}`).toString('base64');
      h.Authorization = `Basic ${cred}`;
    }
    return h;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new JiraError(0, `cannot reach ${url.host}: ${describeNetworkError(e)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new JiraError(
        res.status,
        `${res.status} ${res.statusText} for ${path}: ${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Write helper: PUT/POST with the same error wrapping as get(). */
  private async send(
    method: 'PUT' | 'POST',
    path: string,
    body: unknown,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new JiraError(0, `cannot reach ${url.host}: ${describeNetworkError(e)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JiraError(
        res.status,
        `${res.status} ${res.statusText} for ${method} ${path}: ${text.slice(0, 300)}`,
      );
    }
    if (res.status === 204) return null;
    return await res.json().catch(() => null);
  }

  /** Current values of specific fields for one issue (preview/recheck). */
  async issueFields(key: string, fields: string[]): Promise<Record<string, unknown>> {
    const data = await this.get<{ fields: Record<string, unknown> }>(
      `rest/api/2/issue/${encodeURIComponent(key)}`,
      { fields: fields.join(',') },
    );
    return data.fields ?? {};
  }

  /**
   * Set (or clear with null) the assignee. DC identifies by name, Cloud by
   * accountId. On DC, notifyUsers=false suppresses the email storm a batch
   * would otherwise cause.
   */
  async setAssignee(key: string, assignee: string | null): Promise<void> {
    const deployment = await this.ensureDeployment();
    const value =
      assignee === null
        ? null
        : deployment === 'datacenter'
          ? { name: assignee }
          : { accountId: assignee };
    await this.send(
      'PUT',
      `rest/api/2/issue/${encodeURIComponent(key)}`,
      { fields: { assignee: value } },
      deployment === 'datacenter' ? { notifyUsers: 'false' } : {},
    );
  }

  /**
   * The issue's current open sprint via the Agile issue resource, which
   * exposes `sprint` under a stable name on DC and Cloud alike (the REST
   * search only has it under a per-instance custom field id).
   */
  async issueSprint(key: string): Promise<{ id: number; name: string } | null> {
    const data = await this.get<{ fields?: { sprint?: { id: number; name: string } | null } }>(
      `rest/agile/1.0/issue/${encodeURIComponent(key)}`,
      { fields: 'sprint' },
    );
    const s = data.fields?.sprint;
    return s && typeof s.id === 'number' ? { id: s.id, name: s.name } : null;
  }

  /** Move issues into a sprint (Agile API; max 50 per call, we send few). */
  async moveIssuesToSprint(sprintId: number, keys: string[]): Promise<void> {
    await this.send('POST', `rest/agile/1.0/sprint/${sprintId}/issue`, { issues: keys });
  }

  /** Move issues out of any sprint, back to the backlog. */
  async moveIssuesToBacklog(keys: string[]): Promise<void> {
    await this.send('POST', 'rest/agile/1.0/backlog/issue', { issues: keys });
  }

  /** Detect deployment type; also a cheap auth check. */
  async probe(): Promise<JiraDeploymentInfo> {
    const info = await this.get<{ deploymentType?: string; version?: string }>(
      'rest/api/2/serverInfo',
    );
    const deployment = info.deploymentType === 'Cloud' ? 'cloud' : 'datacenter';
    this.deployment = deployment;
    return { deployment, version: info.version ?? 'unknown' };
  }

  private async ensureDeployment(): Promise<'datacenter' | 'cloud'> {
    if (!this.deployment) await this.probe();
    return this.deployment as 'datacenter' | 'cloud';
  }

  /** Run a JQL search, fully paginated; onPage reports (fetched, total|0). */
  async search(
    jql: string,
    extraFields: string[] = [],
    onPage?: (fetched: number, total: number) => void,
  ): Promise<RawIssue[]> {
    const deployment = await this.ensureDeployment();
    const fields = [...new Set([...DEFAULT_FIELDS, ...extraFields])].join(',');
    const out: RawIssue[] = [];
    if (deployment === 'datacenter') {
      let startAt = 0;
      for (;;) {
        const page = await this.get<{ issues: RawIssue[]; total: number; startAt: number }>(
          'rest/api/2/search',
          { jql, fields, startAt: String(startAt), maxResults: '100' },
        );
        out.push(...page.issues);
        startAt += page.issues.length;
        onPage?.(out.length, page.total);
        if (page.issues.length === 0 || startAt >= page.total) break;
      }
    } else {
      let token: string | undefined;
      for (;;) {
        const page = await this.get<{ issues: RawIssue[]; nextPageToken?: string }>(
          'rest/api/3/search/jql',
          { jql, fields, maxResults: '100', ...(token ? { nextPageToken: token } : {}) },
        );
        out.push(...page.issues);
        onPage?.(out.length, 0); // Cloud pagination reports no total
        token = page.nextPageToken;
        if (!token || page.issues.length === 0) break;
      }
    }
    return out;
  }

  /** Sprints for a board: active + future + last N closed. */
  async sprints(boardId: number, closedLimit = 3): Promise<JiraSprint[]> {
    const all: JiraSprint[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.get<{ values: JiraSprint[]; isLast: boolean }>(
        `rest/agile/1.0/board/${boardId}/sprint`,
        { startAt: String(startAt), maxResults: '50' },
      );
      all.push(...page.values.map((s) => ({ ...s, originBoardId: s.originBoardId ?? boardId })));
      if (page.isLast || page.values.length === 0) break;
      startAt += page.values.length;
    }
    const closed = all.filter((s) => s.state === 'closed').slice(-closedLimit);
    return [...closed, ...all.filter((s) => s.state !== 'closed')];
  }

  /**
   * Find the sprint custom field id (varies per instance). Its schema custom
   * key is the stable marker on both DC and Cloud.
   */
  async detectSprintField(): Promise<string | null> {
    const fields =
      await this.get<{ id: string; schema?: { custom?: string } }[]>('rest/api/2/field');
    const sprint = fields.find((f) => f.schema?.custom?.endsWith(':gh-sprint'));
    return sprint?.id ?? null;
  }

  /** Agile boards visible to the token, optionally filtered by project. */
  async boards(projectKey?: string): Promise<{ id: number; name: string; type: string }[]> {
    const out: { id: number; name: string; type: string }[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.get<{
        values: { id: number; name: string; type: string }[];
        isLast: boolean;
      }>('rest/agile/1.0/board', {
        startAt: String(startAt),
        maxResults: '50',
        ...(projectKey ? { projectKeyOrId: projectKey } : {}),
      });
      out.push(...page.values.map((b) => ({ id: b.id, name: b.name, type: b.type })));
      if (page.isLast || page.values.length === 0) break;
      startAt += page.values.length;
    }
    return out;
  }

  /** Issue keys per sprint (issue → sprint mapping comes from here on DC and Cloud alike). */
  async sprintIssueKeys(sprintId: number): Promise<string[]> {
    const keys: string[] = [];
    let startAt = 0;
    for (;;) {
      const page = await this.get<{ issues: { key: string }[]; total: number }>(
        `rest/agile/1.0/sprint/${sprintId}/issue`,
        { startAt: String(startAt), maxResults: '100', fields: 'key' },
      );
      keys.push(...page.issues.map((i) => i.key));
      startAt += page.issues.length;
      if (page.issues.length === 0 || startAt >= page.total) break;
    }
    return keys;
  }

  /** Epic key lookup differs across deployments; epic link comes as a custom field on DC. */
  async epicOf(issue: RawIssue, epicLinkField?: string): Promise<string | null> {
    const parent = issue.fields.parent as { key?: string } | undefined;
    if (parent?.key) return parent.key;
    if (epicLinkField) {
      const v = issue.fields[epicLinkField];
      if (typeof v === 'string') return v;
    }
    return null;
  }
}

/** Unwrap undici's generic "fetch failed" into the actionable cause. */
export function describeNetworkError(e: unknown): string {
  const seen: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof AggregateError && cur.errors.length) {
      cur = cur.errors[0];
      continue;
    }
    if (typeof cur === 'object' && cur !== null) {
      const err = cur as { code?: string; message?: string; cause?: unknown };
      if (err.code) seen.push(err.code);
      else if (err.message && err.message !== 'fetch failed') seen.push(err.message);
      cur = err.cause;
    } else {
      break;
    }
  }
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'request timed out — connection silently dropped; the host may only be reachable through a proxy, or a firewall is blackholing it';
  }
  const detail = seen[seen.length - 1] ?? 'fetch failed';
  const hints: Record<string, string> = {
    ENOTFOUND: 'DNS lookup failed — check the URL / VPN',
    ECONNREFUSED: 'connection refused — wrong port, or the host needs a proxy',
    ETIMEDOUT: 'timed out — likely blocked by a firewall or needs a proxy',
    ECONNRESET: 'connection reset — often TLS interception or a proxy in the path',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      'TLS chain not trusted — set NODE_EXTRA_CA_CERTS to your corporate root CA file',
    SELF_SIGNED_CERT_IN_CHAIN:
      'corporate TLS interception — set NODE_EXTRA_CA_CERTS to your corporate root CA file',
    DEPTH_ZERO_SELF_SIGNED_CERT:
      'self-signed certificate — set NODE_EXTRA_CA_CERTS to your corporate root CA file',
    CERT_HAS_EXPIRED: 'server certificate expired',
  };
  const hint = hints[detail];
  return hint ? `${detail} (${hint})` : detail;
}
