/**
 * Git-based history for the vault (Phase 6): auto-init, periodic auto-commit,
 * commit-after-sync. Uses the system git binary; failures are logged, never
 * fatal — the vault must keep working without git.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const instances = new Map<string, GitService>();

/** One shared GitService per vault so status/error state is visible app-wide. */
export function gitFor(root: string): GitService {
  let g = instances.get(root);
  if (!g) {
    g = new GitService(root);
    instances.set(root, g);
  }
  return g;
}

export class GitService {
  lastError: string | null = null;
  lastCommit: { hash: string; at: string; message: string } | null = null;

  constructor(readonly root: string) {}

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await run(
      'git',
      // safe.directory: corporate Windows setups (network homes, differing
      // owners) otherwise fail every call with "detected dubious ownership".
      ['-C', this.root, '-c', `safe.directory=${this.root}`, ...args],
      {
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
    );
    return stdout.trim();
  }

  async available(): Promise<boolean> {
    try {
      await run('git', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async isRepo(): Promise<boolean> {
    try {
      return (await this.git('rev-parse', '--is-inside-work-tree')) === 'true';
    } catch {
      return false;
    }
  }

  async ensureRepo(): Promise<boolean> {
    if (!(await this.available())) return false;
    if (await this.isRepo()) return true;
    try {
      await this.git('init');
      await this.git('add', '-A');
      await this.commit('vault: initial commit');
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error(`git init failed: ${this.lastError}`);
      return false;
    }
  }

  /** Commit everything if there are changes. Returns the short hash or null. */
  async commitAll(message: string): Promise<string | null> {
    try {
      await this.git('add', '-A');
      const status = await this.git('status', '--porcelain');
      if (!status) {
        this.lastError = null;
        return null;
      }
      const hash = await this.commit(message);
      this.lastError = null;
      this.lastCommit = { hash, at: new Date().toISOString(), message };
      return hash;
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error(`git auto-commit failed: ${this.lastError}`);
      return null;
    }
  }

  async status(): Promise<{
    available: boolean;
    isRepo: boolean;
    head: { hash: string; date: string; message: string } | null;
    dirtyFiles: number;
    lastError: string | null;
  }> {
    const available = await this.available();
    if (!available)
      return { available, isRepo: false, head: null, dirtyFiles: 0, lastError: this.lastError };
    const isRepo = await this.isRepo();
    let head = null;
    let dirtyFiles = 0;
    if (isRepo) {
      head = (await this.log(1))[0] ?? null;
      try {
        const st = await this.git('status', '--porcelain');
        dirtyFiles = st ? st.split('\n').length : 0;
      } catch (e) {
        this.lastError = (e as Error).message;
      }
    }
    return { available, isRepo, head, dirtyFiles, lastError: this.lastError };
  }

  private async commit(message: string): Promise<string> {
    await this.git(
      '-c',
      'user.name=corpobrain',
      '-c',
      'user.email=corpobrain@localhost',
      'commit',
      '-q',
      '-m',
      message,
      '--no-verify',
      '--no-gpg-sign',
    );
    return await this.git('rev-parse', '--short', 'HEAD');
  }

  async log(limit = 20): Promise<{ hash: string; date: string; message: string }[]> {
    try {
      const out = await this.git('log', `-${limit}`, '--pretty=format:%h%x09%aI%x09%s');
      if (!out) return [];
      return out.split('\n').map((line) => {
        const [hash = '', date = '', ...rest] = line.split('\t');
        return { hash, date, message: rest.join('\t') };
      });
    } catch {
      return [];
    }
  }
}

export function startAutoCommit(git: GitService, intervalMinutes: number): () => void {
  if (intervalMinutes <= 0) return () => {};
  const timer = setInterval(
    () => {
      void git.commitAll(`vault: auto-commit ${new Date().toISOString()}`);
    },
    intervalMinutes * 60 * 1000,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
