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
  /** per-target wikilink resolution (Obsidian-style placeholder styling) */
  links: { target: string; resolved: boolean }[];
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
    project: string | null;
    start: string | null;
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
  capacityIsDefault: boolean;
  region: string | null;
  team: string | null;
  loadOverrides: Record<string, number>;
  color: string | null;
  suggested: Record<string, number>;
  absence: Record<string, { ooo: number; support: number; total: number; available: number }>;
}

export interface BoardModel {
  unit: string;
  health: { bigIssue: number; staleDays: number; underloadPct: number };
  defaultCapacity: number | null;
  sprints: {
    id: number;
    name: string;
    state: string;
    start: string | null;
    end: string | null;
    source: string;
  }[];
  columns: string[];
  people: BoardPerson[];
  issues: BoardIssue[];
  loads: Record<string, Record<string, number>>;
}

export interface SyncProgress {
  profile: string;
  phase: 'search' | 'sprints' | 'membership' | 'issues' | 'people' | 'done';
  current: number;
  total: number;
  detail?: string;
  startedAt: string;
}

export interface SyncReportSummary {
  profile: string;
  fetched: number;
  changes?: number;
  created: string[];
  updated: string[];
  unchanged: number;
  skipped: { key: string; reason: string }[];
  peopleCreated: string[];
  sprints: number;
  warnings: string[];
}

export interface JiraStatus {
  syncing: boolean;
  progress: SyncProgress | null;
  lastReports: SyncReportSummary[] | null;
  lastSyncError: string | null;
  configured: boolean;
  baseUrl: string;
  profiles: string[];
  lastSynced: string | null;
}

export type PlanPatch = Partial<{
  project: string | null;
  start: string | null;
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

export interface HealthProblem {
  kind: string;
  severity: 'high' | 'medium' | 'low';
  detail: string;
  issueKey: string | null;
  path: string | null;
  summary: string | null;
  personName: string | null;
  personPath: string | null;
  value: number | null;
  limit: number | null;
}

export interface HealthReport {
  sprint: string;
  unit: string;
  generatedAt: string;
  elapsedPct: number | null;
  daysLeft: number | null;
  totals: {
    issues: number;
    done: number;
    inProgress: number;
    todo: number;
    effort: number;
    doneEffort: number;
    capacity: number;
    unassignedEffort: number;
    unestimated: number;
  };
  counts: Record<string, number>;
  problems: HealthProblem[];
}

export interface ChangeEvent {
  at: string;
  profile: string;
  key: string;
  kind: string;
  from: string | null;
  to: string | null;
  summary: string;
  assignee: string | null;
  assigneeName: string | null;
  sprint: string | null;
  statusCategory: string | null;
}

export interface DigestResponse {
  range: string;
  since: string | null;
  lastSync: { profile: string; at: string }[];
  runs: { at: string; count: number }[];
  counts: Record<string, number>;
  events: ChangeEvent[];
  paths: Record<string, string>;
  people: Record<string, { name: string; path: string }>;
}

export interface ProjectSummary {
  path: string;
  title: string;
  status: string | null;
  color: string | null;
  target: string | null;
  issues: number;
  done: number;
  inProgress: number;
  effort: number;
  doneEffort: number;
  remainingEffort: number;
  unestimated: number;
  unassigned: number;
  blocked: number;
  people: { assignee: string; effort: number; issues: number }[];
  sprints: string[];
  forecastDate: string | null;
  lateDeps: number;
  conflicts: number;
}

export interface CalendarBlock {
  key: string;
  assignee: string;
  start: number;
  span: number;
  workDays: number;
  pinned: boolean;
  estimated: boolean;
  awayDays: number;
  conflict: boolean;
  clamped: boolean;
  lateDeps: string[];
  summary: string | null;
  path: string;
  status: string | null;
  statusCategory: string | null;
  priority: string | null;
  blockedBy: string[];
}

export interface CalendarModel {
  project: Omit<ProjectSummary, 'forecastDate' | 'lateDeps' | 'conflicts'>;
  unit: string;
  days: string[];
  today: number | null;
  months: { label: string; from: number; span: number }[];
  sprints: { name: string; from: number; span: number; state: string }[];
  rows: {
    assignee: string;
    jiraId: string | null;
    name: string;
    path: string | null;
    color: string | null;
    inRoster: boolean;
    ooo: number[];
    support: number[];
  }[];
  blocks: CalendarBlock[];
  rail: { key: string; summary: string | null; path: string; days: number; estimated: boolean }[];
  finishDate: string | null;
  target: string | null;
  cycles: string[][];
  warnings: string[];
}

export interface AvailabilityEntry {
  person: string;
  from: string;
  to: string;
  kind: 'ooo' | 'support';
  note: string;
}

export interface AvailabilityRow {
  person: string;
  name: string;
  path: string | null;
  sprint: string;
  ooo: number;
  support: number;
  total: number;
  available: number;
  capacity: number | null;
  adjusted: number | null;
  overridden: boolean;
}

export interface AvailabilityResponse {
  file: string;
  entries: AvailabilityEntry[];
  warnings: string[];
  unit: string;
  supportFactor: number;
  people: { path: string; name: string }[];
  sprints: string[];
  rows: AvailabilityRow[];
}

export const availabilityApi = {
  get: () => req<AvailabilityResponse>('/api/availability'),
  save: (entries: AvailabilityEntry[]) =>
    req<{ ok: boolean; file: string; count: number }>('/api/availability', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
};

export const projectApi = {
  list: () => req<{ projects: ProjectSummary[]; untagged: number; unit: string }>('/api/projects'),
  timeline: (path: string) =>
    req<CalendarModel>(`/api/projects/timeline?path=${encodeURIComponent(path)}`),
  create: (title: string) =>
    req<{ ok: boolean; path: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  roster: (path: string, people: string[]) =>
    req<{ ok: boolean; people: string[] }>('/api/projects/roster', {
      method: 'PUT',
      body: JSON.stringify({ path, people }),
    }),
  arrange: (path: string) =>
    req<{ ok: boolean; pinned: number; finishDate: string | null }>('/api/projects/arrange', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
};

export const digestApi = {
  get: (range: string) => req<DigestResponse>(`/api/digest?range=${encodeURIComponent(range)}`),
};

export const planApi = {
  board: () => req<BoardModel>('/api/plan/board'),
  health: (sprint?: string) =>
    req<HealthReport>(`/api/plan/health${sprint ? `?sprint=${encodeURIComponent(sprint)}` : ''}`),
  patchIssue: (key: string, patch: PlanPatch) =>
    req<{ ok: boolean }>(`/api/plan/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  patchPerson: (body: {
    path: string;
    capacity?: number | null;
    overrides?: Record<string, number>;
    loadOverrides?: Record<string, number>;
    active?: boolean;
    region?: string | null;
    team?: string | null;
    color?: string | null;
  }) => req<{ ok: boolean }>('/api/plan/person', { method: 'PUT', body: JSON.stringify(body) }),
  saveCapacityConfig: (body: {
    defaultCapacity?: number | null;
    unit?: string;
    health?: { bigIssue?: number; staleDays?: number; underloadPct?: number };
  }) =>
    req<{ ok: boolean }>('/api/plan/capacity-config', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  jiraStatus: () => req<JiraStatus>('/api/jira/status'),
  jiraSync: (full = false) =>
    req<{ ok: boolean }>('/api/jira/sync', { method: 'POST', body: JSON.stringify({ full }) }),
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
  encrypt: (text: string) =>
    req<{ data: string }>('/api/private/encrypt', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  decryptMany: (items: string[]) =>
    req<{ texts: (string | null)[] }>('/api/private/decrypt-many', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  decrypt: (data: string) =>
    req<{ text: string }>('/api/private/decrypt', {
      method: 'POST',
      body: JSON.stringify({ data }),
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

// -------------------------------------------------------------------- jira

export interface JiraProfileCfg {
  name: string;
  jql: string;
  folder: string;
  intervalMinutes: number;
  boards: number[];
  futureSprints: number;
}

export interface JiraConfig {
  baseUrl: string;
  proxyUrl: string;
  writeback: 'off' | 'dry-run' | 'on';
  deployment: 'auto' | 'datacenter' | 'cloud';
  auth: 'bearer' | 'basic';
  projectKeys: string[];
  estimateField: string;
  estimateUnit: 'points' | 'days' | 'hours' | 'seconds';
  syncComments: boolean;
  profiles: JiraProfileCfg[];
  tokenSet: boolean;
}

export interface JiraIssueRow {
  key: string;
  path: string;
  summary: string | null;
  status: string | null;
  status_category: string | null;
  issue_type: string | null;
  priority: string | null;
  assignee: string | null;
  sprint: string | null;
  epic: string | null;
  labels_json: string | null;
  estimate: number | null;
  updated: string | null;
}

export interface SprintRow {
  id: number;
  name: string;
  state: string | null;
  start: string | null;
  end: string | null;
  goal: string | null;
  source: 'jira' | 'local';
  path: string | null;
}

export const jiraApi = {
  config: () => req<JiraConfig>('/api/jira/config'),
  saveConfig: (body: Partial<JiraConfig> & { token?: string; email?: string }) =>
    req<JiraConfig>('/api/jira/config', { method: 'PUT', body: JSON.stringify(body) }),
  probe: () =>
    req<{ ok: boolean; deployment: string; version: string }>('/api/jira/probe', {
      method: 'POST',
    }),
  issues: () => req<JiraIssueRow[]>('/api/jira/issues'),
  sprints: () => req<SprintRow[]>('/api/jira/sprints'),
  boards: (project?: string) =>
    req<{ id: number; name: string; type: string }[]>(
      `/api/jira/boards${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    ),
  createSprint: (body: { name: string; start?: string; end?: string; goal?: string }) =>
    req<{ ok: boolean; path: string }>('/api/jira/sprints', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export interface GitStatus {
  available: boolean;
  isRepo: boolean;
  head: { hash: string; date: string; message: string } | null;
  dirtyFiles: number;
  lastError: string | null;
  autoCommit: boolean;
  intervalMinutes: number;
}

export const gitApi = {
  status: () => req<GitStatus>('/api/git/status'),
  commit: () => req<{ ok: boolean; hash: string | null }>('/api/git/commit', { method: 'POST' }),
};

// --------------------------------------------------------------- writeback

export interface StagedChange {
  key: string;
  path: string;
  field: 'sprint' | 'assignee';
  from: string | null;
  to: string;
  writable: boolean;
  reason?: string;
}

export interface PreviewRow extends StagedChange {
  liveUpdated: string | null;
  mirrorUpdated: string | null;
  liveAssignee: string | null;
  conflict: boolean;
  conflictReason?: string;
}

export interface WriteApplyItem {
  key: string;
  field: 'sprint' | 'assignee';
  to: string;
  force?: boolean;
}

export interface WriteApplyReport {
  batchId: string;
  dryRun: boolean;
  stopped: boolean;
  results: {
    key: string;
    field: string;
    to: string;
    status: 'applied' | 'dry-run' | 'conflict' | 'error' | 'not-run';
    detail?: string;
  }[];
}

export const writebackApi = {
  staged: () => req<StagedChange[]>('/api/jira/writeback/staged'),
  preview: (keys?: string[]) =>
    req<PreviewRow[]>('/api/jira/writeback/preview', {
      method: 'POST',
      body: JSON.stringify(keys ? { keys } : {}),
    }),
  apply: (items: WriteApplyItem[]) =>
    req<WriteApplyReport>('/api/jira/writeback/apply', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),
  journal: (limit = 30) =>
    req<Record<string, unknown>[]>(`/api/jira/writeback/journal?limit=${limit}`),
  undo: (batchId: string) =>
    req<{ items: WriteApplyItem[] }>('/api/jira/writeback/undo', {
      method: 'POST',
      body: JSON.stringify({ batchId }),
    }),
};
