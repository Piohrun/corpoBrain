/** Debounced recursive vault watcher (fs.watch, recursive works on Linux/Windows/macOS on Node 20+). */
import { type FSWatcher, watch } from 'node:fs';
import { toPosix } from './vault.ts';

export interface VaultWatcher {
  close(): void;
}

const IGNORE = /(^|\/)(\.corpobrain|\.git|node_modules)(\/|$)|\.tmp$/;

export function watchVault(
  root: string,
  onChange: (paths: string[]) => void,
  debounceMs = 250,
): VaultWatcher {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const paths = [...pending];
    pending.clear();
    if (paths.length) onChange(paths);
  };
  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = toPosix(filename.toString());
    if (IGNORE.test(rel)) return;
    if (!rel.endsWith('.md') && !rel.endsWith('.md.enc')) return;
    pending.add(rel);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  return {
    close() {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
