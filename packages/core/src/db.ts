/** SQLite index per docs/SPEC.md §10. The database is disposable. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = '0.2.0/9';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS notes(
  path TEXT PRIMARY KEY, id TEXT, type TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
  hash TEXT NOT NULL, frontmatter_json TEXT NOT NULL DEFAULT '{}',
  frontmatter_error INTEGER NOT NULL DEFAULT 0,
  protected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notes_id ON notes(id);
CREATE INDEX IF NOT EXISTS notes_type ON notes(type);
CREATE TABLE IF NOT EXISTS aliases(path TEXT NOT NULL, alias TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS aliases_path ON aliases(path);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, body, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS links(
  src_path TEXT NOT NULL, dst_target TEXT NOT NULL, dst_path TEXT,
  kind TEXT NOT NULL, fragment TEXT, alias TEXT,
  line INTEGER NOT NULL, col INTEGER NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS links_src ON links(src_path);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_path);
CREATE TABLE IF NOT EXISTS tags(path TEXT NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS tags_path ON tags(path);
CREATE TABLE IF NOT EXISTS properties(path TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS properties_path ON properties(path);
CREATE INDEX IF NOT EXISTS properties_key ON properties(key);
CREATE TABLE IF NOT EXISTS tasks(
  path TEXT NOT NULL, line INTEGER NOT NULL, block_id TEXT,
  text TEXT NOT NULL, done INTEGER NOT NULL, due TEXT
);
CREATE INDEX IF NOT EXISTS tasks_path ON tasks(path);
CREATE TABLE IF NOT EXISTS headings(path TEXT NOT NULL, level INTEGER NOT NULL, text TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS headings_path ON headings(path);
CREATE TABLE IF NOT EXISTS blocks(path TEXT NOT NULL, block_id TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS blocks_path ON blocks(path);
CREATE TABLE IF NOT EXISTS jira(
  key TEXT PRIMARY KEY, path TEXT NOT NULL, summary TEXT, status TEXT,
  status_category TEXT, issue_type TEXT, priority TEXT, assignee TEXT,
  reporter TEXT, sprint TEXT, sprint_id INTEGER, epic TEXT, parent TEXT,
  labels_json TEXT, estimate REAL, created TEXT, updated TEXT, resolved TEXT,
  synced TEXT, profile TEXT
);
CREATE TABLE IF NOT EXISTS plan(
  key TEXT PRIMARY KEY, sprint TEXT, assignee TEXT, rank REAL, effort REAL,
  risk TEXT, confidence TEXT, bucket TEXT, blocked_on_json TEXT, note TEXT,
  project TEXT, start TEXT
);
CREATE TABLE IF NOT EXISTS sprints(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT, start TEXT, end TEXT,
  board_id INTEGER, goal TEXT,
  source TEXT NOT NULL DEFAULT 'jira', path TEXT
);
CREATE TABLE IF NOT EXISTS people(
  path TEXT PRIMARY KEY, jira_id TEXT, name TEXT NOT NULL, capacity REAL,
  overrides_json TEXT, active INTEGER NOT NULL DEFAULT 1,
  region TEXT, team TEXT, load_overrides_json TEXT, color TEXT,
  sort_order REAL, country TEXT
);
`;

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    if (row?.value !== SCHEMA_VERSION) resetDb(db);
  }
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    SCHEMA_VERSION,
  );
  return db;
}

export function resetDb(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string; type: string }[];
  for (const r of rows) {
    db.exec(`DROP ${r.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${r.name}"`);
  }
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    SCHEMA_VERSION,
  );
}
