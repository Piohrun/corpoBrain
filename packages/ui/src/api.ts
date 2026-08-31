/** Typed client for the corpobrain server API. */

export interface NoteListItem {
  path: string;
  title: string;
  type: string;
  mtime: number;
  protected: boolean;
}

export interface NoteMeta {
  id: string | null;
  type: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

export interface Backlink {
  srcPath: string;
  srcTitle: string;
  kind: string;
  line: number;
  alias: string | null;
}

export interface NoteResponse {
  path: string;
  content: string;
  meta: NoteMeta | null;
  /** merged tags from the index: frontmatter + inline #tags */
  tags: string[];
  backlinks: Backlink[];
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TaskItem {
  path: string;
  line: number;
  text: string;
  done: number;
  due: string | null;
  title: string;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  notes: () => req<NoteListItem[]>('/api/notes'),
  note: (path: string) => req<NoteResponse>(`/api/note?path=${encodeURIComponent(path)}`),
  save: (path: string, content: string) =>
    req<{ ok: boolean }>('/api/note', { method: 'PUT', body: JSON.stringify({ path, content }) }),
  create: (path: string, title?: string) =>
    req<{ path: string }>('/api/note', { method: 'POST', body: JSON.stringify({ path, title }) }),
  remove: (path: string) =>
    req<{ ok: boolean }>(`/api/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  resolve: (target: string) =>
    req<{ path: string; exists: boolean }>(`/api/resolve?target=${encodeURIComponent(target)}`),
  daily: (date?: string) =>
    req<{ path: string; created: boolean }>('/api/daily', {
      method: 'POST',
      body: JSON.stringify(date ? { date } : {}),
    }),
  search: (q: string, limit = 20) =>
    req<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  tags: () => req<TagCount[]>('/api/tags'),
  tag: (tag: string) =>
    req<{ path: string; title: string }[]>(`/api/tag?tag=${encodeURIComponent(tag)}`),
  tasks: (done?: boolean) =>
    req<TaskItem[]>(`/api/tasks${done === undefined ? '' : `?done=${done}`}`),
};

// ---------------------------------------------------------------- planning

export interface BoardIssue {
  key: string;
  path: string;
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  issueType: string | null;
  priority: string | null;
  epic: string | null;
  labels: string[];
  updated: string | null;
  jiraSprint: string | null;
  jiraAssignee: string | null;
  estimate: number | null;
  plan: {
    sprint: string | null;
    assignee: string | null;
    rank: number | null;
    effort: number | null;
    risk: string | null;
    confidence: string | null;
    bucket: string | null;
    blockedOn: string[];
    note: string | null;
  };
  effectiveSprint: string;
  effectiveAssignee: string | null;
  effectiveEffort: number | null;
  overridden: { sprint: boolean; assignee: boolean };
  riskFlags: string[];
  dependsOn: string[];
  blockedBy: string[];
}

export interface BoardPerson {
  path: string;
  name: string;
  jiraIds: string[];
  capacity: number | null;
  overrides: Record<string, number>;
  active: boolean;
  region: string | null;
  team: string | null;
}

export interface BoardModel {
  unit: string;
  sprints: { id: number; name: string; state: string; start: string | null; end: string | null }[];
  columns: string[];
  people: BoardPerson[];
  issues: BoardIssue[];
  loads: Record<string, Record<string, number>>;
}

export interface JiraStatus {
  syncing: boolean;
  configured: boolean;
  baseUrl: string;
  profiles: string[];
  lastSynced: string | null;
}

export type PlanPatch = Partial<{
  sprint: string | null;
  assignee: string | null;
  rank: number | null;
  effort: number | null;
  risk: string | null;
  confidence: string | null;
  bucket: string | null;
  blocked_on: string[] | null;
  note: string | null;
}>;

export const planApi = {
  board: () => req<BoardModel>('/api/plan/board'),
  patchIssue: (key: string, patch: PlanPatch) =>
    req<{ ok: boolean }>(`/api/plan/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  patchPerson: (body: {
    path: string;
    capacity?: number | null;
    overrides?: Record<string, number>;
    active?: boolean;
    region?: string | null;
    team?: string | null;
  }) => req<{ ok: boolean }>('/api/plan/person', { method: 'PUT', body: JSON.stringify(body) }),
  jiraStatus: () => req<JiraStatus>('/api/jira/status'),
  jiraSync: () => req<{ ok: boolean }>('/api/jira/sync', { method: 'POST', body: '{}' }),
};

export interface SavedView {
  path: string;
  title: string;
  filter: { text?: string; flag?: string; sprint?: string; assignee?: string };
}

export const viewApi = {
  list: () => req<SavedView[]>('/api/plan/views'),
  save: (title: string, filter: SavedView['filter']) =>
    req<{ ok: boolean; path: string }>('/api/plan/views', {
      method: 'POST',
      body: JSON.stringify({ title, filter }),
    }),
};

// ----------------------------------------------------------------- private

export interface PrivateStatus {
  initialized: boolean;
  unlocked: boolean;
  lockAfterMinutes: number;
}

export const privateApi = {
  status: () => req<PrivateStatus>('/api/private/status'),
  init: (passphrase: string) =>
    req<{ ok: boolean }>('/api/private/init', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  unlock: (passphrase: string) =>
    req<{ ok: boolean }>('/api/private/unlock', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  lock: () => req<{ ok: boolean }>('/api/private/lock', { method: 'POST', body: '{}' }),
  list: () => req<{ file: string; title: string }[]>('/api/private/list'),
  read: (file: string) =>
    req<{ file: string; title: string; content: string }>(
      `/api/private/note?file=${encodeURIComponent(file)}`,
    ),
  write: (file: string | null, content: string) =>
    req<{ file: string }>('/api/private/note', {
      method: 'PUT',
      body: JSON.stringify({ file, content }),
    }),
  remove: (file: string) =>
    req<{ ok: boolean }>(`/api/private/note?file=${encodeURIComponent(file)}`, {
      method: 'DELETE',
    }),
  search: (q: string) =>
    req<{ file: string; title: string; snippet: string }[]>(
      `/api/private/search?q=${encodeURIComponent(q)}`,
    ),
};

// ------------------------------------------------------------------- tree

export interface TreeNode {
  path: string;
  title: string;
  type: string;
  order: number | null;
  children: TreeNode[];
}

export interface TreeModel {
  folders: { folder: string; roots: TreeNode[] }[];
}

export const treeApi = {
  get: () => req<TreeModel>('/api/tree'),
  meta: (body: {
    path: string;
    type?: string | null;
    parent?: string | null;
    order?: number | null;
    tags?: string[] | null;
    set?: Record<string, unknown>;
  }) =>
    req<{ ok: boolean; path: string }>('/api/tree/meta', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
};

export interface CategoryField {
  key: string;
  kind: 'text' | 'number' | 'boolean' | 'list';
  source: 'builtin' | 'template' | 'seen';
}

export const fieldsApi = {
  forCategory: (category: string) =>
    req<{ fields: CategoryField[]; sprintOverrides: string[] | null }>(
      `/api/objects/fields?category=${encodeURIComponent(category)}`,
    ),
};
