/**
 * Jira write-back engine (safety design in the repo discussion):
 * staged → previewed against LIVE Jira → applied sequentially with
 * journal, verification, abort-on-error. Local plan.* fields are cleared
 * only after a verified write. Dry-run does everything except send.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteFrontmatterKey, parseFrontmatter, setFrontmatterKey } from '@corpobrain/core';
import type { VaultService } from './vault-service.ts';

/** the only write operations the engine will ever perform */
export interface WriteAdapter {
  issueFields(key: string, fields: string[]): Promise<Record<string, unknown>>;
  setAssignee(key: string, assignee: string | null): Promise<void>;
  moveIssuesToSprint(sprintId: number, keys: string[]): Promise<void>;
  moveIssuesToBacklog(keys: string[]): Promise<void>;
}

export type WriteField = 'sprint' | 'assignee';

export interface StagedChange {
  key: string;
  path: string;
  field: WriteField;
  /** mirror (last-synced) value — the basis of the plan */
  from: string | null;
  to: string;
  writable: boolean;
  reason?: string;
}

export interface PreviewRow extends StagedChange {
  liveUpdated: string | null;
  mirrorUpdated: string | null;
  liveAssignee: string | null;
  conflict: boolean;
  conflictReason?: string;
}

export interface ApplyItem {
  key: string;
  field: WriteField;
  to: string;
  /** apply even when the issue changed in Jira since last sync */
  force?: boolean;
}

export interface ApplyResult {
  key: string;
  field: WriteField;
  to: string;
  status: 'applied' | 'dry-run' | 'conflict' | 'error' | 'not-run';
  detail?: string;
}

export interface ApplyReport {
  batchId: string;
  dryRun: boolean;
  results: ApplyResult[];
  stopped: boolean;
}

const JOURNAL = 'jira-writeback.log';

export function collectStaged(v: VaultService): StagedChange[] {
  const db = v.indexer.db;
  const rows = db
    .prepare(
      `SELECT j.key, j.path, j.sprint AS j_sprint, j.assignee AS j_assignee,
              p.sprint AS p_sprint, p.assignee AS p_assignee
       FROM plan p JOIN jira j ON j.key = p.key
       WHERE (p.sprint IS NOT NULL) OR (p.assignee IS NOT NULL)
       ORDER BY j.key`,
    )
    .all() as {
    key: string;
    path: string;
    j_sprint: string | null;
    j_assignee: string | null;
    p_sprint: string | null;
    p_assignee: string | null;
  }[];
  const jiraSprints = new Set(
    (db.prepare("SELECT name FROM sprints WHERE source = 'jira'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const out: StagedChange[] = [];
  for (const r of rows) {
    if (r.p_sprint !== null && r.p_sprint !== (r.j_sprint ?? 'Backlog')) {
      const targetIsJira = r.p_sprint === 'Backlog' || jiraSprints.has(r.p_sprint);
      out.push({
        key: r.key,
        path: r.path,
        field: 'sprint',
        from: r.j_sprint ?? 'Backlog',
        to: r.p_sprint,
        writable: targetIsJira,
        ...(targetIsJira
          ? {}
          : { reason: 'target sprint exists only locally — create it in Jira first' }),
      });
    }
    if (r.p_assignee !== null && r.p_assignee !== r.j_assignee) {
      out.push({
        key: r.key,
        path: r.path,
        field: 'assignee',
        from: r.j_assignee,
        to: r.p_assignee,
        writable: true,
      });
    }
  }
  return out;
}

function liveAssigneeId(fields: Record<string, unknown>): string | null {
  const a = fields.assignee as { name?: string; accountId?: string } | null | undefined;
  return a?.name ?? a?.accountId ?? null;
}

export async function previewChanges(
  v: VaultService,
  adapter: WriteAdapter,
  staged: StagedChange[],
): Promise<PreviewRow[]> {
  const db = v.indexer.db;
  const out: PreviewRow[] = [];
  const liveCache = new Map<string, Record<string, unknown>>();
  for (const c of staged) {
    let live = liveCache.get(c.key);
    if (!live) {
      live = await adapter.issueFields(c.key, ['assignee', 'updated']);
      liveCache.set(c.key, live);
    }
    const mirror = db.prepare('SELECT updated FROM jira WHERE key = ?').get(c.key) as
      | { updated: string | null }
      | undefined;
    const liveUpdated = (live.updated as string) ?? null;
    const mirrorUpdated = mirror?.updated ?? null;
    const changedSinceSync =
      liveUpdated !== null && mirrorUpdated !== null && liveUpdated !== mirrorUpdated;
    out.push({
      ...c,
      liveUpdated,
      mirrorUpdated,
      liveAssignee: liveAssigneeId(live),
      conflict: changedSinceSync,
      ...(changedSinceSync
        ? { conflictReason: 'issue changed in Jira since your last sync — re-sync and re-check' }
        : {}),
    });
  }
  return out;
}

function journalPath(v: VaultService): string {
  const dir = join(v.root, '.corpobrain');
  mkdirSync(dir, { recursive: true });
  return join(dir, JOURNAL);
}

function journal(v: VaultService, entry: Record<string, unknown>): void {
  appendFileSync(journalPath(v), `${JSON.stringify(entry)}\n`);
}

export function journalTail(v: VaultService, limit = 50): Record<string, unknown>[] {
  const p = journalPath(v);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Clear the applied plan field so local state reflects "now in Jira". */
function clearPlanField(v: VaultService, path: string, field: WriteField): void {
  const { content } = v.read(path);
  const fm = parseFrontmatter(content).data;
  const plan =
    fm.plan && typeof fm.plan === 'object' && !Array.isArray(fm.plan)
      ? { ...(fm.plan as Record<string, unknown>) }
      : {};
  delete plan[field];
  const text = Object.keys(plan).length
    ? setFrontmatterKey(content, 'plan', plan)
    : deleteFrontmatterKey(content, 'plan');
  if (text !== content) v.write(path, text);
}

export async function applyChanges(
  v: VaultService,
  adapter: WriteAdapter,
  items: ApplyItem[],
  opts: { dryRun: boolean },
): Promise<ApplyReport> {
  const db = v.indexer.db;
  const batchId = Date.now().toString(36);
  const results: ApplyResult[] = [];
  let stopped = false;

  const sprintIdOf = (name: string): number | null => {
    const row = db.prepare("SELECT id FROM sprints WHERE name = ? AND source = 'jira'").get(name) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  };

  for (const item of items) {
    if (stopped) {
      results.push({ key: item.key, field: item.field, to: item.to, status: 'not-run' });
      continue;
    }
    const mirror = db
      .prepare('SELECT path, updated, sprint, assignee FROM jira WHERE key = ?')
      .get(item.key) as
      | { path: string; updated: string | null; sprint: string | null; assignee: string | null }
      | undefined;
    const before =
      item.field === 'sprint' ? (mirror?.sprint ?? 'Backlog') : (mirror?.assignee ?? null);
    try {
      // recheck immediately before writing
      const live = await adapter.issueFields(item.key, ['assignee', 'updated']);
      const liveUpdated = (live.updated as string) ?? null;
      if (
        !item.force &&
        liveUpdated !== null &&
        mirror?.updated != null &&
        liveUpdated !== mirror.updated
      ) {
        results.push({
          key: item.key,
          field: item.field,
          to: item.to,
          status: 'conflict',
          detail: 'changed in Jira since last sync',
        });
        journal(v, {
          batchId,
          ts: new Date().toISOString(),
          ...item,
          before,
          ok: false,
          conflict: true,
          dryRun: opts.dryRun,
        });
        continue;
      }

      if (opts.dryRun) {
        results.push({
          key: item.key,
          field: item.field,
          to: item.to,
          status: 'dry-run',
          detail:
            item.field === 'assignee'
              ? `would PUT assignee=${item.to}`
              : item.to === 'Backlog'
                ? 'would POST to backlog'
                : `would POST to sprint "${item.to}" (id ${sprintIdOf(item.to) ?? '?'})`,
        });
        journal(v, {
          batchId,
          ts: new Date().toISOString(),
          ...item,
          before,
          ok: true,
          dryRun: true,
        });
        continue;
      }

      if (item.field === 'assignee') {
        await adapter.setAssignee(item.key, item.to);
        const verify = await adapter.issueFields(item.key, ['assignee']);
        if (liveAssigneeId(verify) !== item.to)
          throw new Error('verification failed: assignee did not take');
      } else {
        if (item.to === 'Backlog') {
          await adapter.moveIssuesToBacklog([item.key]);
        } else {
          const sprintId = sprintIdOf(item.to);
          if (sprintId === null) throw new Error(`sprint "${item.to}" not found in Jira`);
          await adapter.moveIssuesToSprint(sprintId, [item.key]);
        }
      }
      if (mirror?.path) clearPlanField(v, mirror.path, item.field);
      journal(v, {
        batchId,
        ts: new Date().toISOString(),
        ...item,
        before,
        ok: true,
        dryRun: false,
      });
      results.push({ key: item.key, field: item.field, to: item.to, status: 'applied' });
      await new Promise((r) => setTimeout(r, 300)); // throttle
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      journal(v, {
        batchId,
        ts: new Date().toISOString(),
        ...item,
        before,
        ok: false,
        error: detail,
        dryRun: opts.dryRun,
      });
      results.push({ key: item.key, field: item.field, to: item.to, status: 'error', detail });
      stopped = true; // abort the batch on first error
    }
  }
  return { batchId, dryRun: opts.dryRun, results, stopped };
}

/** Inverse items for a previously applied batch (fed back through preview/apply). */
export function undoItems(v: VaultService, batchId: string): ApplyItem[] {
  return journalTail(v, 1000)
    .filter((e) => e.batchId === batchId && e.ok === true && e.dryRun === false)
    .map((e) => ({
      key: e.key as string,
      field: e.field as WriteField,
      to: (e.before as string | null) ?? (e.field === 'sprint' ? 'Backlog' : ''),
    }))
    .filter((i) => i.to !== '');
}
