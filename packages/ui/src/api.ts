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
