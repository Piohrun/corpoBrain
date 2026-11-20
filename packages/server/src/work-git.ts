/**
 * What git itself says about a branch in the work log: is anything
 * uncommitted or unpushed, and which other branches already contain it.
 *
 * Agents only report when they run, so a chat that was abandoned says
 * nothing; the local clone still knows. Everything here is read-only and
 * offline (no fetch: no credentials are handled), and no branch naming is
 * assumed — "merged into" is simply every branch that contains the head.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { WorkGitFacts, WorkItem } from '@corpobrain/core';

const run = promisify(execFile);

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

/** One git call in a clone. Rejects when git exits non-zero. */
export const gitIn: GitRunner = async (cwd, args) => {
  const { stdout } = await run(
    'git',
    // safe.directory: clones on network homes otherwise fail with "dubious
    // ownership"; fsmonitor off: reading a status must not start a helper
    ['-C', cwd, '-c', `safe.directory=${cwd}`, '-c', 'core.fsmonitor=false', ...args],
    {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    },
  );
  return stdout.trim();
};

const unknown = (path: string, reason: string): WorkGitFacts => ({
  path,
  available: false,
  reason,
  local: false,
  checkedOut: false,
  dirty: null,
  upstream: null,
  ahead: null,
  behind: null,
  lastCommit: null,
  mergedInto: [],
  inUat: null,
  inRelease: null,
});

/** `refs/remotes/origin/uat/w47` → `origin/uat/w47`; `refs/heads/main` → `main` */
const shortRef = (ref: string): string =>
  ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
/** is `ref` (short) the branch called `name`, locally or on any remote? */
const isBranch = (ref: string, name: string): boolean => ref === name || ref.endsWith(`/${name}`);

/** The facts for one work item, or why there are none. Never throws. */
export async function workGitFacts(item: WorkItem, git: GitRunner = gitIn): Promise<WorkGitFacts> {
  const { path, clone, branch } = item;
  if (!clone) return unknown(path, 'no local clone recorded');
  if (!branch || branch.startsWith('-')) return unknown(path, 'no branch recorded');
  if (!isAbsolute(clone)) return unknown(path, 'the clone path is not absolute');
  try {
    if (!existsSync(clone) || !statSync(clone).isDirectory())
      return unknown(path, 'the clone is not on this machine');
  } catch {
    return unknown(path, 'the clone is not on this machine');
  }
  const ask = (...args: string[]) => git(clone, args);
  const quiet = (...args: string[]) => ask(...args).catch(() => null);
  try {
    await ask('rev-parse', '--git-dir');
  } catch {
    return unknown(path, 'the clone is not a git repository any more');
  }
  // the branch itself, or what the remote has of it when it was deleted locally
  const local = await quiet('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  const head =
    local ?? (await quiet('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`));
  if (!head) return unknown(path, 'the branch is not in the clone');

  const [log, upstream, current, containing] = await Promise.all([
    quiet('log', '-1', '--format=%h%x09%cI%x09%s', head),
    local
      ? quiet('rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`)
      : Promise.resolve(null),
    quiet('branch', '--show-current'),
    quiet('for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads', 'refs/remotes'),
  ]);

  let ahead: number | null = null;
  let behind: number | null = null;
  if (local && upstream) {
    const counts = await quiet('rev-list', '--left-right', '--count', `${branch}...${upstream}`);
    const m = counts ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
  }
  const checkedOut = current === branch;
  let dirty: number | null = null;
  if (checkedOut) {
    const status = await quiet('status', '--porcelain');
    if (status !== null) dirty = status ? status.split('\n').length : 0;
  }
  const [hash = '', date = '', ...subject] = (log ?? '').split('\t');
  const refs = (containing ?? '')
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
  const onRemote = (name: string) =>
    refs.some((r) => r.startsWith('refs/remotes/') && r.endsWith(`/${name}`));
  const mergedInto = refs
    // the same branch locally and on a remote is one fact: keep the remote's name
    .filter((r) => !r.startsWith('refs/heads/') || !onRemote(r.slice('refs/heads/'.length)))
    .map(shortRef)
    .filter((r) => !r.endsWith('/HEAD') && !isBranch(r, branch))
    .sort();
  const contains = (name: string | null): boolean | null =>
    name ? mergedInto.some((r) => isBranch(r, name)) : null;
  return {
    path,
    available: true,
    local: local !== null,
    checkedOut,
    dirty,
    upstream: local ? upstream : null,
    ahead,
    behind,
    lastCommit: hash ? { hash, date, subject: subject.join('\t') } : null,
    mergedInto,
    inUat: contains(item.uatBranch),
    inRelease: contains(item.releaseBranch),
  };
}

const TTL_MS = 60_000;

/**
 * Facts for many items, a few clones at a time, remembered for a minute: the
 * pages ask whenever something in the vault changes, git should not be run
 * that often.
 */
export class WorkGit {
  private cache = new Map<string, { at: number; facts: Promise<WorkGitFacts> }>();
  constructor(
    private readonly git: GitRunner = gitIn,
    private readonly now: () => number = Date.now,
  ) {}

  facts(item: WorkItem, fresh = false): Promise<WorkGitFacts> {
    // the branch facts are part of the key: naming a UAT branch changes the answer
    const key = [item.path, item.clone, item.branch, item.uatBranch, item.releaseBranch].join('\n');
    const hit = this.cache.get(key);
    if (hit && !fresh && this.now() - hit.at < TTL_MS) return hit.facts;
    const facts = workGitFacts(item, this.git);
    this.cache.set(key, { at: this.now(), facts });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    return facts;
  }

  async all(items: WorkItem[], fresh = false): Promise<WorkGitFacts[]> {
    const out: WorkGitFacts[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < items.length; i = next++)
        out[i] = await this.facts(items[i] as WorkItem, fresh);
    };
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
    return out;
  }
}
