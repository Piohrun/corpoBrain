import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { TreeModel, TreeNode } from '../api.ts';

interface Props {
  tree: TreeModel;
  currentPath: string | null;
  onOpen: (path: string) => void;
  onChanged: () => void;
}

const LS_KEY = 'corpobrain.collapsed';

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

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function NoteTree({ tree, currentPath, onOpen, onChanged }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [spot, setSpot] = useState<DropSpot | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const placeNote = useCallback(
    (body: { path: string; parent?: string | null; folder?: string | null; index?: number }) => {
      fetch('/api/tree/place', { method: 'POST', body: JSON.stringify(body) })
        .then((r) => {
          if (r.ok) onChanged();
        })
        .catch(() => {});
    },
    [onChanged],
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
    const isCollapsed = collapsed.has(node.path);
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
                toggle(node.path);
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
          node.children.map((c, i) => renderNode(c, depth + 1, folder, node.path, i))}
      </div>
    );
  };

  return (
    <div>
      {tree.folders.map(({ folder, roots }) => {
        const key = `folder:${folder}`;
        const isCollapsed = collapsed.has(key);
        return (
          <div key={key}>
            <button
              type="button"
              className={`tree-folder${spot?.key === key ? ' drop-into' : ''}`}
              onClick={() => toggle(key)}
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
            {!isCollapsed && roots.map((r, i) => renderNode(r, 0, folder, null, i))}
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

function countDesc(node: TreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDesc(c), 0);
}
