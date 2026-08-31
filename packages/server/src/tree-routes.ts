/** Note hierarchy (SPEC §3.5) and note-metadata edits (type/parent/order). */
import { deleteFrontmatterKey, parseFrontmatter, setFrontmatterKey } from '@corpobrain/core';
import { Hono } from 'hono';
import { HttpError, type VaultService } from './vault-service.ts';

export interface TreeNode {
  path: string;
  title: string;
  type: string;
  order: number | null;
  children: TreeNode[];
}

export interface TreeModel {
  /** top-level folder → root nodes inside it */
  folders: { folder: string; roots: TreeNode[] }[];
}

interface Row {
  path: string;
  title: string;
  type: string;
  frontmatter_json: string;
}

export function buildTree(v: VaultService): TreeModel {
  const db = v.indexer.db;
  const jiraFolder = `${v.config.folders.jira}/`;
  const rows = (
    db
      .prepare(
        `SELECT path, title, type, frontmatter_json FROM notes
         WHERE protected = 0 ORDER BY path`,
      )
      .all() as unknown as Row[]
  ).filter((r) => !r.path.startsWith(jiraFolder) && r.type !== 'jira');

  // parent resolution reuses the links table: kind='property' rows exist for
  // every wikilink-valued property; we need specifically the `parent` key,
  // so resolve from frontmatter through the same resolver the vault uses.
  const nodes = new Map<string, TreeNode & { parentTarget: string | null }>();
  for (const r of rows) {
    const fm = JSON.parse(r.frontmatter_json) as Record<string, unknown>;
    const rawParent = typeof fm.parent === 'string' ? fm.parent : null;
    const m = rawParent ? /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/.exec(rawParent.trim()) : null;
    nodes.set(r.path, {
      path: r.path,
      title: r.title,
      type: r.type,
      order: typeof fm.order === 'number' ? fm.order : null,
      children: [],
      parentTarget: m ? (m[1] as string).trim() : rawParent,
    });
  }

  // attach children; cycle-safe (a cycle participant becomes a root)
  const parentOf = new Map<string, string>();
  for (const [path, node] of nodes) {
    if (!node.parentTarget) continue;
    const resolved = v.resolve(node.parentTarget);
    if (!resolved.exists || !nodes.has(resolved.path) || resolved.path === path) continue;
    parentOf.set(path, resolved.path);
  }
  const isAncestorOf = (candidate: string, of: string): boolean => {
    let cur: string | undefined = of;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      if (cur === candidate) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };
  const roots: TreeNode[] = [];
  for (const [path, node] of nodes) {
    const parent = parentOf.get(path);
    if (parent && !isAncestorOf(path, parent)) {
      (nodes.get(parent) as TreeNode).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (list: TreeNode[]): void => {
    list.sort(
      (a, b) =>
        (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
        a.title.localeCompare(b.title),
    );
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  // group roots by their top-level folder for the sidebar
  const byFolder = new Map<string, TreeNode[]>();
  for (const r of roots) {
    const folder = r.path.includes('/') ? (r.path.split('/')[0] as string) : '';
    const arr = byFolder.get(folder) ?? [];
    arr.push(r);
    byFolder.set(folder, arr);
  }
  return {
    folders: [...byFolder.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, list]) => ({ folder, roots: list })),
  };
}

export function treeRoutes(v: VaultService): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(buildTree(v)));

  /**
   * Edit note metadata: type (any string), parent (note path/title/null),
   * order. Guards against parenting a note under its own descendant.
   */
  app.put('/meta', async (c) => {
    const body = (await c.req.json()) as {
      path?: string;
      type?: string | null;
      parent?: string | null;
      order?: number | null;
    };
    if (!body.path) throw new HttpError(400, 'path required');
    const { content, path } = v.read(body.path);
    let text = content;

    if (body.type !== undefined) {
      if (body.type === null || body.type === '' || body.type === 'note') {
        text = deleteFrontmatterKey(text, 'type');
      } else {
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(body.type))
          throw new HttpError(400, 'type must be alphanumeric (dashes allowed)');
        text = setFrontmatterKey(text, 'type', body.type);
      }
    }

    if (body.parent !== undefined) {
      if (body.parent === null || body.parent === '') {
        text = deleteFrontmatterKey(text, 'parent');
      } else {
        const target = v.resolve(body.parent);
        if (!target.exists) throw new HttpError(404, `parent not found: ${body.parent}`);
        if (target.path === path) throw new HttpError(400, 'a note cannot be its own parent');
        if (isDescendant(v, target.path, path))
          throw new HttpError(400, 'cannot move a note under its own descendant');
        const parentTitle = (
          v.indexer.db.prepare('SELECT title FROM notes WHERE path = ?').get(target.path) as
            | { title: string }
            | undefined
        )?.title;
        text = setFrontmatterKey(text, 'parent', `[[${parentTitle ?? target.path}]]`);
      }
    }

    if (body.order !== undefined) {
      text =
        body.order === null
          ? deleteFrontmatterKey(text, 'order')
          : setFrontmatterKey(text, 'order', body.order);
    }

    if (text !== content) v.write(path, text);
    const fm = parseFrontmatter(text).data;
    return c.json({ ok: true, type: fm.type ?? 'note', parent: fm.parent ?? null });
  });

  /**
   * Place a note at a position: under a parent note (nesting) or as a root of
   * a folder group (optionally moving the file into that folder), at `index`
   * among its new siblings. Siblings are renumbered (order = 10, 20, …) so the
   * position sticks.
   */
  app.post('/place', async (c) => {
    const body = (await c.req.json()) as {
      path?: string;
      parent?: string | null; // parent note PATH (not title), or null for root
      folder?: string | null; // required when parent is null
      index?: number;
    };
    if (!body.path) throw new HttpError(400, 'path required');
    const tree = buildTree(v);
    const moving = findNode(tree, body.path);
    if (!moving) throw new HttpError(404, `not in tree: ${body.path}`);
    let path = body.path;

    let siblings: TreeNode[];
    if (body.parent) {
      const parent = findNode(tree, body.parent);
      if (!parent) throw new HttpError(404, `parent not in tree: ${body.parent}`);
      if (parent.path === path) throw new HttpError(400, 'a note cannot be its own parent');
      if (isDescendant(v, parent.path, path))
        throw new HttpError(400, 'cannot move a note under its own descendant');
      siblings = parent.children;
      const title = (
        v.indexer.db.prepare('SELECT title FROM notes WHERE path = ?').get(parent.path) as
          | { title: string }
          | undefined
      )?.title;
      const { content } = v.read(path);
      v.write(path, setFrontmatterKey(content, 'parent', `[[${title ?? parent.path}]]`));
    } else {
      const folder = body.folder ?? (path.includes('/') ? (path.split('/')[0] as string) : '');
      const group = tree.folders.find((f) => f.folder === folder);
      siblings = group?.roots ?? [];
      // cross-folder drop → move the file into that folder
      const currentFolder = path.includes('/') ? (path.split('/')[0] as string) : '';
      if (folder !== currentFolder) {
        const base = path.split('/').pop() as string;
        const target = folder ? `${folder}/${base}` : base;
        v.move(path, target);
        path = target;
      }
      const { content } = v.read(path);
      const cleared = deleteFrontmatterKey(content, 'parent');
      if (cleared !== content) v.write(path, cleared);
    }

    // renumber: siblings minus the moved note, insert at index
    const list = siblings.filter((s) => s.path !== body.path && s.path !== path);
    const idx = Math.max(0, Math.min(body.index ?? list.length, list.length));
    const ordered = [
      ...list.slice(0, idx).map((n) => n.path),
      path,
      ...list.slice(idx).map((n) => n.path),
    ];
    const orderOf = new Map(siblings.map((n) => [n.path, n.order]));
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i] as string;
      const want = (i + 1) * 10;
      if (orderOf.get(p) === want) continue;
      const { content } = v.read(p);
      v.write(p, setFrontmatterKey(content, 'order', want));
    }
    return c.json({ ok: true, path, index: idx });
  });

  return app;
}

/** Is `candidate` a descendant of `of` in the current tree? */
function isDescendant(v: VaultService, candidate: string, of: string): boolean {
  const walk = (node: TreeNode): boolean => node.path === candidate || node.children.some(walk);
  const start = findNode(buildTree(v), of);
  return start ? start.children.some(walk) : false;
}

function findNode(tree: TreeModel, path: string): TreeNode | null {
  const stack = tree.folders.flatMap((f) => f.roots);
  while (stack.length) {
    const n = stack.pop() as TreeNode;
    if (n.path === path) return n;
    stack.push(...n.children);
  }
  return null;
}
