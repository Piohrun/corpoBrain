import { useEffect, useState } from 'react';
import { api, type SearchHit, type TagCount, type TreeModel } from '../api.ts';
import { NoteTree } from './NoteTree.tsx';

interface Props {
  tree: TreeModel | null;
  tags: TagCount[];
  tagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
  currentPath: string | null;
  onOpen: (path: string) => void;
  onDaily: () => void;
  onNew: () => void;
  onPalette: () => void;
  onTreeChanged: (moved?: { from: string; to: string }) => void;
}

export function Sidebar({
  tree,
  tags,
  tagFilter,
  onTagFilter,
  currentPath,
  onOpen,
  onDaily,
  onNew,
  onPalette,
  onTreeChanged,
}: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [tagged, setTagged] = useState<{ path: string; title: string }[]>([]);

  useEffect(() => {
    if (!tagFilter) {
      setTagged([]);
      return;
    }
    api
      .tag(tagFilter)
      .then(setTagged)
      .catch(() => setTagged([]));
  }, [tagFilter]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .search(query)
        .then((h) => {
          if (!cancelled) setHits(h);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

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
          aria-label="Search notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>
      <div className="sidebar-scroll">
        {tagFilter && !query.trim() ? (
          <>
            <h3>
              #{tagFilter} ({tagged.length}){' '}
              <button type="button" className="tag-clear" onClick={() => onTagFilter(null)}>
                ✕
              </button>
            </h3>
            {tagged.map((n) => (
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
            {tagged.length === 0 && <div className="tree-item muted">No notes with this tag</div>}
          </>
        ) : query.trim() ? (
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
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped in renderSnippet
                  dangerouslySetInnerHTML={{ __html: renderSnippet(h.snippet) }}
                />
              </button>
            ))}
            {hits.length === 0 && <div className="tree-item muted">No matches</div>}
          </>
        ) : (
          <>
            {tree && (
              <NoteTree
                tree={tree}
                currentPath={currentPath}
                onOpen={onOpen}
                onChanged={onTreeChanged}
              />
            )}
            {tags.length > 0 && (
              <>
                <h3>Tags</h3>
                <div style={{ padding: '0 6px' }}>
                  {tags.map((t) => (
                    <button
                      type="button"
                      key={t.tag}
                      className={`tag-row clickable${t.tag === tagFilter ? ' active' : ''}`}
                      title={`${t.count} notes`}
                      onClick={() => onTagFilter(t.tag === tagFilter ? null : t.tag)}
                    >
                      #{t.tag}
                    </button>
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
