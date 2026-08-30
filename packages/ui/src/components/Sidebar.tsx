import { useEffect, useMemo, useState } from 'react';
import { api, type NoteListItem, type SearchHit, type TagCount } from '../api.ts';

interface Props {
  notes: NoteListItem[];
  tags: TagCount[];
  currentPath: string | null;
  onOpen: (path: string) => void;
  onDaily: () => void;
  onNew: () => void;
  onPalette: () => void;
}

export function Sidebar({ notes, tags, currentPath, onOpen, onDaily, onNew, onPalette }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(query).then((h) => {
        if (!cancelled) setHits(h);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const folders = useMemo(() => {
    const groups = new Map<string, NoteListItem[]>();
    for (const n of notes) {
      if (n.protected) continue;
      const folder = n.path.includes('/') ? (n.path.split('/')[0] as string) : '';
      const arr = groups.get(folder) ?? [];
      arr.push(n);
      groups.set(folder, arr);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [notes]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['jira']));
  const toggle = (folder: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  return (
    <div className="sidebar">
      <div className="sidebar-actions">
        <button type="button" onClick={onDaily} title="Open today's daily note">
          Today
        </button>
        <button type="button" onClick={onNew} title="Create a note">
          + Note
        </button>
        <button type="button" onClick={onPalette} title="Ctrl+P">
          Go to…
        </button>
      </div>
      <div className="sidebar-search">
        <input
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>
      <div className="sidebar-scroll">
        {query.trim() ? (
          <>
            <h3>Results</h3>
            {hits.map((h) => (
              <button
                type="button"
                key={h.path}
                className="search-hit"
                onClick={() => onOpen(h.path)}
              >
                <div className="hit-title">{h.title}</div>
                <div
                  className="hit-snippet"
                  // snippet uses << >> markers from FTS; render as <mark>
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized below
                  dangerouslySetInnerHTML={{ __html: renderSnippet(h.snippet) }}
                />
              </button>
            ))}
            {hits.length === 0 && <div className="tree-item muted">No matches</div>}
          </>
        ) : (
          <>
            {folders.map(([folder, items]) => (
              <div key={folder || '(root)'}>
                <button type="button" className="tree-folder" onClick={() => toggle(folder)}>
                  {collapsed.has(folder) ? '▸' : '▾'} {folder || 'vault'}{' '}
                  <span className="muted">({items.length})</span>
                </button>
                {!collapsed.has(folder) &&
                  items.map((n) => (
                    <button
                      type="button"
                      key={n.path}
                      className={`tree-item${n.path === currentPath ? ' active' : ''}`}
                      onClick={() => onOpen(n.path)}
                      title={n.path}
                    >
                      {n.title}
                    </button>
                  ))}
              </div>
            ))}
            {tags.length > 0 && (
              <>
                <h3>Tags</h3>
                <div style={{ padding: '0 6px' }}>
                  {tags.map((t) => (
                    <span key={t.tag} className="tag-row" title={`${t.count} notes`}>
                      #{t.tag}
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSnippet(snippet: string): string {
  return escapeHtml(snippet)
    .replace(/&lt;&lt;/g, '<mark>')
    .replace(/&gt;&gt;/g, '</mark>');
}
