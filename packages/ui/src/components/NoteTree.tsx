import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TreeModel, type TreeNode, treeApi } from '../api.ts';
import { dailyGroupKeysForPath, groupDailyNotes } from '../daily-notes.ts';
import { lsJson, lsSetJson } from '../storage.ts';
import { DailyNoteGroups } from './DailyNoteGroups.tsx';

interface Props {
  tree: TreeModel;
  currentPath: string | null;
  /** Changes even when Today/search reopens the same note. */
  openSequence: number;
  onOpen: (path: string) => void;
  onChanged: (moved?: { from: string; to: string }) => void;
  onError?: (message: string) => void;
  /** 'title' keeps the vault order; 'recent' puts the latest-edited siblings first */
  sort?: 'title' | 'recent';
  /** path → last modified (ms) for the recent sort */
  mtimeOf?: (path: string) => number;
}

const LS_KEY = 'corpobrain.collapsed';
const LS_EXPANDED = 'corpobrain.expanded';
/** groups with more rows than this start collapsed until opened once */
const BIG = 40;

/** Sibling lists longer than this render a window of rows, grown as it scrolls. */
const WINDOW_MIN = 150;
const WINDOW_STEP = 200;

/** Where a drag is hovering relative to a row. */
type DropPos = 'before' | 'into' | 'after';

interface DropSpot {
  key: string; // row identity for highlight
  pos: DropPos;
}

/** dragleave fires when entering a child; only clear when truly leaving. */
function reallyLeft(e: React.DragEvent): boolean {
  const related = e.relatedTarget as Node | null;
  return !related || !(e.currentTarget as HTMLElement).contains(related);
}

const loadCollapsed = (): Set<string> => new Set(lsJson<string[]>(LS_KEY, []));
const loadExpanded = (): Set<string> => new Set(lsJson<string[]>(LS_EXPANDED, []));

export const NoteTree = memo(function NoteTree({
  tree,
  currentPath,
  openSequence,
  onOpen,
  onChanged,
  onError,
  sort = 'title',
  mtimeOf,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  /** big groups the user opened explicitly (they default to collapsed) */
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [spot, setSpot] = useState<DropSpot | null>(null);
  const folders = useMemo(
    () =>
      tree.folders.map((folder) => ({
        ...folder,
        daily: groupDailyNotes(folder.roots, tree.dailyFolder),
      })),
    [tree],
  );
  const revealFolder = folders.find(
    ({ daily }) => dailyGroupKeysForPath(daily.groups, currentPath).length > 0,
  )?.folder;
  // parent and folder of every note, so "does this hold the open note?" is a
  // walk up from the open note rather than a search through every subtree
  const { parentOf, folderOf } = useMemo(() => {
    const parentOf = new Map<string, string | null>();
    const folderOf = new Map<string, string>();
    for (const { folder, roots } of tree.folders) {
      const stack: [TreeNode, string | null][] = roots.map((r) => [r, null]);
      while (stack.length) {
        const [node, parent] = stack.pop() as [TreeNode, string | null];
        parentOf.set(node.path, parent);
        folderOf.set(node.path, folder);
        for (const c of node.children) stack.push([c, node.path]);
      }
    }
    return { parentOf, folderOf };
  }, [tree]);
  const holdsCurrent = useMemo(() => {
    const set = new Set<string>();
    for (let at = currentPath; at; at = parentOf.get(at) ?? null) set.add(at);
    return set;
  }, [currentPath, parentOf]);
  const currentFolder = currentPath ? folderOf.get(currentPath) : undefined;
  const revealSelection = currentPath ? `${openSequence}:${currentPath}` : null;

  useEffect(() => {
    if (!revealSelection || revealFolder === undefined) return;
    const key = `folder:${revealFolder}`;
    setCollapsed((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, [revealSelection, revealFolder]);

  useEffect(() => lsSetJson(LS_KEY, [...collapsed]), [collapsed]);
  useEffect(() => lsSetJson(LS_EXPANDED, [...expanded]), [expanded]);

  /** collapsed = explicitly collapsed, or big and never opened — unless it holds the open note */
  const isCollapsedKey = useCallback(
    (key: string, size: number, holdsCurrent: boolean) => {
      if (collapsed.has(key)) return true;
      if (size > BIG && !expanded.has(key) && !holdsCurrent) return true;
      return false;
    },
    [collapsed, expanded],
  );

  const toggle = useCallback(
    (key: string, size = 0) => {
      const big = size > BIG;
      setCollapsed((prev) => {
        const next = new Set(prev);
        const currentlyCollapsed = next.has(key) || (big && !expanded.has(key));
        if (currentlyCollapsed) next.delete(key);
        else next.add(key);
        return next;
      });
      if (big) setExpanded((prev) => new Set(prev).add(key));
    },
    [expanded],
  );

  const ordered = useCallback(
    (nodes: TreeNode[]): TreeNode[] =>
      sort === 'recent' && mtimeOf
        ? [...nodes].sort((a, b) => mtimeOf(b.path) - mtimeOf(a.path))
        : nodes,
    [sort, mtimeOf],
  );

  const placeNote = useCallback(
    (body: { path: string; parent?: string | null; folder?: string | null; index?: number }) => {
      treeApi
        .place(body)
        .then((json) =>
          onChanged(json.path !== body.path ? { from: body.path, to: json.path } : undefined),
        )
        .catch((e: Error) => onError?.(e.message));
    },
    [onChanged, onError],
  );

  const posFromEvent = (e: React.DragEvent, canNest: boolean): DropPos => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (!canNest) return y < 0.5 ? 'before' : 'after';
    if (y < 0.28) return 'before';
    if (y > 0.72) return 'after';
    return 'into';
  };

  const renderNode = (
    node: TreeNode,
    depth: number,
    folder: string,
    parentPath: string | null,
    index: number,
  ): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const isCollapsed = isCollapsedKey(
      node.path,
      node.children.length,
      holdsCurrent.has(node.path),
    );
    const highlight = spot?.key === node.path ? spot.pos : null;
    return (
      <div key={node.path}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop container; open/toggle live on inner buttons */}
        <div
          className={`tree-row${node.path === currentPath ? ' active' : ''}${
            highlight === 'into' ? ' drop-into' : ''
          }${highlight === 'before' ? ' drop-before' : ''}${highlight === 'after' ? ' drop-after' : ''}${
            dragPath === node.path ? ' dragging' : ''
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            setDragPath(node.path);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            setDragPath(null);
            setSpot(null);
          }}
          onDragOver={(e) => {
            if (!dragPath || dragPath === node.path) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const pos = posFromEvent(e, true);
            setSpot((prev) =>
              prev?.key === node.path && prev.pos === pos ? prev : { key: node.path, pos },
            );
          }}
          onDragLeave={(e) => {
            if (reallyLeft(e)) setSpot((s) => (s?.key === node.path ? null : s));
          }}
          onDrop={(e) => {
            e.preventDefault();
            const pos = posFromEvent(e, true);
            setSpot(null);
            if (!dragPath || dragPath === node.path) return;
            if (pos === 'into') {
              placeNote({ path: dragPath, parent: node.path, index: node.children.length });
            } else {
              // sibling insert relative to this node
              const at = pos === 'before' ? index : index + 1;
              placeNote(
                parentPath
                  ? { path: dragPath, parent: parentPath, index: at }
                  : { path: dragPath, folder, index: at },
              );
            }
          }}
        >
          {hasKids ? (
            <button
              type="button"
              className="tree-chevron"
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.path, node.children.length);
              }}
              title={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="tree-chevron leaf">·</span>
          )}
          <button
            type="button"
            className="tree-label"
            data-path={node.path}
            onClick={() => onOpen(node.path)}
            title={`${node.path}${node.type !== 'note' ? ` · ${node.type}` : ''}`}
          >
            {node.title}
            {node.type !== 'note' && <span className="type-chip">{node.type}</span>}
            {hasKids && isCollapsed && <span className="muted"> ({countDesc(node)})</span>}
          </button>
        </div>
        {hasKids &&
          !isCollapsed &&
          renderList(ordered(node.children), (c, i) =>
            renderNode(c, depth + 1, folder, node.path, i),
          )}
      </div>
    );
  };

  const renderList = (
    nodes: TreeNode[],
    render: (node: TreeNode, index: number) => React.ReactNode,
  ): React.ReactNode =>
    nodes.length < WINDOW_MIN ? (
      nodes.map(render)
    ) : (
      <WindowedRows nodes={nodes} render={render} holdsCurrent={holdsCurrent} />
    );

  return (
    <div>
      {folders.map(({ folder, roots, daily }) => {
        const key = `folder:${folder}`;
        const size = daily.groups.length ? 0 : roots.length;
        const isCollapsed = isCollapsedKey(key, size, currentFolder === folder);
        return (
          <div key={key}>
            <button
              type="button"
              className={`tree-folder${spot?.key === key ? ' drop-into' : ''}`}
              aria-expanded={!isCollapsed}
              onClick={() => toggle(key, size)}
              onDragOver={(e) => {
                if (dragPath) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setSpot((prev) => (prev?.key === key ? prev : { key, pos: 'into' }));
                }
              }}
              onDragLeave={(e) => {
                if (reallyLeft(e)) setSpot((s) => (s?.key === key ? null : s));
              }}
              onDrop={(e) => {
                e.preventDefault();
                setSpot(null);
                // drop on a folder header: top-level, first position, moving
                // the file into this folder if it lives elsewhere
                if (dragPath) placeNote({ path: dragPath, folder, index: 0 });
              }}
            >
              {isCollapsed ? '▸' : '▾'} {folder || 'vault'}{' '}
              <span className="muted">({roots.length})</span>
            </button>
            {!isCollapsed &&
              (daily.groups.length ? (
                <>
                  <DailyNoteGroups
                    groups={daily.groups}
                    currentPath={currentPath}
                    openSequence={openSequence}
                    renderNote={({ node, index }, depth) =>
                      renderNode(node, depth, folder, null, index)
                    }
                  />
                  {ordered(daily.ungrouped.map(({ node }) => node)).map((node) =>
                    renderNode(node, 0, folder, null, roots.indexOf(node)),
                  )}
                </>
              ) : (
                renderList(ordered(roots), (r, i) => renderNode(r, 0, folder, null, i))
              ))}
          </div>
        );
      })}
      {dragPath && (
        <div className="drag-hint muted small">
          drop on a note = nest · edge = reorder · folder name = move there
        </div>
      )}
    </div>
  );
});

/**
 * A long sibling list (thousands of notes in one folder) renders a window of
 * rows around the open note and grows it as either edge scrolls into view, so
 * opening a note in a big folder does not build every row. The open note's
 * neighbours are always rendered (Alt+Shift+↑/↓ walks the rows on screen).
 */
function WindowedRows({
  nodes,
  render,
  holdsCurrent,
}: {
  nodes: TreeNode[];
  render: (node: TreeNode, index: number) => React.ReactNode;
  holdsCurrent: Set<string>;
}) {
  const focus = nodes.findIndex((n) => holdsCurrent.has(n.path));
  const around = (i: number) => ({
    start: Math.max(0, i - WINDOW_STEP / 2),
    end: Math.min(nodes.length, Math.max(i, 0) + WINDOW_STEP / 2 + 1),
  });
  const [range, setRange] = useState(() =>
    focus >= 0 ? around(focus) : { start: 0, end: WINDOW_STEP },
  );
  // a note opened outside the window moves the window to it
  if (focus >= 0 && (focus < range.start + 1 || focus > range.end - 2)) {
    const next = around(focus);
    if (next.start !== range.start || next.end !== range.end) setRange(next);
  }
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target === top.current)
            setRange((r) => ({ ...r, start: Math.max(0, r.start - WINDOW_STEP) }));
          if (e.target === bottom.current)
            setRange((r) => ({ ...r, end: Math.min(nodes.length, r.end + WINDOW_STEP) }));
        }
      },
      // the sidebar scrolls, not the page: margins apply to that box
      {
        root: (top.current ?? bottom.current)?.closest('.sidebar-scroll') ?? null,
        rootMargin: '600px',
      },
    );
    if (top.current) io.observe(top.current);
    if (bottom.current) io.observe(bottom.current);
    return () => io.disconnect();
  });
  const start = Math.min(range.start, nodes.length);
  const end = Math.min(range.end, nodes.length);
  return (
    <>
      {start > 0 && (
        <div ref={top} className="tree-more muted small">
          {start} more…
        </div>
      )}
      {nodes.slice(start, end).map((n, i) => render(n, start + i))}
      {end < nodes.length && (
        <div ref={bottom} className="tree-more muted small">
          {nodes.length - end} more…
        </div>
      )}
    </>
  );
}

function countDesc(node: TreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDesc(c), 0);
}
