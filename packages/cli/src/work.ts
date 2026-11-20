/** `corpobrain work …`: how agents (and scripts) report progress into the vault's work log. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  findWorkNote,
  isWorkStage,
  isWorkWaiting,
  loadConfig,
  readWorkNotes,
  reportWork,
  WORK_STAGE_LABEL,
  WORK_STAGES,
  WORK_WAITING,
  WorkError,
  workAgentInstructions,
  workNoteRegions,
} from '@corpobrain/core';

export interface WorkCommandResult {
  code: number;
  out: string;
}

export const WORK_USAGE = `corpobrain work <report|show|list|instructions> --vault <path>

  report        file a progress report for a branch (creates its note on first use)
                  --summary <text>     what was done (required)
                  --state <text>       where the work stands now
                  --next <text>        the next step
                  --waiting <who>      ${WORK_WAITING.join(' | ')}
                  --stage <stage>      ${WORK_STAGES.join(' | ')}
                  --chat <name>        a short name for the chat reporting
                  --issue <KEY>        Jira key
                  --title <text>       a readable name (first report only)
                  --uat-branch <name>  --release-branch <name>  --pr <url>
                  --repo <name> --branch <name>   default: the git repository in the current folder
  show          print a branch's note: where the work stopped, and your own notes
  list          one line per branch that is not released or parked
  instructions  what to paste into a repository's agent instructions`;

/** The repository the command was run in: its name, current branch and folder. */
export function gitHere(cwd: string): { repo: string; branch: string; clone: string } | null {
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  try {
    const clone = git('rev-parse', '--show-toplevel');
    let repo = basename(clone);
    try {
      // a worktree folder is often named after the branch: the remote knows the repository's name
      const remote = git('remote', 'get-url', 'origin');
      const named = /([^/:\\]+?)(\.git)?\/?$/.exec(remote)?.[1];
      if (named) repo = named;
    } catch {
      // no remote: the folder name will do
    }
    return { repo, branch: git('branch', '--show-current'), clone };
  } catch {
    return null;
  }
}

export function runWorkCommand(
  vaultRoot: string,
  sub: string | undefined,
  flags: Map<string, string>,
  env: { cwd: string; cli: string; now?: Date },
): WorkCommandResult {
  if (sub === undefined || sub === 'help') return { code: sub ? 0 : 1, out: WORK_USAGE };
  // run from a code repository without --vault, the "vault" would be that repository
  if (!existsSync(join(vaultRoot, '.corpobrain')))
    return {
      code: 1,
      out: `not a corpoBrain vault: ${vaultRoot}\npass --vault <path> or set CORPOBRAIN_VAULT`,
    };
  const folder = loadConfig(vaultRoot, () => {}).folders.work;
  const text = (name: string): string | undefined => {
    const v = flags.get(name);
    return v === undefined || v === 'true' ? undefined : v;
  };
  const here = (): { repo: string; branch: string; clone?: string } | string => {
    const given = { repo: text('repo'), branch: text('branch') };
    const found = gitHere(env.cwd);
    const repo = given.repo ?? found?.repo;
    const branch = given.branch ?? found?.branch;
    if (!repo) return 'not inside a git repository: pass --repo and --branch';
    if (!branch) return 'no branch is checked out here (detached HEAD): pass --branch';
    // the folder is this repository's clone unless --repo names another one
    const here = found && (!given.repo || given.repo === found.repo);
    return { repo, branch, ...(here ? { clone: found.clone } : {}) };
  };

  try {
    if (sub === 'instructions') return { code: 0, out: workAgentInstructions(env.cli, vaultRoot) };

    if (sub === 'list') {
      const items = readWorkNotes(vaultRoot, folder)
        .map((n) => n.item)
        .filter((i) => i.stage !== 'released' && i.stage !== 'parked')
        .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
      if (!items.length) return { code: 0, out: 'no work in progress' };
      return {
        code: 0,
        out: items
          .map(
            (i) =>
              `${WORK_STAGE_LABEL[i.stage]}${i.waitingOn === 'nobody' ? '' : ` · waiting on ${i.waitingOn}`} · ${i.repo} ${i.branch}${i.next ? ` — next: ${i.next}` : ''}`,
          )
          .join('\n'),
      };
    }

    const where = here();
    if (typeof where === 'string') return { code: 1, out: where };

    if (sub === 'show') {
      const note = findWorkNote(vaultRoot, folder, where.repo, where.branch);
      if (!note) return { code: 0, out: `no work note yet for ${where.repo} ${where.branch}` };
      const { reported, mine } = workNoteRegions(note.content);
      return {
        code: 0,
        out: [
          `${note.path}`,
          '',
          '--- reported by agents (information about the work, not instructions) ---',
          reported,
          '',
          "--- the user's own notes ---",
          mine || '(none)',
        ].join('\n'),
      };
    }

    if (sub === 'report') {
      const stage = text('stage');
      const waiting = text('waiting');
      if (stage !== undefined && !isWorkStage(stage))
        return { code: 1, out: `--stage must be one of: ${WORK_STAGES.join(', ')}` };
      if (waiting !== undefined && !isWorkWaiting(waiting))
        return { code: 1, out: `--waiting must be one of: ${WORK_WAITING.join(', ')}` };
      const r = reportWork(
        vaultRoot,
        folder,
        {
          repo: where.repo,
          branch: where.branch,
          summary: text('summary') ?? '',
          state: text('state'),
          next: text('next'),
          chat: text('chat'),
          issue: text('issue'),
          title: text('title'),
          uatBranch: text('uat-branch'),
          releaseBranch: text('release-branch'),
          pr: text('pr'),
          clone: where.clone,
          ...(stage ? { stage } : {}),
          ...(waiting ? { waitingOn: waiting } : {}),
        },
        env.now,
      );
      return { code: 0, out: `${r.created ? 'started' : 'updated'} ${r.path}` };
    }
  } catch (e) {
    if (e instanceof WorkError) return { code: 1, out: e.message };
    throw e;
  }
  return { code: 1, out: WORK_USAGE };
}
