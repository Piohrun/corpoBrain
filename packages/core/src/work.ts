/**
 * Work log (SPEC §6.6): one note per branch that coding agents report their
 * progress into, so the state of every thread of work is in the vault and
 * not in a chat window.
 *
 * Like the Jira and Outlook mirrors the note has two owners: everything above
 * `<!-- work:end -->` is rewritten by the tool on each report (the status and
 * an append-only log), everything below it is the user's and is never touched.
 * The current status also lives in frontmatter, which is what lists and boards
 * read.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, patchFrontmatter, splitFrontmatter } from './frontmatter.ts';
import { writeFileAtomic } from './vault.ts';
import {
  isWorkStage,
  isWorkWaiting,
  WORK_STAGE_LABEL,
  WORK_STAGES,
  WORK_WAITING,
  type WorkItem,
  type WorkPatch,
  type WorkReport,
} from './work-model.ts';

export * from './work-model.ts';

export const WORK_MARKER = '<!-- work:end -->';

export class WorkError extends Error {}

const LIMITS = { summary: 1000, state: 600, next: 400, chat: 80, title: 120, ref: 200 };

/**
 * Agent text is data. Keep it from being read as structure: one line, no
 * marker of ours, no wikilinks into the vault, no HTML comment tricks.
 */
export function neutralizeWork(text: string, max: number): string {
  const one = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/<!--/g, '<\\!--')
    .replace(/\[\[|\]\]/g, (b) => (b === '[[' ? '[​[' : ']​]'));
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** `"[[EXEC-104]]"` → `EXEC-104` */
const unlink = (v: string | null): string | null =>
  v ? v.replace(/^\[\[(.+?)(\|.*)?\]\]$/, '$1') : null;

export function workItemFromFrontmatter(
  path: string,
  title: string,
  fm: Record<string, unknown>,
): WorkItem {
  return {
    path,
    title,
    repo: str(fm.repo) ?? '',
    branch: str(fm.branch) ?? '',
    stage: isWorkStage(fm.stage) ? fm.stage : 'dev',
    waitingOn: isWorkWaiting(fm.waiting_on) ? fm.waiting_on : 'nobody',
    state: str(fm.state),
    next: str(fm.next),
    chat: str(fm.chat),
    updated: str(fm.updated),
    issue: unlink(str(fm.issue)),
    uatBranch: str(fm.uat_branch),
    releaseBranch: str(fm.release_branch),
    pr: str(fm.pr),
    clone: str(fm.clone),
  };
}

/** `work/<repo> <branch>.md`, with what a file name cannot hold replaced. */
export function workNotePath(folder: string, repo: string, branch: string): string {
  const safe = `${repo} ${branch}`
    .replace(/[\\/:*?"<>|#^[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  return `${folder}/${safe || 'work'}.md`;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** local `YYYY-MM-DD HH:mm`, as the log shows it */
export function workStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Parts {
  /** the frontmatter block including its fences ('' when there is none) */
  head: string;
  /** the log lines of the tool-owned region, newest first */
  log: string[];
  /** everything after the marker, starting with its line break */
  user: string;
}

/** Take a work note apart. Without the marker the whole body is the user's. */
function splitWorkNote(content: string): Parts {
  const text = content.replace(/\r\n/g, '\n');
  const split = splitFrontmatter(text);
  const head = text.slice(0, split.bodyOffset);
  const body = text.slice(split.bodyOffset);
  const at = body.indexOf(WORK_MARKER);
  if (at === -1) {
    const kept = body.replace(/^\n+/, '');
    return { head, log: [], user: kept ? `\n\n${kept}` : NEW_USER_REGION };
  }
  const owned = body.slice(0, at);
  const updates = owned.indexOf('\n## Updates');
  const log =
    updates === -1
      ? []
      : owned
          .slice(updates)
          .split('\n')
          .filter((l) => l.startsWith('- '));
  return { head, log, user: body.slice(at + WORK_MARKER.length) };
}

const NEW_USER_REGION = '\n\n## My notes\n\n';

/** The tool-owned region, rendered from the frontmatter and the log. */
function renderOwned(title: string, item: WorkItem, log: string[]): string {
  const when = item.updated ? workStamp(new Date(item.updated)) : '';
  const facts = [
    `**${WORK_STAGE_LABEL[item.stage]}**`,
    item.waitingOn === 'nobody' ? null : `waiting on ${item.waitingOn}`,
    when ? `updated ${when}` : null,
    item.chat ? `chat “${item.chat}”` : null,
  ].filter(Boolean);
  const lines = [`# ${title}`, '', facts.join(' · ')];
  const where = [
    item.repo && item.branch ? `\`${item.repo}\` · \`${item.branch}\`` : null,
    item.uatBranch ? `UAT branch \`${item.uatBranch}\`` : null,
    item.releaseBranch ? `release branch \`${item.releaseBranch}\`` : null,
    item.pr ? `PR ${item.pr}` : null,
  ].filter(Boolean);
  if (where.length) lines.push('', where.join(' · '));
  if (item.state) lines.push('', `**Stopped at:** ${item.state}`);
  if (item.next) lines.push('', `**Next:** ${item.next}`);
  lines.push('', '## Updates', '', ...log, '');
  return lines.join('\n');
}

function assemble(head: string, title: string, log: string[], user: string): string {
  const fm = parseFrontmatter(head).data;
  const item = workItemFromFrontmatter('', title, fm);
  return `${head}${head ? '\n' : ''}${renderOwned(title, item, log)}\n${WORK_MARKER}${user}`;
}

function checkReport(r: WorkReport): void {
  if (!r.repo?.trim()) throw new WorkError('repo is required');
  if (!r.branch?.trim()) throw new WorkError('branch is required');
  if (!r.summary?.trim()) throw new WorkError('summary is required: what was done');
  if (r.stage !== undefined && !isWorkStage(r.stage))
    throw new WorkError(`stage must be one of: ${WORK_STAGES.join(', ')}`);
  if (r.waitingOn !== undefined && !isWorkWaiting(r.waitingOn))
    throw new WorkError(`waiting_on must be one of: ${WORK_WAITING.join(', ')}`);
}

/**
 * The note after a report: status replaced, one line added to the log, the
 * user's region and their own frontmatter keys kept as they are. `existing`
 * is null for the first report on a branch.
 */
export function applyWorkReport(existing: string | null, report: WorkReport, now: Date): string {
  checkReport(report);
  const clean = (v: string | undefined, max: number) =>
    v?.trim() ? neutralizeWork(v, max) : undefined;
  const parts =
    existing === null ? { head: '', log: [], user: NEW_USER_REGION } : splitWorkNote(existing);
  const before = parseFrontmatter(parts.head);
  if (existing !== null && before.error)
    throw new WorkError('the work note has unreadable frontmatter: fix it in the editor first');
  const repo = neutralizeWork(report.repo, LIMITS.ref);
  const branch = neutralizeWork(report.branch, LIMITS.ref);
  const title =
    str(before.data.title) ??
    clean(report.title, LIMITS.title) ??
    neutralizeWork(branch, LIMITS.title);
  const issue = clean(report.issue, LIMITS.ref);
  const patch: Record<string, unknown> = {
    type: 'work',
    title,
    repo,
    branch,
    // each report describes the work as it is now: an old "next" would mislead
    state: clean(report.state, LIMITS.state),
    next: clean(report.next, LIMITS.next),
    chat: clean(report.chat, LIMITS.chat),
    updated: now.toISOString(),
  };
  // these stay as they were unless the report says otherwise
  if (report.stage) patch.stage = report.stage;
  else if (!isWorkStage(before.data.stage)) patch.stage = 'dev';
  if (report.waitingOn) patch.waiting_on = report.waitingOn;
  else if (!isWorkWaiting(before.data.waiting_on)) patch.waiting_on = 'nobody';
  if (issue) patch.issue = JIRA_KEY.test(issue) ? `[[${issue}]]` : issue;
  const facts: [keyof WorkReport, string][] = [
    ['uatBranch', 'uat_branch'],
    ['releaseBranch', 'release_branch'],
    ['pr', 'pr'],
  ];
  for (const [field, key] of facts) {
    const value = clean(report[field] as string | undefined, LIMITS.ref);
    if (value) patch[key] = value;
  }
  // a path is not prose: keep it verbatim (it is only ever handed to git as an argument)
  if (report.clone?.trim()) patch.clone = report.clone.trim();

  const head = patchFrontmatter(parts.head, patch);
  const entry = [
    `- ${workStamp(now)}`,
    patch.chat ? ` · **${patch.chat as string}**` : '',
    ` — ${neutralizeWork(report.summary, LIMITS.summary)}`,
    patch.state ? ` · _Stopped at:_ ${patch.state as string}` : '',
    patch.next ? ` · _Next:_ ${patch.next as string}` : '',
  ].join('');
  return assemble(head, title, [entry, ...parts.log], parts.user);
}

/** The note after an edit from the app: frontmatter and status follow, a stage change is logged. */
export function applyWorkPatch(existing: string, patch: WorkPatch, now: Date): string {
  if (patch.stage !== undefined && !isWorkStage(patch.stage))
    throw new WorkError(`stage must be one of: ${WORK_STAGES.join(', ')}`);
  if (patch.waitingOn !== undefined && !isWorkWaiting(patch.waitingOn))
    throw new WorkError(`waiting_on must be one of: ${WORK_WAITING.join(', ')}`);
  const parts = splitWorkNote(existing);
  const before = parseFrontmatter(parts.head);
  if (before.error) throw new WorkError('the work note has unreadable frontmatter');
  // patchFrontmatter deletes a key whose value is undefined: name only what was sent
  const sent: Record<string, unknown> = { updated: now.toISOString() };
  if (patch.stage) sent.stage = patch.stage;
  if (patch.waitingOn) sent.waiting_on = patch.waitingOn;
  const texts: [string, string | null | undefined, number][] = [
    ['next', patch.next, LIMITS.next],
    ['uat_branch', patch.uatBranch, LIMITS.ref],
    ['release_branch', patch.releaseBranch, LIMITS.ref],
    ['pr', patch.pr, LIMITS.ref],
  ];
  for (const [key, value, max] of texts)
    if (value !== undefined) sent[key] = value?.trim() ? neutralizeWork(value, max) : undefined;
  const head = patchFrontmatter(parts.head, sent);
  const log = [...parts.log];
  if (patch.stage && patch.stage !== before.data.stage)
    log.unshift(`- ${workStamp(now)} · **you** — moved to ${WORK_STAGE_LABEL[patch.stage]}`);
  const title = str(parseFrontmatter(head).data.title) ?? 'Work';
  return assemble(head, title, log, parts.user);
}

/** The tool-owned part and the user's part of a work note, for readers that treat them differently. */
export function workNoteRegions(content: string): { reported: string; mine: string } {
  const text = content.replace(/\r\n/g, '\n');
  const at = text.indexOf(WORK_MARKER);
  if (at === -1) return { reported: '', mine: text };
  return {
    reported: text.slice(0, at).trimEnd(),
    mine: text.slice(at + WORK_MARKER.length).trim(),
  };
}

/**
 * What to paste into a repository's agent instructions (AGENTS.md,
 * .github/copilot-instructions.md, CLAUDE.md…) so its agents keep the work log.
 * `cli` and `vault` are the paths on this machine.
 */
export function workAgentInstructions(cli: string, vault: string): string {
  // the flag keeps Node's notice about its built-in SQLite out of the agent's terminal
  const run = `node --disable-warning=ExperimentalWarning "${cli}" work`;
  const to = `--vault "${vault}"`;
  return `## Progress reports (corpoBrain)

Keep my work log up to date. Whenever you finish a piece of work, are about to
stop, or need me to decide something, run this from the repository folder:

    ${run} report ${to} --summary "<what you did, one or two sentences>" --state "<where the work stands now>" --next "<the next step>" --waiting <me|agent|tester|reviewer|nobody> --chat "<short name of this chat>"

- The repository and branch are taken from the folder you run it in.
- Use \`--waiting me\` whenever you stop because you need my answer, review or action.
- Add \`--issue EXEC-123\` when you know the Jira key.
- When the branch moves on, say so with \`--stage\`: \`in-uat-branch\` once it is merged
  into the UAT branch (\`--uat-branch <name>\`), \`on-uat\` once that is deployed,
  \`pr-open\` once a PR to the release branch exists (\`--release-branch <name> --pr <url>\`),
  \`released\` once it is in a release, \`parked\` if it is set aside.
- Before continuing work on a branch in a new chat, read where it stands:
  \`${run} show ${to}\`
- Keep reports factual and short. Never put secrets, tokens or customer data in one.
`;
}

// ------------------------------------------------------------------ files

/** Every work note in the folder with its frontmatter (no index needed: the CLI runs beside the app). */
export function readWorkNotes(
  vaultRoot: string,
  folder: string,
): { path: string; content: string; item: WorkItem }[] {
  const dir = join(vaultRoot, folder);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
  const out: { path: string; content: string; item: WorkItem }[] = [];
  for (const name of names.sort()) {
    const path = `${folder}/${name}`;
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (fm.error) continue;
    const title = str(fm.data.title) ?? name.replace(/\.md$/i, '');
    out.push({ path, content, item: workItemFromFrontmatter(path, title, fm.data) });
  }
  return out;
}

/** The note for this repo and branch, wherever in the folder the user has renamed it to. */
export function findWorkNote(
  vaultRoot: string,
  folder: string,
  repo: string,
  branch: string,
): { path: string; content: string; item: WorkItem } | null {
  return (
    readWorkNotes(vaultRoot, folder).find(
      (n) => n.item.repo === repo && n.item.branch === branch,
    ) ?? null
  );
}

/** File a report: update the branch's note, or start one. */
export function reportWork(
  vaultRoot: string,
  folder: string,
  report: WorkReport,
  now = new Date(),
): { path: string; created: boolean; content: string } {
  checkReport(report);
  const repo = neutralizeWork(report.repo, LIMITS.ref);
  const branch = neutralizeWork(report.branch, LIMITS.ref);
  const found = findWorkNote(vaultRoot, folder, repo, branch);
  let path = found?.path ?? workNotePath(folder, repo, branch);
  // a different note already sits at the default name (a renamed one, or a clash after sanitising)
  for (let n = 2; !found && existsSync(join(vaultRoot, path)); n++)
    path = workNotePath(folder, repo, `${branch} ${n}`);
  const content = applyWorkReport(found?.content ?? null, report, now);
  mkdirSync(join(vaultRoot, folder), { recursive: true });
  writeFileAtomic(join(vaultRoot, path), content);
  return { path, created: !found, content };
}
