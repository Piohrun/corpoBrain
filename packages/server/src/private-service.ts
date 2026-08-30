/**
 * Protected notes session (Phase 7, server side). The data key and all
 * plaintext live in memory only; an in-memory FTS index exists while
 * unlocked and is destroyed on lock. Locked notes expose nothing.
 */
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CryptoError,
  changePassphrase,
  createKeystore,
  decryptNote,
  encryptNote,
  type Keystore,
  loadKeystore,
  opaqueName,
  parseFrontmatter,
  saveKeystore,
  unlockKeystore,
} from '@corpobrain/core';
import { HttpError, type VaultService } from './vault-service.ts';

interface PrivateNote {
  file: string; // opaque filename
  title: string;
  content: string;
}

export class PrivateService {
  private dataKey: Buffer | null = null;
  private mem: DatabaseSync | null = null;
  private lockTimer: NodeJS.Timeout | null = null;

  constructor(private readonly v: VaultService) {}

  private dir(): string {
    return join(this.v.root, this.v.config.folders.private);
  }

  get unlocked(): boolean {
    return this.dataKey !== null;
  }

  status(): { initialized: boolean; unlocked: boolean; lockAfterMinutes: number } {
    return {
      initialized: loadKeystore(this.v.root, this.v.config.folders.private) !== null,
      unlocked: this.unlocked,
      lockAfterMinutes: this.v.config.private.lockAfterMinutes,
    };
  }

  init(passphrase: string): void {
    if (loadKeystore(this.v.root, this.v.config.folders.private))
      throw new HttpError(409, 'protected notes are already initialized');
    const { keystore, dataKey } = wrap(() => createKeystore(passphrase));
    saveKeystore(this.v.root, this.v.config.folders.private, keystore);
    this.becomeUnlocked(dataKey);
  }

  unlock(passphrase: string): void {
    const keystore = this.requireKeystore();
    this.becomeUnlocked(wrap(() => unlockKeystore(keystore, passphrase)));
  }

  changePassphrase(oldPass: string, newPass: string): void {
    const keystore = this.requireKeystore();
    const next = wrap(() => changePassphrase(keystore, oldPass, newPass));
    saveKeystore(this.v.root, this.v.config.folders.private, next);
  }

  lock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.dataKey?.fill(0);
    this.dataKey = null;
    this.mem?.close();
    this.mem = null;
  }

  /** Sliding auto-lock window; every authenticated call extends it. */
  private touch(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    const minutes = this.v.config.private.lockAfterMinutes;
    if (minutes > 0) {
      this.lockTimer = setTimeout(() => this.lock(), minutes * 60 * 1000);
      this.lockTimer.unref?.();
    }
  }

  private becomeUnlocked(dataKey: Buffer): void {
    this.lock();
    this.dataKey = dataKey;
    this.mem = new DatabaseSync(':memory:');
    this.mem.exec(
      "CREATE VIRTUAL TABLE fts USING fts5(file UNINDEXED, title, body, tokenize='unicode61')",
    );
    for (const note of this.readAll()) {
      this.mem
        .prepare('INSERT INTO fts(file, title, body) VALUES (?, ?, ?)')
        .run(note.file, note.title, note.content);
    }
    this.touch();
  }

  private requireKeystore(): Keystore {
    const ks = loadKeystore(this.v.root, this.v.config.folders.private);
    if (!ks) throw new HttpError(409, 'protected notes are not initialized');
    return ks;
  }

  private requireUnlocked(): Buffer {
    if (!this.dataKey) throw new HttpError(401, 'locked');
    this.touch();
    return this.dataKey;
  }

  private readAll(): PrivateNote[] {
    const key = this.dataKey;
    if (!key) return [];
    const out: PrivateNote[] = [];
    let files: string[];
    try {
      files = readdirSync(this.dir()).filter((f) => f.endsWith('.md.enc'));
    } catch {
      return [];
    }
    for (const file of files) {
      try {
        const content = decryptNote(key, readFileSync(join(this.dir(), file)));
        out.push({ file, title: titleOf(content, file), content });
      } catch {
        out.push({ file, title: `(unreadable: ${file})`, content: '' });
      }
    }
    return out;
  }

  list(): { file: string; title: string }[] {
    this.requireUnlocked();
    return this.readAll().map(({ file, title }) => ({ file, title }));
  }

  read(file: string): { file: string; title: string; content: string } {
    const key = this.requireUnlocked();
    assertOpaque(file);
    const content = decryptNote(key, readFileSync(join(this.dir(), file)));
    return { file, title: titleOf(content, file), content };
  }

  write(file: string | null, content: string): { file: string } {
    const key = this.requireUnlocked();
    const name = file ?? opaqueName();
    assertOpaque(name);
    // atomic-ish: encrypted blob is small; write directly with restrictive mode
    writeFileSync(join(this.dir(), name), encryptNote(key, content), { mode: 0o600 });
    if (this.mem) {
      this.mem.prepare('DELETE FROM fts WHERE file = ?').run(name);
      this.mem
        .prepare('INSERT INTO fts(file, title, body) VALUES (?, ?, ?)')
        .run(name, titleOf(content, name), content);
    }
    this.v.indexer.updatePaths([`${this.v.config.folders.private}/${name}`]);
    return { file: name };
  }

  delete(file: string): void {
    this.requireUnlocked();
    assertOpaque(file);
    unlinkSync(join(this.dir(), file));
    this.mem?.prepare('DELETE FROM fts WHERE file = ?').run(file);
    this.v.indexer.updatePaths([`${this.v.config.folders.private}/${file}`]);
  }

  search(query: string): { file: string; title: string; snippet: string }[] {
    this.requireUnlocked();
    if (!this.mem) return [];
    const fts = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' ');
    if (!fts) return [];
    return this.mem
      .prepare(
        `SELECT file, title, snippet(fts, 2, '<<', '>>', ' … ', 12) AS snippet
         FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT 20`,
      )
      .all(fts) as unknown as { file: string; title: string; snippet: string }[];
  }
}

function titleOf(content: string, fallback: string): string {
  const parsed = parseFrontmatter(content);
  if (typeof parsed.data.title === 'string' && parsed.data.title) return parsed.data.title;
  const h1 = /^#\s+(.+)$/m.exec(content.slice(parsed.bodyOffset));
  return h1?.[1]?.trim() ?? fallback;
}

function assertOpaque(file: string): void {
  if (!/^[0-9a-f]{24}\.md\.enc$/.test(file))
    throw new HttpError(400, 'invalid protected note name');
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CryptoError) throw new HttpError(401, e.message);
    throw e;
  }
}
