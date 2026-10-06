/**
 * Teambook org import: preview (fetch → snapshot → plan) as a background job,
 * then apply a reviewed selection with validation, a journal and undo.
 * Nothing touches the vault until apply; see docs/TEAMBOOK.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildOrganization,
  buildTeambookWrites,
  createProxyFetch,
  emptyBaseline,
  fetchTeambookSnapshot,
  nextBaseline,
  normalizeSnapshot,
  type OrgSource,
  orgSourceType,
  parseFrontmatter,
  planTeambookImport,
  readSecret,
  resolveProxyUrl,
  type TeambookBaseline,
  type TeambookChange,
  type TeambookPlan,
  type TeambookSnapshot,
  writeFileAtomic,
} from '@corpobrain/core';
import { gitFor } from './git-service.ts';
import { organizationSources } from './organization-routes.ts';
import { type JobProgress, perVault, SyncJobService } from './sync-jobs.ts';
import { applyTemplate, HttpError, type VaultService } from './vault-service.ts';

export interface TeambookPreviewReport {
  profile: 'teambook';
  source: 'api' | 'fixture';
  pods: number;
  people: number;
  changes: Record<string, number>;
  warnings: string[];
}

export interface StoredPlan {
  id: string;
  createdAt: string;
  source: 'api' | 'fixture';
  snapshotFile: string;
  plan: TeambookPlan;
}

export interface ImportJournal {
  id: string;
  at: string;
  planId: string;
  applied: string[];
  dismissed: string[];
  skipped: { id: string; reason: string }[];
  writes: { path: string; before: string | null; afterHash: string }[];
  baselineBefore: TeambookBaseline;
  undoneAt: string | null;
}

const sha = (text: string) => createHash('sha1').update(text).digest('hex');
const SNAPSHOTS_KEPT = 10;

export const teambookService = perVault((v) => new TeambookService(v));

export class TeambookService extends SyncJobService<
  TeambookPreviewReport,
  JobProgress,
  { source: 'api' | 'fixture'; rootPodId: string }
> {
  readonly dir: string;
  private applying = false;

  constructor(
    private readonly vault: VaultService,
    /** injectable for tests; defaults to the real API client */
    private readonly fetchSnapshot: (
      v: VaultService,
      onProgress: (p: JobProgress) => void,
      signal: AbortSignal,
    ) => Promise<TeambookSnapshot> = fetchFromApi,
  ) {
    const dir = join(vault.root, '.corpobrain', 'teambook-cache');
    super(join(dir, 'preview-history.json'));
    this.dir = dir;
  }

  get fixturePath(): string {
    return join(this.dir, 'fixture.json');
  }

  /** Fetch (or read the fixture), validate, save the snapshot, and plan. */
  preview(source: 'api' | 'fixture') {
    const config = this.vault.config.teambook;
    if (source === 'fixture' && !existsSync(this.fixturePath))
      throw new HttpError(400, `no fixture at .corpobrain/teambook-cache/fixture.json`);
    return this.launch(
      {
        profiles: [config.rootPodId || '(all)'],
        full: true,
        settings: { source, rootPodId: config.rootPodId },
      },
      async (job) => {
        job.addSecrets([readSecret(this.vault.root, 'teambookToken')]);
        const raw =
          source === 'fixture'
            ? (JSON.parse(readFileSync(this.fixturePath, 'utf8')) as TeambookSnapshot)
            : await this.fetchSnapshot(this.vault, job.progress, job.signal);
        job.signal.throwIfAborted();
        const { snapshot, warnings } = normalizeSnapshot(raw);
        const snapshotFile = this.saveSnapshot(snapshot);
        job.progress({ profile: 'teambook', phase: 'plan', current: 0, total: 0 });
        const plan = planTeambookImport(
          snapshot,
          organizationSources(this.vault),
          this.baseline(),
          {
            folders: {
              people: this.vault.config.folders.people,
              organization: this.vault.config.folders.organization,
            },
            existingPaths: new Set(this.vault.list().map((n) => n.path)),
            createUnits: config.createUnits,
            createPeople: config.createPeople,
          },
        );
        plan.warnings.unshift(...warnings);
        const stored: StoredPlan = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          source,
          snapshotFile,
          plan,
        };
        writeFileAtomic(join(this.dir, 'plan.json'), `${JSON.stringify(stored, null, 2)}\n`);
        const changes: Record<string, number> = {};
        for (const c of plan.changes) changes[c.status] = (changes[c.status] ?? 0) + 1;
        const report: TeambookPreviewReport = {
          profile: 'teambook',
          source,
          pods: snapshot.pods.length,
          people: snapshot.users.length,
          changes,
          warnings: plan.warnings.map(job.redact),
        };
        job.report(report);
        return [report];
      },
    );
  }

  currentPlan(): StoredPlan | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'plan.json'), 'utf8')) as StoredPlan;
    } catch {
      return null;
    }
  }

  baseline(): TeambookBaseline {
    try {
      const b = JSON.parse(
        readFileSync(join(this.dir, 'baseline.json'), 'utf8'),
      ) as TeambookBaseline;
      if (b.version === 1) return b;
    } catch {
      /* first import */
    }
    return emptyBaseline();
  }

  /**
   * Apply the selected changes of the current plan. All-or-nothing on
   * validation: if the resulting notes would add any organization problem
   * (cycle, wrong parent level, an ambiguous reference…), nothing is written.
   */
  async apply(planId: string, applyIds: string[], dismissIds: string[]) {
    if (this.applying) throw new HttpError(409, 'an import is already being applied');
    if (this.status.syncing) throw new HttpError(409, 'a preview is still running');
    const stored = this.currentPlan();
    if (!stored || stored.id !== planId)
      throw new HttpError(409, 'this preview is out of date — preview again');
    this.applying = true;
    try {
      const v = this.vault;
      const result = buildTeambookWrites(
        stored.plan,
        applyIds,
        (path) => {
          const abs = join(v.root, path);
          return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        },
        (change) => this.baseContent(change),
      );

      const before = organizationSources(v);
      const after = new Map(before.map((s) => [s.path, s]));
      for (const w of result.writes) {
        const fm = parseFrontmatter(w.after).data;
        const source: OrgSource = {
          path: w.path,
          title: typeof fm.title === 'string' ? fm.title : w.path,
          type: typeof fm.type === 'string' ? fm.type : 'note',
          fm,
        };
        after.set(w.path, { ...source, type: orgSourceType(source, v.config.folders.people) });
      }
      const key = (p: { path: string; field: string; message: string }) =>
        `${p.path}\u0000${p.field}\u0000${p.message}`;
      const existing = new Set(buildOrganization(before).problems.map(key));
      const introduced = buildOrganization([...after.values()]).problems.filter(
        (p) => !existing.has(key(p)),
      );
      if (introduced.length)
        throw new HttpError(
          409,
          `Nothing was written: these changes would break the organization map — ${introduced
            .slice(0, 5)
            .map((p) => `${p.path} ${p.field}: ${p.message}`)
            .join('; ')}. Deselect the changes involved and apply again.`,
        );

      if (result.writes.length && existsSync(join(v.root, '.git')))
        await gitFor(v.root).commitAll('vault: before Teambook import');

      const baselineBefore = this.baseline();
      // Hash what is on disk after the vault wrote and indexed it (the indexer
      // may add an id: to a new note), so undo recognises its own writes.
      const afterHashes = new Map<string, string>();
      for (const w of result.writes) {
        if (w.before === null) v.create(w.path, w.path, w.after);
        else v.write(w.path, w.after);
        afterHashes.set(w.path, sha(readFileSync(join(v.root, w.path), 'utf8')));
      }
      const journal: ImportJournal = {
        id: randomUUID(),
        at: new Date().toISOString(),
        planId,
        applied: result.applied,
        dismissed: dismissIds,
        skipped: result.skipped,
        writes: result.writes.map((w) => ({
          path: w.path,
          before: w.before,
          afterHash: afterHashes.get(w.path) as string,
        })),
        baselineBefore,
        undoneAt: null,
      };
      writeFileAtomic(
        join(this.dir, 'imports', `${journal.id}.json`),
        `${JSON.stringify(journal, null, 2)}\n`,
      );
      const baseline = nextBaseline(baselineBefore, stored.plan, result.applied, dismissIds);
      writeFileAtomic(join(this.dir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
      // the plan described the vault before this import; it is spent
      unlinkSync(join(this.dir, 'plan.json'));
      const paths = result.writes.map((w) => w.path);
      if (paths.length) v.notifyPathsChanged(paths);
      return { id: journal.id, written: paths, applied: result.applied, skipped: result.skipped };
    } finally {
      this.applying = false;
    }
  }

  imports(): (Omit<ImportJournal, 'writes' | 'baselineBefore'> & { files: string[] })[] {
    const dir = join(this.dir, 'imports');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ImportJournal)
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(({ writes, baselineBefore: _b, ...rest }) => ({
        ...rest,
        files: writes.map((w) => w.path),
      }));
  }

  /** Put back what an import changed, except notes edited since. */
  undo(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'invalid import id');
    const file = join(this.dir, 'imports', `${id}.json`);
    if (!existsSync(file)) throw new HttpError(404, 'no such import');
    const journal = JSON.parse(readFileSync(file, 'utf8')) as ImportJournal;
    if (journal.undoneAt) throw new HttpError(409, 'this import was already undone');
    const v = this.vault;
    const restored: string[] = [];
    const kept: { path: string; reason: string }[] = [];
    for (const w of [...journal.writes].reverse()) {
      const abs = join(v.root, w.path);
      const now = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      if (now === null || sha(now) !== w.afterHash) {
        kept.push({
          path: w.path,
          reason: now === null ? 'deleted since' : 'edited since the import',
        });
        continue;
      }
      if (w.before === null)
        v.delete(w.path); // to .trash, recoverable
      else v.write(w.path, w.before);
      restored.push(w.path);
    }
    journal.undoneAt = new Date().toISOString();
    writeFileAtomic(file, `${JSON.stringify(journal, null, 2)}\n`);
    writeFileAtomic(
      join(this.dir, 'baseline.json'),
      `${JSON.stringify(journal.baselineBefore, null, 2)}\n`,
    );
    if (existsSync(join(this.dir, 'plan.json'))) unlinkSync(join(this.dir, 'plan.json'));
    if (restored.length) v.notifyPathsChanged(restored);
    return { restored, kept };
  }

  /** A new note starts from the user's template for its type, if there is one. */
  private baseContent(change: TeambookChange): string {
    const type = change.scope === 'unit' ? 'org_unit' : 'person';
    const tpl = join(this.vault.root, this.vault.config.folders.templates, `${type}.md`);
    if (existsSync(tpl)) {
      const today = new Date().toISOString().slice(0, 10);
      return applyTemplate(readFileSync(tpl, 'utf8'), today).replace(
        /\{\{title\}\}/g,
        change.title,
      );
    }
    return change.scope === 'unit'
      ? `---\n---\n\n# ${change.title}\n\n## Mandate\n\n## Responsibilities\n\n## Working notes\n`
      : `---\n---\n\n# ${change.title}\n`;
  }

  private saveSnapshot(snapshot: TeambookSnapshot): string {
    const dir = join(this.dir, 'snapshots');
    const name = `${snapshot.fetchedAt.replace(/[:.]/g, '-')}.json`;
    writeFileAtomic(join(dir, name), `${JSON.stringify(snapshot, null, 2)}\n`);
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const old of all.slice(0, Math.max(0, all.length - SNAPSHOTS_KEPT)))
      unlinkSync(join(dir, old));
    return `snapshots/${name}`;
  }
}

/** The real fetch: config + token + proxy → client.ts. */
async function fetchFromApi(
  v: VaultService,
  onProgress: (p: JobProgress) => void,
  signal: AbortSignal,
): Promise<TeambookSnapshot> {
  const cfg = v.config.teambook;
  if (!cfg.baseUrl) throw new Error('Set the Teambook URL first.');
  const token = readSecret(v.root, 'teambookToken');
  if (!token)
    throw new Error('No Teambook token: set it in Settings or CORPOBRAIN_TEAMBOOK_TOKEN.');
  const proxy = resolveProxyUrl(cfg.proxyUrl || v.config.jira.proxyUrl);
  const { snapshot } = await fetchTeambookSnapshot(
    {
      baseUrl: cfg.baseUrl,
      token,
      ...(proxy ? { fetch: createProxyFetch(proxy) } : {}),
      timeoutSeconds: cfg.requestTimeoutSeconds,
      concurrency: cfg.concurrency,
      signal,
      onProgress: (p) => onProgress({ profile: 'teambook', ...p }),
    },
    cfg.rootPodId || null,
  );
  return snapshot;
}
