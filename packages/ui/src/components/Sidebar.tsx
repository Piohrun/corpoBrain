import type React from 'react';
import { useEffect, useState } from 'react';
import { api, type TagCount, type TreeModel } from '../api.ts';
import { isMac } from '../shortcuts.ts';
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
  onFind: () => void;
  onTreeChanged: (moved?: { from: string; to: string }) => void;
}

const ERROR_TTL = 6000;

export function Sidebar({
  tree,
  tags,
  tagFilter,
  onTagFilter,
  currentPath,
  onOpen,
  onDaily,
  onNew,
  onFind,
  onTreeChanged,
}: Props) {
  const [tagged, setTagged] = useState<{ path: string; title: string }[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  useEffect(() => {
    if (!treeError) return;
    const t = setTimeout(() => setTreeError(null), ERROR_TTL);
    return () => clearTimeout(t);
  }, [treeError]);

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

  return (
    <div className="sidebar">
      <div className="sidebar-actions">
        <button type="button" onClick={onDaily} title="Open today's daily note">
          Today
        </button>
        <button type="button" onClick={onNew} title="Create a note">
          + Note
        </button>
        <button type="button" onClick={onFind} title={isMac ? '⌘F' : 'Ctrl+F'}>
          Go to…
        </button>
      </div>
      <div className="sidebar-search">
        <button type="button" className="finder-trigger" onClick={onFind}>
          <span>Find anything…</span>
          <kbd>{isMac ? '⌘F' : 'Ctrl+F'}</kbd>
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the tree's own buttons */}
      <div className="sidebar-scroll" onKeyDown={moveBetweenRows}>
        {tagFilter ? (
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
        ) : (
          <>
            {treeError && <div className="plan-error tree-error">{treeError}</div>}
            {tree && (
              <NoteTree
                tree={tree}
                currentPath={currentPath}
                onOpen={onOpen}
                onChanged={onTreeChanged}
                onError={setTreeError}
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

/** ↑/↓ walk the focusable rows of a list or tree; Enter is the button's own click. */
export function moveBetweenRows(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])')].filter(
    (b) => b.offsetParent !== null,
  );
  const at = rows.indexOf(target);
  if (at < 0) return;
  e.preventDefault();
  const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
  next?.focus();
  next?.scrollIntoView({ block: 'nearest' });
}
