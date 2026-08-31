import { useCallback, useEffect, useState } from 'react';
import { type TreeModel, type TreeNode, treeApi } from '../api.ts';

interface Props {
  tree: TreeModel;
  currentPath: string | null;
  onOpen: (path: string) => void;
  onChanged: () => void;
}

const LS_KEY = 'corpobrain.collapsed';

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
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* private windows etc. */
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

  const reparent = useCallback(
    (childPath: string, parentPath: string | null) => {
      if (childPath === parentPath) return;
      treeApi
        .meta({ path: childPath, parent: parentPath })
        .then(onChanged)
        .catch(() => {}); // server guards cycles; silently ignore invalid drops
    },
    [onChanged],
  );

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop container; open/toggle live on inner buttons */}
        <div
          className={`tree-row${node.path === currentPath ? ' active' : ''}${dropTarget === node.path ? ' drop-target' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            setDragPath(node.path);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => {
            setDragPath(null);
            setDropTarget(null);
          }}
          onDragOver={(e) => {
            if (dragPath && dragPath !== node.path) {
              e.preventDefault();
              setDropTarget(node.path);
            }
          }}
          onDragLeave={() => setDropTarget((t) => (t === node.path ? null : t))}
          onDrop={(e) => {
            e.preventDefault();
            setDropTarget(null);
            if (dragPath) reparent(dragPath, node.path);
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
        {hasKids && !isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
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
              className={`tree-folder${dropTarget === key ? ' drop-target' : ''}`}
              onClick={() => toggle(key)}
              onDragOver={(e) => {
                if (dragPath) {
                  e.preventDefault();
                  setDropTarget(key);
                }
              }}
              onDragLeave={() => setDropTarget((t) => (t === key ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                if (dragPath) reparent(dragPath, null); // drop on a folder header = make root
              }}
            >
              {isCollapsed ? '▸' : '▾'} {folder || 'vault'}{' '}
              <span className="muted">({roots.length})</span>
            </button>
            {!isCollapsed && roots.map((r) => renderNode(r, 0))}
          </div>
        );
      })}
    </div>
  );
}

function countDesc(node: TreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDesc(c), 0);
}
