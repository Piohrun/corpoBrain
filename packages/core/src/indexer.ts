/** Vault indexer: files in, SQLite index out. See docs/SPEC.md §5 and §10. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { VaultConfig } from './config.ts';
import { parseFrontmatter, setFrontmatterKey } from './frontmatter.ts';
import { scanMarkdown } from './scan.ts';
import { generateUlid } from './ulid.ts';
import { type VaultFile, walkVault, writeFileAtomic } from './vault.ts';

export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const JIRA_MARKER = '<!-- jira:end -->';

const RESERVED_KEYS = new Set([
  'id',
  'type',
  'title',
  'aliases',
  'tags',
  'created',
  'updated',
  'template',
  'plan',
  'jira',
]);

export interface UpdateSummary {
  indexed: string[];
  removed: string[];
  unchanged: number;
  idsAssigned: number;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

export interface Backlink {
  srcPath: string;
  srcTitle: string;
  kind: string;
  line: number;
  alias: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export class Indexer {
  constructor(
    readonly root: string,
    readonly config: VaultConfig,
    readonly db: DatabaseSync,
  ) {}

  // ------------------------------------------------------------------ build

  rebuild(): UpdateSummary {
    this.loadSprints();
    const files = walkVault(this.root, this.config);
    const known = new Set(files.map((f) => f.path));
    const stale = (this.db.prepare('SELECT path FROM notes').all() as { path: string }[]).filter(
      (r) => !known.has(r.path),
    );
    return this.applyChanges(
      files,
      stale.map((r) => r.path),
    );
  }

  /** Incremental: compare stat info against the index. */
  update(): UpdateSummary {
    const files = walkVault(this.root, this.config);
    const rows = this.db.prepare('SELECT path, mtime, size FROM notes').all() as {
      path: string;
      mtime: number;
      size: number;
    }[];
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const changed: VaultFile[] = [];
    let unchanged = 0;
    for (const f of files) {
      const row = byPath.get(f.path);
      byPath.delete(f.path);
      if (row && row.mtime === Math.trunc(f.mtimeMs) && row.size === f.size) unchanged++;
      else changed.push(f);
    }
    const summary = this.applyChanges(changed, [...byPath.keys()]);
    summary.unchanged = unchanged;
    return summary;
  }

  /** Re-index specific relative paths (missing on disk → removed). */
  updatePaths(paths: string[]): UpdateSummary {
    const files: VaultFile[] = [];
    const removed: string[] = [];
    for (const p of paths) {
      const found = walkVault(this.root, this.config).find((f) => f.path === p);
      if (found) files.push(found);
      else removed.push(p);
    }
    return this.applyChanges(files, removed);
  }

  /** Sprints live in .corpobrain/jira-cache/sprints.json (written by sync). */
  loadSprints(): number {
    const file = join(this.root, '.corpobrain', 'jira-cache', 'sprints.json');
    let sprints: {
      id: number;
      name: string;
      state?: string;
      startDate?: string;
      endDate?: string;
      originBoardId?: number;
      goal?: string;
    }[];
    try {
      sprints = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return 0;
    }
    this.db.exec("DELETE FROM sprints WHERE source = 'jira'");
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO sprints(id, name, state, start, end, board_id, goal, source, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'jira', NULL)`,
    );
    for (const s of sprints) {
      ins.run(
        s.id,
        s.name,
        s.state ?? null,
        s.startDate ?? null,
        s.endDate ?? null,
        s.originBoardId ?? null,
        s.goal ?? null,
      );
    }
    return sprints.length;
  }

  private applyChanges(files: VaultFile[], removed: string[]): UpdateSummary {
    const summary: UpdateSummary = {
      indexed: [],
      removed,
      unchanged: 0,
      idsAssigned: 0,
    };
    this.db.exec('BEGIN');
    try {
      for (const p of removed) this.deleteRows(p);
      for (const f of files) {
        summary.idsAssigned += this.indexFile(f) ? 1 : 0;
        summary.indexed.push(f.path);
      }
      if (files.length || removed.length) this.resolveAll();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return summary;
  }

  private deleteRows(path: string): void {
    for (const t of [
      'notes',
      'aliases',
      'links',
      'tags',
      'properties',
      'tasks',
      'headings',
      'blocks',
    ])
      this.db
        .prepare(`DELETE FROM ${t} WHERE ${t === 'links' ? 'src_path' : 'path'} = ?`)
        .run(path);
    this.db.prepare('DELETE FROM notes_fts WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM jira WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM plan WHERE key NOT IN (SELECT key FROM jira)').run();
    this.db.prepare('DELETE FROM people WHERE path = ?').run(path);
    this.db.prepare("DELETE FROM sprints WHERE source = 'local' AND path = ?").run(path);
  }

  /** Returns true when an id was assigned (file rewritten). */
  private indexFile(fIn: VaultFile): boolean {
    let f = fIn;
    this.deleteRows(f.path);
    if (f.protected) {
      this.db
        .prepare(
          'INSERT INTO notes(path, title, mtime, size, hash, protected) VALUES (?, ?, ?, ?, ?, 1)',
        )
        .run(f.path, 'Protected note', Math.trunc(f.mtimeMs), f.size, '');
      return false;
    }

    const abs = join(this.root, f.path);
    let text = readFileSync(abs, 'utf8');
    let parsed = parseFrontmatter(text);
    let assignedId = false;

    const inJiraFolder = f.path.startsWith(`${this.config.folders.jira}/`);
    if (
      this.config.index.assignIds &&
      !parsed.error &&
      !inJiraFolder &&
      typeof parsed.data.id !== 'string'
    ) {
      text = setFrontmatterKey(text, 'id', generateUlid(), { position: 'start' });
      writeFileAtomic(abs, text);
      const st = statSync(abs);
      f = { ...f, mtimeMs: st.mtimeMs, size: st.size };
      parsed = parseFrontmatter(text);
      assignedId = true;
    }

    const fm = parsed.data;
    const title =
      str(fm.title) ??
      /^#\s+(.+)$/m.exec(text.slice(parsed.bodyOffset))?.[1]?.trim() ??
      basename(f.path, '.md');
    const type = str(fm.type) ?? this.typeFromPath(f.path);
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);

    this.db
      .prepare(
        `INSERT INTO notes(path, id, type, title, mtime, size, hash, frontmatter_json, frontmatter_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.path,
        str(fm.id),
        type,
        title,
        Math.trunc(f.mtimeMs),
        f.size,
        hash,
        JSON.stringify(fm),
        parsed.error ? 1 : 0,
      );

    // aliases (title + declared aliases + basename handled at resolve time)
    const insAlias = this.db.prepare('INSERT INTO aliases(path, alias) VALUES (?, ?)');
    insAlias.run(f.path, title.toLowerCase());
    if (Array.isArray(fm.aliases))
      for (const a of fm.aliases) if (typeof a === 'string') insAlias.run(f.path, a.toLowerCase());

    // FTS over title + body (generated Jira region included on purpose)
    this.db
      .prepare('INSERT INTO notes_fts(path, title, body) VALUES (?, ?, ?)')
      .run(f.path, title, text.slice(parsed.bodyOffset));

    // body scan
    const scan = scanMarkdown(text, {
      jiraProjectKeys: this.config.jira.projectKeys,
      ...(inJiraFolder ? { skipUntilMarker: JIRA_MARKER } : {}),
    });
    const insLink = this.db.prepare(
      'INSERT INTO links(src_path, dst_target, kind, fragment, alias, line, col) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const l of scan.links)
      insLink.run(f.path, l.target, l.kind, l.fragment, l.alias, l.line, l.col);

    // Tags come exclusively from frontmatter (SPEC §3.2). Inline #tags in the
    // body are styling only; the scanner still reports them for rendering.
    const insTag = this.db.prepare('INSERT INTO tags(path, tag) VALUES (?, ?)');
    const tagSet = new Set<string>();
    if (Array.isArray(fm.tags)) {
      for (const t of fm.tags) {
        if (typeof t === 'string') tagSet.add(t.trim().toLowerCase());
      }
    } else if (typeof fm.tags === 'string') {
      tagSet.add(fm.tags.trim().toLowerCase());
    }
    for (const t of tagSet) if (t) insTag.run(f.path, t);

    const insTask = this.db.prepare(
      'INSERT INTO tasks(path, line, block_id, text, done, due) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const t of scan.tasks)
      insTask.run(f.path, t.line, t.blockId, t.text, t.done ? 1 : 0, t.due);

    const insHeading = this.db.prepare(
      'INSERT INTO headings(path, level, text, line) VALUES (?, ?, ?, ?)',
    );
    for (const h of scan.headings) insHeading.run(f.path, h.level, h.text, h.line);

    const insBlock = this.db.prepare('INSERT INTO blocks(path, block_id, line) VALUES (?, ?, ?)');
    for (const b of scan.blocks) insBlock.run(f.path, b.blockId, b.line);

    // properties + property links
    const insProp = this.db.prepare(
      'INSERT INTO properties(path, key, value_json) VALUES (?, ?, ?)',
    );
    for (const [k, v] of Object.entries(fm)) {
      if (!RESERVED_KEYS.has(k)) insProp.run(f.path, k, JSON.stringify(v ?? null));
    }
    for (const target of collectWikilinkValues(fm)) {
      insLink.run(f.path, target, 'property', null, null, 0, 0);
    }

    if (type === 'jira') this.indexJira(f.path, fm);
    if (type === 'sprint') this.indexLocalSprint(f.path, title, fm);
    if (type === 'person') this.indexPerson(f.path, title, fm);
    return assignedId;
  }

  /** Category = top-level folder. Derived type when frontmatter has none. */
  private typeFromPath(path: string): string {
    const folder = path.includes('/') ? (path.split('/')[0] as string) : '';
    const f = this.config.folders;
    if (folder === f.people) return 'person';
    if (folder === f.daily) return 'daily';
    if (folder === f.templates) return 'template';
    if (folder === f.jira) return 'jira';
    if (folder === '' || folder === f.notes || folder === f.planning || folder === f.attachments)
      return 'note';
    return folder;
  }

  private indexJira(path: string, fm: Record<string, unknown>): void {
    const key = str(fm.key);
    if (!key) return;
    const jiraMeta = (fm.jira ?? {}) as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO jira(key, path, summary, status, status_category, issue_type,
           priority, assignee, reporter, sprint, sprint_id, epic, parent, labels_json,
           estimate, created, updated, resolved, synced, profile)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        path,
        str(fm.summary),
        str(fm.status),
        str(fm.status_category),
        str(fm.issue_type),
        str(fm.priority),
        str(fm.assignee),
        str(fm.reporter),
        str(fm.sprint),
        num(fm.sprint_id),
        unwrapWikilink(str(fm.epic)),
        unwrapWikilink(str(fm.parent)),
        JSON.stringify(fm.labels ?? []),
        num(fm.estimate),
        str(fm.created),
        str(fm.updated),
        str(fm.resolved),
        str(jiraMeta.synced),
        str(jiraMeta.profile),
      );
    const plan = (fm.plan ?? {}) as Record<string, unknown>;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO plan(key, sprint, assignee, rank, effort, risk, confidence,
           bucket, blocked_on_json, note, project, start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        str(plan.sprint),
        str(plan.assignee),
        num(plan.rank),
        num(plan.effort),
        str(plan.risk),
        str(plan.confidence),
        str(plan.bucket),
        JSON.stringify(
          (Array.isArray(plan.blocked_on) ? plan.blocked_on : [])
            .map((x) => unwrapWikilink(str(x)))
            .filter(Boolean),
        ),
        str(plan.note),
        str(plan.project),
        str(plan.start),
      );
  }

  private indexLocalSprint(path: string, title: string, fm: Record<string, unknown>): void {
    // deterministic negative id from the path so it never collides with Jira ids
    let hash = 0;
    for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) | 0;
    const id = -Math.abs(hash || 1);
    const state = str(fm.state) ?? 'future';
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sprints(id, name, state, start, end, board_id, goal, source, path)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'local', ?)`,
      )
      .run(
        id,
        str(fm.name) ?? title,
        ['active', 'future', 'closed'].includes(state) ? state : 'future',
        str(fm.start),
        str(fm.end),
        str(fm.goal),
        path,
      );
  }

  private indexPerson(path: string, title: string, fm: Record<string, unknown>): void {
    const jiraIds = Array.isArray(fm.jira)
      ? fm.jira.filter((x): x is string => typeof x === 'string')
      : str(fm.jira)
        ? [fm.jira as string]
        : [];
    this.db
      .prepare(
        `INSERT OR REPLACE INTO people(path, jira_id, name, capacity, overrides_json, active, region, team, load_overrides_json, color, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        path,
        JSON.stringify(jiraIds),
        title,
        num(fm.capacity),
        JSON.stringify(fm.capacity_overrides ?? {}),
        fm.active === false ? 0 : 1,
        str(fm.region),
        str(fm.team),
        JSON.stringify(fm.load_overrides ?? {}),
        str(fm.color),
        num(fm.order),
      );
  }

  // ---------------------------------------------------------------- resolve

  /** Recompute dst_path for every link row (SPEC §5.2). */
  resolveAll(): void {
    const notes = this.db.prepare('SELECT path, protected FROM notes').all() as {
      path: string;
      protected: number;
    }[];
    const pathSet = new Set<string>();
    const byBase = new Map<string, string[]>();
    for (const n of notes) {
      if (n.protected) continue;
      const noExt = n.path.replace(/\.md$/, '');
      pathSet.add(noExt.toLowerCase());
      const base = basename(noExt).toLowerCase();
      const arr = byBase.get(base) ?? [];
      arr.push(n.path);
      byBase.set(base, arr);
    }
    const byAlias = new Map<string, Set<string>>();
    for (const a of this.db.prepare('SELECT path, alias FROM aliases').all() as {
      path: string;
      alias: string;
    }[]) {
      const set = byAlias.get(a.alias) ?? new Set();
      set.add(a.path);
      byAlias.set(a.alias, set);
    }
    const pathByLower = new Map<string, string>();
    for (const n of notes)
      if (!n.protected) pathByLower.set(n.path.replace(/\.md$/, '').toLowerCase(), n.path);

    const links = this.db.prepare('SELECT rowid, src_path, dst_target, kind FROM links').all() as {
      rowid: number;
      src_path: string;
      dst_target: string;
      kind: string;
    }[];
    const upd = this.db.prepare('UPDATE links SET dst_path = ?, ambiguous = ? WHERE rowid = ?');

    for (const l of links) {
      const target = l.dst_target;
      let dst: string | null = null;
      let ambiguous = 0;
      if (target === '') {
        dst = l.src_path; // within-note fragment link
      } else if (JIRA_KEY_RE.test(target)) {
        dst = `${this.config.folders.jira}/${target}.md`;
      } else {
        const lower = target.toLowerCase().replace(/\.md$/, '');
        const exact = pathByLower.get(lower);
        if (exact) {
          dst = exact;
        } else {
          const viaAlias = byAlias.get(lower);
          if (viaAlias?.size === 1) dst = [...viaAlias][0] as string;
          else if (viaAlias && viaAlias.size > 1) ambiguous = 1;
          else {
            const viaBase = byBase.get(lower);
            if (viaBase?.length === 1) dst = viaBase[0] as string;
            else if (viaBase && viaBase.length > 1) ambiguous = 1;
          }
        }
      }
      upd.run(dst, ambiguous, l.rowid);
    }
  }

  // ---------------------------------------------------------------- queries

  search(query: string, limit = 20): SearchHit[] {
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' ');
    if (!ftsQuery) return [];
    return this.db
      .prepare(
        `SELECT path, title, snippet(notes_fts, 2, '<<', '>>', ' … ', 12) AS snippet
         FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as SearchHit[];
  }

  backlinks(path: string): Backlink[] {
    return this.db
      .prepare(
        `SELECT l.src_path AS srcPath, n.title AS srcTitle, l.kind, l.line, l.alias
         FROM links l JOIN notes n ON n.path = l.src_path
         WHERE l.dst_path = ? ORDER BY l.src_path, l.line`,
      )
      .all(path) as unknown as Backlink[];
  }

  unresolved(): { srcPath: string; target: string; line: number; ambiguous: number }[] {
    return this.db
      .prepare(
        `SELECT src_path AS srcPath, dst_target AS target, line, ambiguous
         FROM links WHERE dst_path IS NULL AND dst_target != '' ORDER BY src_path, line`,
      )
      .all() as unknown as { srcPath: string; target: string; line: number; ambiguous: number }[];
  }
}

function unwrapWikilink(v: string | null): string | null {
  if (v === null) return null;
  const m = /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/.exec(v.trim());
  return m ? (m[1] as string).trim() : v;
}

function collectWikilinkValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const m = /^\[\[([^[\]|#]+)(?:\|[^[\]]*)?\]\]$/.exec(value.trim());
    if (m) out.push((m[1] as string).trim());
  } else if (Array.isArray(value)) {
    for (const v of value) collectWikilinkValues(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectWikilinkValues(v, out);
  }
  return out;
}
