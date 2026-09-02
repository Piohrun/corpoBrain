import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { type TreeModel, type TreeNode, treeApi } from '../api.ts';
import { lsJson, lsSetJson } from '../storage.ts';

interface Props {
  tree: TreeModel;
  currentPath: string | null;
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

export function NoteTree({
  tree,
  currentPath,
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
      currentPath !== null && contains(node, currentPath),
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
          ordered(node.children).map((c, i) => renderNode(c, depth + 1, folder, node.path, i))}
      </div>
    );
  };

  return (
    <div>
      {tree.folders.map(({ folder, roots }) => {
        const key = `folder:${folder}`;
        const isCollapsed = isCollapsedKey(
          key,
          roots.length,
          currentPath !== null && roots.some((r) => contains(r, currentPath)),
        );
        return (
          <div key={key}>
            <button
              type="button"
              className={`tree-folder${spot?.key === key ? ' drop-into' : ''}`}
              onClick={() => toggle(key, roots.length)}
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
            {!isCollapsed && ordered(roots).map((r, i) => renderNode(r, 0, folder, null, i))}
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
}

function contains(node: TreeNode, path: string): boolean {
  return node.path === path || node.children.some((c) => contains(c, path));
}

function countDesc(node: TreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDesc(c), 0);
}
