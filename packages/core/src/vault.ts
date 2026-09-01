/** Vault filesystem access: walking, globs, safe atomic writes. */
import { type Dirent, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { VaultConfig } from './config.ts';

export interface VaultFile {
  /** vault-relative path with forward slashes, e.g. "notes/foo.md" */
  path: string;
  mtimeMs: number;
  size: number;
  protected: boolean;
}

const ALWAYS_IGNORED = new Set(['.corpobrain', '.git', 'node_modules', '.obsidian', '.trash']);

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Minimal glob: `*`/`?` within a segment, `**` across segments. */
export function matchesGlob(path: string, glob: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${re}$`).test(path);
}

/** List every indexable file in the vault (notes + protected placeholders). */
export function walkVault(root: string, config: VaultConfig): VaultFile[] {
  const out: VaultFile[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || ALWAYS_IGNORED.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = toPosix(relative(root, abs));
      if (config.ignore.some((g) => matchesGlob(rel, g))) continue;
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        const isNote = e.name.endsWith('.md');
        const isProtected = e.name.endsWith('.md.enc');
        if (!isNote && !isProtected) continue;
        const st = statSync(abs);
        out.push({ path: rel, mtimeMs: st.mtimeMs, size: st.size, protected: isProtected });
      }
    }
  };
  walk(root);
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

/**
 * Stat one vault-relative path with the same ignore rules as walkVault():
 * null when it is not an indexable file (wrong extension, ignored folder,
 * missing, or a directory).
 */
export function vaultFileInfo(root: string, config: VaultConfig, rel: string): VaultFile | null {
  const isNote = rel.endsWith('.md');
  const isProtected = rel.endsWith('.md.enc');
  if (!isNote && !isProtected) return null;
  const segments = rel.split('/');
  if (segments.some((seg) => seg.startsWith('.') || ALWAYS_IGNORED.has(seg))) return null;
  if (config.ignore.some((g) => matchesGlob(rel, g))) return null;
  try {
    const st = statSync(join(root, rel));
    if (!st.isFile()) return null;
    return { path: rel, mtimeMs: st.mtimeMs, size: st.size, protected: isProtected };
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeFileAtomic(
  absPath: string,
  content: string | Uint8Array,
  opts: { mode?: number } = {},
): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = join(dirname(absPath), `.${Date.now()}.${process.pid}.tmp`);
  writeFileSync(tmp, content, { ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
  renameSync(tmp, absPath);
}
