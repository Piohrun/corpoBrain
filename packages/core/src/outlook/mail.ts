/**
 * Flagged Outlook mail → tasks (SPEC §6.5). New flags are appended to one
 * note as task lines carrying a `^ol-…` block id; after that the line is the
 * user's to edit, move or delete. The sync only ever adds new lines and ticks
 * lines whose flag was completed or cleared in Outlook. A task the user
 * deleted is never re-added: what has been seen lives in mail-state.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VaultConfig } from '../config.ts';
import { writeFileAtomic } from '../vault.ts';
import type { OutlookPerson, PersonResolver } from './meetings.ts';

export interface OutlookMail {
  /** Internet message id (stable across folder moves), else the EntryID */
  id: string;
  subject: string;
  from: OutlookPerson;
  /** local time, YYYY-MM-DDTHH:MM:SS */
  received: string;
  due: string | null;
  completed: boolean;
  flag: string | null;
  importance: 'low' | 'normal' | 'high';
  categories: string[];
  preview: string;
}

export interface MailExport {
  /** first day exported; flags on older mail are left alone */
  since: string;
  mails: OutlookMail[];
  /** the exporter walked every flagged item, so a missing one really was unflagged */
  complete: boolean;
}

export interface MailTasksReport {
  profile: 'mail';
  fetched: number;
  /** subjects of the tasks added this run */
  added: string[];
  ticked: number;
  unchanged: number;
  skipped: { id: string; reason: string }[];
  /** notes written, for re-indexing */
  touched: string[];
  warnings: string[];
}

interface MailState {
  version: 1;
  tasks: Record<string, { received: string; done: boolean }>;
}

export type MailPlan =
  | { action: 'add'; key: string }
  | { action: 'tick'; key: string }
  | { action: 'keep'; key: string; reason: string };

const statePath = (root: string) => join(root, '.corpobrain', 'outlook-cache', 'mail-state.json');

export function readMailState(root: string): MailState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root), 'utf8')) as MailState;
    if (parsed?.version === 1 && parsed.tasks && typeof parsed.tasks === 'object') return parsed;
  } catch {
    /* first run */
  }
  return { version: 1, tasks: {} };
}

/** The block id that ties a task line to its email. */
export function mailTaskKey(id: string): string {
  return `ol-${createHash('sha1').update(id).digest('hex').slice(0, 10)}`;
}

export function planMail(m: OutlookMail, state: MailState): MailPlan {
  const key = mailTaskKey(m.id);
  const seen = state.tasks[key];
  if (!seen)
    return m.completed
      ? { action: 'keep', key, reason: 'already completed' }
      : { action: 'add', key };
  if (m.completed && !seen.done) return { action: 'tick', key };
  return { action: 'keep', key, reason: seen.done ? 'done' : 'already a task' };
}

const clean = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\[\[|\]\]/g, (b) => (b === '[[' ? '[​[' : ']​]'))
    .replace(/📅|@due\(/g, '')
    .replace(/\s\^[A-Za-z0-9-]+\s*$/, '')
    .trim();

export function renderMailTask(m: OutlookMail, key: string, resolve: PersonResolver): string {
  const match = m.from.email ? resolve(m.from.email) : { status: 'unknown' as const };
  const name = clean(m.from.name || m.from.email || 'unknown sender').replace(/\|/g, '/');
  const sender =
    match.status === 'matched' ? `[[${match.path.replace(/\.md$/, '')}|${name}]]` : name;
  const due = m.due ? ` 📅 ${m.due}` : '';
  const urgent = m.importance === 'high' ? '❗ ' : '';
  return `- [ ] ${urgent}${clean(m.subject) || '(no subject)'} — from ${sender}, ${m.received.slice(0, 10)}${due} ^${key}`;
}

const NOTE_HEADER = (title: string) =>
  `---\ntitle: ${title}\n---\n# ${title}\n\nFlagged emails from Outlook arrive here as tasks. Edit, move or delete them freely: the sync only adds new flags and ticks the ones you complete or unflag in Outlook.\n\n`;

/** Tick the open task carrying `^key` in `text`, or null when there is none. */
export function tickTask(text: string, key: string): string | null {
  const re = new RegExp(`^(\\s*[-*+]\\s+j?)\\[ \\](.*\\s\\^${key}[ \\t]*\\r?)$`, 'm');
  return re.test(text) ? text.replace(re, '$1[x]$2') : null;
}

export function applyMailTasks(
  root: string,
  config: VaultConfig,
  data: MailExport,
  opts: {
    resolve: PersonResolver;
    /** where a task line lives now (the user may have moved it), by block id */
    locate: (key: string) => string | null;
  },
): MailTasksReport {
  const note = config.outlook.mail.note;
  const report: MailTasksReport = {
    profile: 'mail',
    fetched: data.mails.length,
    added: [],
    ticked: 0,
    unchanged: 0,
    skipped: [],
    touched: [],
    warnings: [],
  };
  const state = readMailState(root);
  const files = new Map<string, string>();
  const read = (path: string): string | null => {
    if (files.has(path)) return files.get(path) as string;
    const abs = join(root, path);
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, 'utf8');
    files.set(path, text);
    return text;
  };
  const tick = (key: string) => {
    const path = opts.locate(key) ?? note;
    const text = read(path);
    const next = text === null ? null : tickTask(text, key);
    if (next !== null) {
      files.set(path, next);
      report.ticked++;
    }
    // no open line: the user ticked or deleted it already, which is fine
  };

  const seen = new Set<string>();
  const additions: string[] = [];
  const sorted = [...data.mails].sort((a, b) => a.received.localeCompare(b.received));
  for (const m of sorted) {
    const plan = planMail(m, state);
    seen.add(plan.key);
    const received = m.received.slice(0, 10);
    if (plan.action === 'add') {
      additions.push(renderMailTask(m, plan.key, opts.resolve));
      report.added.push(m.subject);
      state.tasks[plan.key] = { received, done: false };
    } else if (plan.action === 'tick') {
      tick(plan.key);
      (state.tasks[plan.key] as { done: boolean }).done = true;
    } else {
      if (plan.reason === 'already completed') state.tasks[plan.key] = { received, done: true };
      report.unchanged++;
    }
  }
  // Unflagged in Outlook (or deleted): the task is done. Only trust a complete
  // export, and only within the window, since older mail was never looked at.
  if (data.complete) {
    for (const [key, entry] of Object.entries(state.tasks)) {
      if (entry.done || seen.has(key) || entry.received < data.since) continue;
      tick(key);
      entry.done = true;
    }
  }

  if (additions.length) {
    const existing = read(note);
    const title = note.replace(/^.*\//, '').replace(/\.md$/, '');
    const base = existing ?? NOTE_HEADER(title);
    const sep = base === '' || base.endsWith('\n') ? '' : '\n';
    files.set(note, `${base}${sep}${additions.join('\n')}\n`);
  }
  for (const [path, text] of files) {
    const abs = join(root, path);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (before === text) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileAtomic(abs, text);
    report.touched.push(path);
  }
  mkdirSync(dirname(statePath(root)), { recursive: true });
  writeFileAtomic(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
  return report;
}
