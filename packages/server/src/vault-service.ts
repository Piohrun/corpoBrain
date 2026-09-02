/** Holds the vault state for the server: config, db, indexer, watcher. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  Indexer,
  JIRA_KEY_RE,
  loadConfig,
  localDay,
  openDb,
  parseFrontmatter,
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
  /**
   * Paths we just wrote ourselves, with the time of the write; the watcher
   * event for each is ignored once. A marker the watcher never reports (event
   * coalesced, watcher hiccup) expires rather than swallowing the user's next
   * external edit of that file.
   */
  private selfWrites = new Map<string, number>();
  /** Bumped on every write we make and every external change the watcher sees. */
  changeSeq = 0;
  /** what the opening index pass cost — printed at startup so a slow start explains itself */
  readonly startup: { ms: number; summary: UpdateSummary };

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
    const t0 = performance.now();
    const summary = this.indexer.update();
    this.indexer.loadSprints();
    this.startup = { ms: Math.round(performance.now() - t0), summary };
  }

  /** Merge a partial section (jira / capacity / health) into config.json and the live config. */
  updateConfig<K extends 'jira' | 'capacity' | 'health'>(
    section: K,
    partial: Partial<VaultConfig[K]>,
  ): void {
    const cfgPath = join(this.root, '.corpobrain', 'config.json');
    let onDisk: Record<string, unknown> = {};
    try {
      onDisk = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    } catch {
      onDisk = { version: 1 };
    }
    onDisk[section] = { ...(onDisk[section] as Record<string, unknown> | undefined), ...partial };
    mkdirSync(join(this.root, '.corpobrain'), { recursive: true });
    writeFileSync(cfgPath, `${JSON.stringify(onDisk, null, 2)}\n`);
    Object.assign(this.config[section], partial);
    this.indexer.version++; // derived models (the board) depend on config too
  }

  /** Store Jira credentials in the gitignored secrets file (0600). */
  saveJiraSecrets(update: { token?: string; email?: string }): void {
    const file = join(this.root, '.corpobrain', 'secrets.json');
    let secrets: Record<string, string> = {};
    try {
      secrets = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      /* fresh */
    }
    if (update.token !== undefined) secrets.jiraToken = update.token;
    if (update.email !== undefined) secrets.jiraEmail = update.email;
    mkdirSync(join(this.root, '.corpobrain'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  }

  startWatching(): void {
    if (this.watcher) return;
    this.watcher = watchVault(this.root, (paths) => {
      const external = paths.filter((p) => !this.consumeSelfWrite(p));
      if (!external.length) return;
      this.changeSeq++;
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

  private markSelfWrite(p: string): void {
    this.changeSeq++;
    const now = Date.now();
    for (const [k, at] of this.selfWrites)
      if (now - at > SELF_WRITE_TTL_MS) this.selfWrites.delete(k);
    this.selfWrites.set(p, now);
  }

  private consumeSelfWrite(p: string): boolean {
    const at = this.selfWrites.get(p);
    if (at === undefined) return false;
    this.selfWrites.delete(p);
    return Date.now() - at <= SELF_WRITE_TTL_MS;
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

  /**
   * Vault-relative, forward-slash path with no way out and no way into the
   * tool's own files. Every dot-prefixed segment is refused (.corpobrain,
   * .git, .trash, .keystore.json, editor swap files…) — the walker never
   * indexes those either — and the private folder is compared
   * case-insensitively because the work laptop's filesystem is.
   */
  private assertSafe(relPath: string): string {
    const p = toPosix(relPath).replace(/^\/+/, '');
    const segments = p.split('/');
    if (segments[0]?.toLowerCase() === this.config.folders.private.toLowerCase())
      throw new HttpError(403, 'protected notes are not accessible over the API');
    if (!p || /^[a-zA-Z]:/.test(p) || segments.some((seg) => seg === '' || seg.startsWith('.')))
      throw new HttpError(400, 'invalid path');
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
    this.markSelfWrite(p);
    writeFileAtomic(join(this.root, p), content);
    return this.indexer.updatePaths([p]);
  }

  /**
   * Property-level edit of a note's frontmatter (SPEC §4). A note whose
   * frontmatter does not parse is never written to by the tool — patching it
   * would silently destroy whatever the user was in the middle of — so the
   * caller gets a 409 and the user fixes it in the editor first. Writes only
   * when `mutate` changed something.
   */
  patchNote(
    relPath: string,
    mutate: (content: string) => string,
  ): { path: string; changed: boolean } {
    const { path, content } = this.read(relPath);
    const fm = parseFrontmatter(content);
    if (fm.error)
      throw new HttpError(
        409,
        `${path}: frontmatter cannot be parsed (${fm.error}) — fix it in the editor first`,
      );
    const next = mutate(content);
    if (next === content) return { path, changed: false };
    this.write(path, next);
    return { path, changed: true };
  }

  /** Move/rename a note within the vault. Links by title keep resolving. */
  move(fromRel: string, toRel: string): void {
    const from = this.assertSafe(fromRel);
    const to = this.assertSafe(toRel);
    if (!from.endsWith('.md') || !to.endsWith('.md'))
      throw new HttpError(400, 'only .md files move');
    const fromAbs = join(this.root, from);
    const toAbs = join(this.root, to);
    if (!existsSync(fromAbs)) throw new HttpError(404, `not found: ${from}`);
    if (existsSync(toAbs)) throw new HttpError(409, `already exists: ${to}`);
    this.markSelfWrite(from);
    this.markSelfWrite(to);
    writeFileAtomic(toAbs, readFileSync(fromAbs, 'utf8'));
    unlinkSync(fromAbs);
    this.indexer.updatePaths([from, to]);
  }

  delete(relPath: string): void {
    const p = this.assertSafe(relPath);
    const abs = join(this.root, p);
    if (!existsSync(abs)) throw new HttpError(404, `not found: ${p}`);
    this.markSelfWrite(p);
    // move to OS-independent trash inside the vault rather than unlink
    const trashDir = join(this.root, '.trash');
    mkdirSync(trashDir, { recursive: true });
    const trashed = join(trashDir, `${Date.now()}-${p.replace(/\//g, '__')}`);
    copyFileSync(abs, trashed);
    unlinkSync(abs);
    this.indexer.updatePaths([p]);
    pruneTrash(trashDir);
  }

  /** Bring the most recent .trash copy of a deleted note back (the Undo after delete). */
  restore(relPath: string): { path: string } {
    const p = this.assertSafe(relPath);
    const abs = join(this.root, p);
    if (existsSync(abs)) throw new HttpError(409, `already exists: ${p}`);
    const trashDir = join(this.root, '.trash');
    const suffix = `-${p.replace(/\//g, '__')}`;
    let candidates: string[] = [];
    try {
      candidates = readdirSync(trashDir).filter((f) => f.endsWith(suffix));
    } catch {
      candidates = [];
    }
    const latest = candidates.sort().at(-1);
    if (!latest) throw new HttpError(404, `nothing in the trash for ${p}`);
    this.markSelfWrite(p);
    mkdirSync(join(abs, '..'), { recursive: true });
    copyFileSync(join(trashDir, latest), abs);
    unlinkSync(join(trashDir, latest));
    this.indexer.updatePaths([p]);
    return { path: p };
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
  create(relPath: string, title: string, content?: string, type?: string): { path: string } {
    const p = this.assertSafe(relPath);
    const abs = join(this.root, p);
    if (existsSync(abs)) return { path: p };
    const body = content ?? this.templateFor(title, type);
    this.markSelfWrite(p);
    writeFileAtomic(abs, body);
    this.indexer.updatePaths([p]);
    return { path: p };
  }

  dailyPath(date?: string): string {
    const d = date ?? localDay();
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

  private templateFor(title: string, type?: string): string {
    const today = localDay();
    if (type) {
      const tpl = join(this.root, this.config.folders.templates, `${type}.md`);
      if (existsSync(tpl)) {
        const raw = readFileSync(tpl, 'utf8')
          .replace(/\{\{title\}\}/g, title)
          .replace(/\{\{date\}\}/g, today);
        return applyTemplate(raw, today).replace(/\{\{title\}\}/g, title);
      }
      return `---\ntype: ${type}\ntitle: ${JSON.stringify(title)}\ncreated: ${today}\n---\n\n# ${title}\n\n`;
    }
    return `---\ntitle: ${JSON.stringify(title)}\ncreated: ${today}\n---\n\n# ${title}\n\n`;
  }
}

/** how long a self-write marker may wait for its watcher event */
const SELF_WRITE_TTL_MS = 5_000;

/** .trash is a safety net, not an archive (git has the history): drop entries older than 30 days. */
const TRASH_KEEP_MS = 30 * 86_400_000;
function pruneTrash(trashDir: string): void {
  try {
    const cutoff = Date.now() - TRASH_KEEP_MS;
    for (const f of readdirSync(trashDir)) {
      const stamp = Number(/^(\d+)-/.exec(f)?.[1]);
      const abs = join(trashDir, f);
      const old = Number.isFinite(stamp) ? stamp < cutoff : statSync(abs).mtimeMs < cutoff;
      if (old) unlinkSync(abs);
    }
  } catch {
    /* best effort */
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
