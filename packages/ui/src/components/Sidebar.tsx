import type React from 'react';
import { memo, useEffect, useMemo, useState } from 'react';
import { api, type TagCount, type TreeModel } from '../api.ts';
import { lsGet, lsSet } from '../storage.ts';
import { Icon } from './Icon.tsx';
import { NoteTree } from './NoteTree.tsx';

interface Props {
  tree: TreeModel | null;
  tags: TagCount[];
  tagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
  currentPath: string | null;
  openSequence: number;
  onOpen: (path: string) => void;
  onDaily: () => void;
  onNew: () => void;
  onTreeChanged: (moved?: { from: string; to: string }) => void;
  /** last opened first */
  recent: { path: string; title: string }[];
  pinned: { path: string; title: string }[];
  onUnpin: (path: string) => void;
  sort: 'title' | 'recent';
  onSort: (s: 'title' | 'recent') => void;
  mtimeOf: (path: string) => number;
}

const ERROR_TTL = 6000;

export const Sidebar = memo(function Sidebar({
  tree,
  tags,
  tagFilter,
  onTagFilter,
  currentPath,
  openSequence,
  onOpen,
  onDaily,
  onNew,
  onTreeChanged,
  recent,
  pinned,
  onUnpin,
  sort,
  onSort,
  mtimeOf,
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

  // Opening a note adds the previous one to Recent, which pushes the tree
  // down — away from under the pointer that just clicked a row in it. While
  // the pointer is over the sidebar the list keeps the rows it had (a note
  // opened from it stays where it was, highlighted) and catches up on leaving.
  // Keyboard navigation never hovers, so it sees every change at once.
  const [hovering, setHovering] = useState(false);
  const [held, setHeld] = useState(recent);
  useEffect(() => {
    if (!hovering) setHeld(recent);
  }, [recent, hovering]);
  const shownRecent = useMemo(() => {
    if (!hovering) return recent;
    // held rows that are still notes: deleted ones go, renamed ones follow
    const now = new Map(recent.map((n) => [n.path, n.title]));
    return held
      .filter((n) => now.has(n.path) || n.path === currentPath)
      .map((n) => ({ path: n.path, title: now.get(n.path) ?? n.title }));
  }, [hovering, held, recent, currentPath]);

  // folded quick sections, remembered per browser
  const [folded, setFolded] = useState(() => ({
    pinned: lsGet('cb.sidebar.pinned') === 'folded',
    recent: lsGet('cb.sidebar.recent') === 'folded',
  }));
  const toggleFold = (key: 'pinned' | 'recent') =>
    setFolded((f) => {
      lsSet(`cb.sidebar.${key}`, f[key] ? null : 'folded');
      return { ...f, [key]: !f[key] };
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only tracks whether the pointer is over the sidebar
    <div
      className="sidebar"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="notebook-heading">
        <Icon name="notes" />
        <strong>Your notebook</strong>
      </div>
      <div className="sidebar-actions">
        <button type="button" onClick={onDaily} title="Open today's daily note">
          Today
        </button>
        <button type="button" onClick={onNew} title="Create a note">
          + Note
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
                data-path={n.path}
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
            {pinned.length > 0 && (
              <>
                <FoldHeading
                  label="Pinned"
                  count={pinned.length}
                  open={!folded.pinned}
                  onToggle={() => toggleFold('pinned')}
                />
                {!folded.pinned &&
                  pinned.map((n) => (
                    <div
                      key={`p${n.path}`}
                      className={`tree-quick${n.path === currentPath ? ' active' : ''}`}
                    >
                      <button
                        type="button"
                        className="tree-item"
                        data-quick-path={n.path}
                        onClick={() => onOpen(n.path)}
                        title={n.path}
                      >
                        <Icon name="pin" /> {n.title}
                      </button>
                      <button
                        type="button"
                        className="tree-unpin"
                        title="Unpin"
                        aria-label={`Unpin ${n.title}`}
                        onClick={() => onUnpin(n.path)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
              </>
            )}
            {shownRecent.length > 0 && (
              <>
                <FoldHeading
                  label="Recent"
                  count={shownRecent.length}
                  open={!folded.recent}
                  onToggle={() => toggleFold('recent')}
                />
                {!folded.recent &&
                  shownRecent.map((n) => (
                    <button
                      type="button"
                      key={`r${n.path}`}
                      className={`tree-item${n.path === currentPath ? ' active' : ''}`}
                      data-quick-path={n.path}
                      onClick={() => onOpen(n.path)}
                      title={n.path}
                    >
                      {n.title}
                    </button>
                  ))}
              </>
            )}
            <h3 className="tree-head">
              Notes
              <span className="spacer" />
              <button
                type="button"
                className={`sort-toggle${sort === 'title' ? ' active' : ''}`}
                onClick={() => onSort('title')}
                title="Vault order (your ordering, then title)"
              >
                A–Z
              </button>
              <button
                type="button"
                className={`sort-toggle${sort === 'recent' ? ' active' : ''}`}
                onClick={() => onSort('recent')}
                title="Most recently edited first"
              >
                recent
              </button>
            </h3>
            {treeError && <div className="plan-error tree-error">{treeError}</div>}
            {tree && (
              <NoteTree
                tree={tree}
                currentPath={currentPath}
                openSequence={openSequence}
                onOpen={onOpen}
                onChanged={onTreeChanged}
                onError={setTreeError}
                sort={sort}
                mtimeOf={mtimeOf}
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
});

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

/** A quick-section heading that folds its list (the count stays visible). */
function FoldHeading({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <h3 className="fold-head">
      <button type="button" onClick={onToggle} aria-expanded={open}>
        <span className="fold-chevron">{open ? '▾' : '▸'}</span>
        {label}
        {!open && <span className="fold-count">{count}</span>}
      </button>
    </h3>
  );
}
