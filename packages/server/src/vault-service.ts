/** Holds the vault state for the server: config, db, indexer, watcher. */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  Indexer,
  JIRA_KEY_RE,
  loadConfig,
  openDb,
  toPosix,
  type UpdateSummary,
  type VaultConfig,
  type VaultWatcher,
  watchVault,
  writeFileAtomic,
} from '@corpobrain/core';

export interface NoteListItem {
  path: string;
  title: string;
  type: string;
  mtime: number;
  protected: boolean;
}

export class VaultService {
  readonly config: VaultConfig;
  readonly indexer: Indexer;
  private watcher: VaultWatcher | null = null;
  private listeners = new Set<(paths: string[]) => void>();
  /** Paths we just wrote ourselves; watcher events for them are ignored once. */
  private selfWrites = new Set<string>();

  constructor(
    readonly root: string,
    dbPath?: string,
  ) {
    this.config = loadConfig(root);
    this.indexer = new Indexer(
      root,
      this.config,
      openDb(dbPath ?? join(root, '.corpobrain', 'index.sqlite')),
    );
    this.indexer.update();
  }

  startWatching(): void {
    if (this.watcher) return;
    this.watcher = watchVault(this.root, (paths) => {
      const external = paths.filter((p) => !this.selfWrites.delete(p));
      if (!external.length) return;
      const summary = this.indexer.updatePaths(external);
      if (summary.indexed.length || summary.removed.length) {
        for (const fn of this.listeners) fn([...summary.indexed, ...summary.removed]);
      }
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Broadcast that jira data changed (after a sync) so UIs refresh. */
  notifyJiraChanged(_reports: unknown): void {
    for (const fn of this.listeners) fn(['jira/*']);
  }

  onChange(fn: (paths: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ notes

  private assertSafe(relPath: string): string {
    const p = toPosix(relPath).replace(/^\/+/, '');
    if (p.includes('..') || p.startsWith('.corpobrain') || p.startsWith('.git'))
      throw new HttpError(400, 'invalid path');
    if (p.startsWith(`${this.config.folders.private}/`))
      throw new HttpError(403, 'protected notes are not accessible over the API');
    return p;
  }

  list(): NoteListItem[] {
    return this.indexer.db
      .prepare(`SELECT path, title, type, mtime, protected FROM notes ORDER BY path`)
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          path: row.path as string,
          title: row.title as string,
          type: row.type as string,
          mtime: row.mtime as number,
          protected: row.protected === 1,
        };
      });
  }

  read(relPath: string): { path: string; content: string } {
    const p = this.assertSafe(relPath);
    const abs = join(this.root, p);
    if (!existsSync(abs)) throw new HttpError(404, `not found: ${p}`);
    return { path: p, content: readFileSync(abs, 'utf8') };
  }

  write(relPath: string, content: string): UpdateSummary {
    const p = this.assertSafe(relPath);
    if (!p.endsWith('.md')) throw new HttpError(400, 'only .md files are writable');
    this.selfWrites.add(p);
    writeFileAtomic(join(this.root, p), content);
    return this.indexer.updatePaths([p]);
  }

  delete(relPath: string): void {
    const p = this.assertSafe(relPath);
    const abs = join(this.root, p);
    if (!existsSync(abs)) throw new HttpError(404, `not found: ${p}`);
    this.selfWrites.add(p);
    // move to OS-independent trash inside the vault rather than unlink
    const trashDir = join(this.root, '.trash');
    mkdirSync(trashDir, { recursive: true });
    const trashed = join(trashDir, `${Date.now()}-${p.replace(/\//g, '__')}`);
    writeFileAtomic(trashed, readFileSync(abs, 'utf8'));
    unlinkSync(abs);
    this.indexer.updatePaths([p]);
  }

  /**
   * Resolve a link target the same way the indexer does; if it does not
   * resolve, report the path where a new note would be created.
   */
  resolve(target: string): { path: string; exists: boolean } {
    const t = target.trim();
    if (JIRA_KEY_RE.test(t)) {
      const p = `${this.config.folders.jira}/${t}.md`;
      return { path: p, exists: existsSync(join(this.root, p)) };
    }
    const row = this.indexer.db
      .prepare(
        `SELECT n.path FROM notes n
         LEFT JOIN aliases a ON a.path = n.path
         WHERE lower(replace(n.path, '.md', '')) = lower(?) OR a.alias = lower(?)
         LIMIT 2`,
      )
      .all(t, t) as { path: string }[];
    if (row.length === 1) return { path: (row[0] as { path: string }).path, exists: true };
    const safe = t.replace(/[\\:*?"<>|]/g, '-');
    return { path: `${this.config.links.newNoteFolder}/${safe}.md`, exists: false };
  }

  /** Create a note (from resolve() of an unresolved link, or explicitly). */
  create(relPath: string, title: string, content?: string): { path: string } {
    const p = this.assertSafe(relPath);
    const abs = join(this.root, p);
    if (existsSync(abs)) return { path: p };
    const body = content ?? this.templateFor(title);
    this.selfWrites.add(p);
    writeFileAtomic(abs, body);
    this.indexer.updatePaths([p]);
    return { path: p };
  }

  dailyPath(date?: string): string {
    const d = date ?? new Date().toISOString().slice(0, 10);
    return `${this.config.folders.daily}/${d}.md`;
  }

  openDaily(date?: string): { path: string; created: boolean } {
    const p = this.dailyPath(date);
    const abs = join(this.root, p);
    if (existsSync(abs)) return { path: p, created: false };
    const d = p.slice(-13, -3);
    const tpl = join(this.root, this.config.folders.templates, 'daily.md');
    const raw = existsSync(tpl) ? readFileSync(tpl, 'utf8') : `# ${d}\n\n`;
    this.create(p, d, applyTemplate(raw, d));
    return { path: p, created: true };
  }

  private templateFor(title: string): string {
    const today = new Date().toISOString().slice(0, 10);
    return `---\ntitle: ${JSON.stringify(title)}\ncreated: ${today}\n---\n\n# ${title}\n\n`;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function applyTemplate(raw: string, dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const shift = (days: number) => {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return raw
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{title\}\}/g, dateStr)
    .replace(/\{\{yesterday\}\}/g, shift(-1))
    .replace(/\{\{tomorrow\}\}/g, shift(1))
    .replace(/\{\{time\}\}/g, new Date().toTimeString().slice(0, 5))
    .replace(/\{\{cursor\}\}/g, '');
}
