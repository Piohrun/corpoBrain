/**
 * Debounced recursive vault watcher.
 *
 * Windows and macOS have native recursive watching. On Linux, Node emulates
 * `recursive: true` in JavaScript and re-scans the changed folder on every
 * event, which in a folder of thousands of notes cost ~25 ms per save; there
 * one non-recursive watcher per folder is used instead, adding watchers as
 * folders appear.
 */
import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';
import { toPosix } from './vault.ts';

export interface VaultWatcher {
  close(): void;
}

const IGNORE = /(^|\/)(\.corpobrain|\.git|node_modules)(\/|$)|\.tmp$/;

export function watchVault(
  root: string,
  onChange: (paths: string[]) => void,
  debounceMs = 250,
  opts: { perFolder?: boolean } = {},
): VaultWatcher {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const paths = [...pending];
    pending.clear();
    if (paths.length) onChange(paths);
  };
  const report = (rel: string) => {
    if (IGNORE.test(rel)) return;
    if (!rel.endsWith('.md') && !rel.endsWith('.md.enc')) return;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  if (!(opts.perFolder ?? process.platform === 'linux')) {
    const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) report(toPosix(filename.toString()));
    });
    return {
      close() {
        if (timer) clearTimeout(timer);
        watcher.close();
      },
    };
  }

  const watchers = new Map<string, FSWatcher>();
  /** `announce`: a folder that appeared later; the notes already in it are news too. */
  const addFolder = (rel: string, announce = false): void => {
    if (watchers.has(rel) || (rel && IGNORE.test(rel))) return;
    let w: FSWatcher;
    try {
      w = watch(join(root, rel), (event, filename) => {
        if (!filename) return;
        const child = rel ? `${rel}/${toPosix(filename.toString())}` : toPosix(filename.toString());
        if (event === 'rename' && !IGNORE.test(child)) {
          // A folder appeared, moved or vanished: (re)watch it and everything
          // below it, or drop the watchers of a folder that is gone.
          let isDir = false;
          try {
            isDir = statSync(join(root, child)).isDirectory();
          } catch {
            /* gone, or never a folder */
          }
          for (const [sub, sw] of watchers)
            if (sub === child || sub.startsWith(`${child}/`)) {
              sw.close();
              watchers.delete(sub);
            }
          if (isDir) addFolder(child, true);
        }
        report(child);
      });
    } catch {
      return; // vanished between listing and watching
    }
    w.on('error', () => {
      w.close();
      watchers.delete(rel);
    });
    watchers.set(rel, w);
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) addFolder(sub, announce);
      else if (announce) report(sub);
    }
  };
  addFolder('');
  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
