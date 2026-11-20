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

/** how long a status is trusted while the vault is still: commits made outside the app show up after this */
const STATUS_TTL_MS = 10 * 60_000;

export class GitService {
  lastError: string | null = null;
  lastCommit: { hash: string; at: string; message: string } | null = null;
  /** once the vault is a repository it stays one: no need to ask git again on every poll */
  private knownRepo = false;
  /** commits made through this service: each one changes HEAD and the dirty count */
  private commits = 0;
  /** what status() last found, and the vault write counter it was found at */
  private lastStatus: {
    seq: number;
    commits: number;
    at: number;
    head: { hash: string; date: string; message: string } | null;
    dirtyFiles: number;
  } | null = null;

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

  private availableOnce: Promise<boolean> | null = null;

  /** Is a git binary on PATH? Probed once per process — it does not change underneath us. */
  available(): Promise<boolean> {
    this.availableOnce ??= run('git', ['--version'], { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
    return this.availableOnce;
  }

  /** True only when the vault itself is the repository root — a vault nested
   *  inside some parent repo must get its own repo, not commit upwards. */
  async isRepo(): Promise<boolean> {
    try {
      const toplevel = await this.git('rev-parse', '--show-toplevel');
      const { realpathSync } = await import('node:fs');
      return realpathSync(toplevel) === realpathSync(this.root);
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

  /**
   * Repo state for the status bar, which asks every minute. `changeSeq` is the
   * vault's write counter: while it has not moved (and nothing was committed
   * here) the last answer still holds and git is not run at all — otherwise
   * every open tab costs three git processes a minute, one of them a scan of
   * the whole worktree, on a machine that may be doing nothing else.
   */
  async status(changeSeq?: number): Promise<{
    available: boolean;
    isRepo: boolean;
    head: { hash: string; date: string; message: string } | null;
    dirtyFiles: number;
    lastError: string | null;
  }> {
    const available = await this.available();
    if (!available)
      return { available, isRepo: false, head: null, dirtyFiles: 0, lastError: this.lastError };
    const isRepo = this.knownRepo || (await this.isRepo());
    this.knownRepo = isRepo;
    let head = null;
    let dirtyFiles = 0;
    if (isRepo) {
      const last = this.lastStatus;
      if (
        last &&
        changeSeq !== undefined &&
        last.seq === changeSeq &&
        last.commits === this.commits &&
        Date.now() - last.at < STATUS_TTL_MS
      )
        return {
          available,
          isRepo,
          head: last.head,
          dirtyFiles: last.dirtyFiles,
          lastError: this.lastError,
        };
      const commits = this.commits;
      head = (await this.log(1))[0] ?? null;
      try {
        const st = await this.git('status', '--porcelain');
        dirtyFiles = st ? st.split('\n').length : 0;
        if (changeSeq !== undefined)
          this.lastStatus = { seq: changeSeq, commits, at: Date.now(), head, dirtyFiles };
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
    this.commits++;
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

/**
 * One auto-commit tick. `changeSeq` is the vault's write counter: when it has
 * not moved since the last tick there is nothing to commit and git is not
 * run at all — `git add -A` over a few thousand files every ten minutes is
 * exactly the kind of idle CPU (and antivirus scan) a laptop on a call
 * should not pay for. Returns whether git was invoked.
 */
export function autoCommitTick(
  git: GitService,
  state: { lastSeq: number | null },
  changeSeq: () => number,
): Promise<string | null> | null {
  const seq = changeSeq();
  if (state.lastSeq === seq) return null;
  state.lastSeq = seq;
  return git.commitAll(`vault: auto-commit ${new Date().toISOString()}`);
}

export function startAutoCommit(
  git: GitService,
  intervalMinutes: number,
  changeSeq: () => number,
): () => void {
  if (intervalMinutes <= 0) return () => {};
  // first tick always looks: whatever was dirty before this process started
  const state = { lastSeq: null as number | null };
  const timer = setInterval(
    () => {
      void autoCommitTick(git, state, changeSeq);
    },
    intervalMinutes * 60 * 1000,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
