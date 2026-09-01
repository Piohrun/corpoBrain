/** Jira sync engine: fetch → cache → render vault files. SPEC §6. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraProfile, VaultConfig } from '../config.ts';
import { parseFrontmatter } from '../frontmatter.ts';
import { writeFileAtomic } from '../vault.ts';
import type { JiraSprint, RawIssue } from './adapter.ts';
import type { ChangeEvent } from './digest.ts';
import { DigestStore, diffIssue, snapshotOf } from './digest.ts';
import { mergeIssueFile, normalizeIssue } from './render.ts';

/** Structural subset of JiraAdapter so tests can stub it. */
export interface AdapterLike {
  search(
    jql: string,
    extraFields?: string[],
    onPage?: (fetched: number, total: number) => void,
  ): Promise<RawIssue[]>;
  sprints(boardId: number, closedLimit?: number): Promise<JiraSprint[]>;
  sprintIssueKeys(sprintId: number): Promise<string[]>;
  detectSprintField?(): Promise<string | null>;
}

export interface SyncProgress {
  profile: string;
  /** searching → sprints → membership → issues → people → done */
  phase: 'search' | 'sprints' | 'membership' | 'issues' | 'people' | 'done';
  current: number;
  /** 0 = unknown/indeterminate */
  total: number;
  detail?: string;
}

export interface SyncReport {
  profile: string;
  fetched: number;
  created: string[];
  updated: string[];
  unchanged: number;
  skipped: { key: string; reason: string }[];
  peopleCreated: string[];
  sprints: number;
  warnings: string[];
  /** field-level changes since the previous refresh (0 on the very first sync) */
  changes: number;
  /** full pass only: mirrored keys of this profile that the JQL no longer returns */
  gone: string[];
}

interface SyncState {
  watermarks: Record<string, string>;
  /** detected sprint custom field id (per instance), cached across runs */
  sprintField?: string | null;
  /** when each profile last completed a refresh, for the change digest */
  lastSyncAt?: Record<string, string>;
}

export class JiraSync {
  /** optional live progress feed for UIs */
  onProgress: ((p: SyncProgress) => void) | undefined;

  constructor(
    readonly root: string,
    readonly config: VaultConfig,
    readonly adapter: AdapterLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private emit(p: SyncProgress): void {
    this.onProgress?.(p);
  }

  private cacheDir(): string {
    const dir = join(this.root, '.corpobrain', 'jira-cache');
    mkdirSync(join(dir, 'issues'), { recursive: true });
    return dir;
  }

  private loadState(): SyncState {
    try {
      return JSON.parse(readFileSync(join(this.cacheDir(), 'state.json'), 'utf8')) as SyncState;
    } catch {
      return { watermarks: {} };
    }
  }

  private saveState(state: SyncState): void {
    writeFileSync(join(this.cacheDir(), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  async run(profileName?: string, opts: { full?: boolean } = {}): Promise<SyncReport[]> {
    const profiles = this.config.jira.profiles.filter(
      (p) => !profileName || p.name === profileName,
    );
    if (!profiles.length)
      throw new Error(`no jira profile${profileName ? ` named ${profileName}` : 's configured'}`);
    const reports: SyncReport[] = [];
    for (const profile of profiles)
      reports.push(await this.runProfile(profile, opts.full ?? false));
    return reports;
  }

  private async runProfile(profile: JiraProfile, full: boolean): Promise<SyncReport> {
    const syncStart = this.now();
    const state = this.loadState();
    // Incremental window as a *relative* JQL clause: an absolute timestamp is
    // read in the Jira profile's timezone, so a user hours west of UTC would
    // silently miss updates. Minutes since the last completed run, plus an
    // overlap for clock skew.
    const since = full ? null : lastRunOf(state, profile.name);
    const window = since ? minutesSince(since, syncStart) + OVERLAP_MINUTES : null;
    const jql = window !== null ? `(${profile.jql}) AND updated >= -${window}m` : profile.jql;
    if (full) delete state.sprintField; // re-detect on a full pass too
    const extraFields = this.config.jira.estimateField ? [this.config.jira.estimateField] : [];
    // The issue's own sprint field is authoritative (full history, handles
    // issues carried across sprints); board membership is only a fallback.
    if (state.sprintField === undefined && this.adapter.detectSprintField) {
      try {
        state.sprintField = await this.adapter.detectSprintField();
      } catch {
        state.sprintField = null;
      }
    }
    if (state.sprintField) extraFields.push(state.sprintField);
    this.emit({ profile: profile.name, phase: 'search', current: 0, total: 0, detail: jql });
    const issues = await this.adapter.search(jql, extraFields, (fetched, total) =>
      this.emit({
        profile: profile.name,
        phase: 'search',
        current: fetched,
        total,
        ...(total > 0 ? {} : { detail: `${fetched} so far` }),
      }),
    );
    this.emit({
      profile: profile.name,
      phase: 'search',
      current: issues.length,
      total: issues.length,
    });

    // Sprints + membership come from the Agile API (no custom-field guessing).
    const sprintByKey = new Map<string, { id: number; name: string }>();
    const allSprints: JiraSprint[] = [];
    const warnings: string[] = [];
    if (profile.boards.length === 0) {
      warnings.push(
        'no agile board ids configured on this profile — sprints were NOT fetched (add your Scrum board id in Jira settings)',
      );
    }
    let boardIdx = 0;
    for (const boardId of profile.boards) {
      boardIdx++;
      this.emit({
        profile: profile.name,
        phase: 'sprints',
        current: boardIdx,
        total: profile.boards.length,
        detail: `board ${boardId}`,
      });
      let sprints: JiraSprint[];
      try {
        sprints = await this.adapter.sprints(boardId);
      } catch (e) {
        warnings.push(
          `board ${boardId}: ${e instanceof Error ? e.message : String(e)} — is it a Scrum board? (Kanban boards have no sprints)`,
        );
        continue;
      }
      allSprints.push(...sprints);
      const considered = sprints
        .filter((s) => s.state !== 'closed')
        .slice(0, 1 + profile.futureSprints + 5);
      let sprintIdx = 0;
      for (const sprint of considered) {
        sprintIdx++;
        this.emit({
          profile: profile.name,
          phase: 'membership',
          current: sprintIdx,
          total: considered.length,
          detail: sprint.name,
        });
        for (const key of await this.adapter.sprintIssueKeys(sprint.id)) {
          if (sprint.state === 'active' || !sprintByKey.has(key)) {
            sprintByKey.set(key, { id: sprint.id, name: sprint.name });
          }
        }
      }
    }
    if (allSprints.length) {
      // Merge per board: another profile's boards keep their sprints.
      const file = join(this.cacheDir(), 'sprints.json');
      let kept: JiraSprint[] = [];
      try {
        const prev = JSON.parse(readFileSync(file, 'utf8')) as JiraSprint[];
        kept = prev.filter(
          (s) => s.originBoardId !== undefined && !profile.boards.includes(s.originBoardId),
        );
      } catch {
        kept = [];
      }
      const dedup = new Map([...kept, ...allSprints].map((s) => [s.id, s]));
      writeFileSync(file, `${JSON.stringify([...dedup.values()], null, 2)}\n`);
    }

    const report: SyncReport = {
      profile: profile.name,
      fetched: issues.length,
      created: [],
      updated: [],
      unchanged: 0,
      skipped: [],
      peopleCreated: [],
      sprints: allSprints.length,
      warnings,
      changes: 0,
      gone: [],
    };

    const syncedAt = syncStart.toISOString();
    const knownPeople = this.knownPeopleIds();
    const normOpts = {
      baseUrl: this.config.jira.baseUrl,
      ...(this.config.jira.estimateField ? { estimateField: this.config.jira.estimateField } : {}),
    };
    // The cached raw JSON of the previous sync is the digest's "before" state.
    // On a vault whose cache is still empty there is nothing to compare against,
    // so the first pass only establishes the baseline.
    const issuesDir = join(this.cacheDir(), 'issues');
    const baseline = readdirSync(issuesDir).length === 0;
    const digest = new DigestStore(this.cacheDir());
    const events: ChangeEvent[] = [];
    let issueIdx = 0;
    for (const raw of issues) {
      issueIdx++;
      if (issueIdx % 5 === 0 || issueIdx === issues.length) {
        this.emit({
          profile: profile.name,
          phase: 'issues',
          current: issueIdx,
          total: issues.length,
          detail: raw.key,
        });
      }
      const cacheFile = join(issuesDir, `${raw.key}.json`);
      let before: RawIssue | null = null;
      if (!baseline && existsSync(cacheFile)) {
        try {
          before = JSON.parse(readFileSync(cacheFile, 'utf8')) as RawIssue;
        } catch {
          before = null; // unreadable cache: treat as no baseline for this issue
        }
      }
      writeFileSync(cacheFile, `${JSON.stringify(raw, null, 2)}\n`);
      const issue = normalizeIssue(raw, normOpts);
      // field-derived sprint (normalizeIssue) wins; membership fills gaps
      const agile = sprintByKey.get(issue.key);
      if (!issue.sprint && agile) issue.sprint = agile;

      const relPath = `${profile.folder}/${issue.key}.md`;
      const abs = join(this.root, relPath);
      const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : null;

      if (!baseline && !(before === null && existing !== null)) {
        const prev = before ? snapshotOf(normalizeIssue(before, normOpts)) : null;
        if (prev && prev.sprint === null && existing) {
          // A sprint that came from board membership is not in the cached raw
          // issue, but it is in the file we wrote last time — without this the
          // digest would report a phantom move on every refresh.
          const last = parseFrontmatter(existing).data.sprint;
          if (typeof last === 'string') prev.sprint = last;
        }
        events.push(
          ...diffIssue(prev, snapshotOf(issue), {
            at: syncedAt,
            profile: profile.name,
            key: issue.key,
          }),
        );
      }
      const outcome = mergeIssueFile(issue, existing, {
        config: this.config,
        profile: profile.name,
        syncedAt,
      });
      if (outcome.action === 'skip')
        report.skipped.push({ key: issue.key, reason: outcome.reason });
      else if (outcome.action === 'unchanged') report.unchanged++;
      else {
        writeFileAtomic(abs, outcome.content);
        (existing === null ? report.created : report.updated).push(issue.key);
      }

      if (this.config.jira.createPeople && issue.assignee && !knownPeople.has(issue.assignee.id)) {
        const path = this.createPerson(issue.assignee);
        knownPeople.add(issue.assignee.id);
        report.peopleCreated.push(path);
      }
    }

    // A full pass sees the whole JQL result, so anything mirrored for this
    // profile that did not come back has left the query (moved project,
    // closed out of scope, deleted). Never touched — the user's notes below
    // the marker are theirs — but reported so the mirror is not silently stale.
    if (full) {
      const fetched = new Set(issues.map((i) => i.key));
      for (const key of this.mirroredKeys(profile)) {
        if (!fetched.has(key)) report.gone.push(key);
      }
      report.gone.sort();
      if (report.gone.length) {
        warnings.push(
          `${report.gone.length} mirrored issue${report.gone.length === 1 ? '' : 's'} no longer match${
            report.gone.length === 1 ? 'es' : ''
          } the JQL: ${report.gone.slice(0, 10).join(', ')}${report.gone.length > 10 ? ', …' : ''}`,
        );
      }
    }

    digest.append(events);
    report.changes = events.length;
    state.lastSyncAt = { ...state.lastSyncAt, [profile.name]: syncedAt };

    // Watermark: overlap by 5 minutes to survive clock skew; Jira JQL format.
    const wm = new Date(syncStart.getTime() - 5 * 60 * 1000);
    state.watermarks[profile.name] = jqlDate(wm);
    this.saveState(state);
    this.emit({
      profile: profile.name,
      phase: 'done',
      current: issues.length,
      total: issues.length,
    });
    return report;
  }

  /** Keys of the files this profile wrote (by the jira.profile stamp in their frontmatter). */
  private mirroredKeys(profile: JiraProfile): string[] {
    const dir = join(this.root, profile.folder);
    if (!existsSync(dir)) return [];
    const keys: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const fm = parseFrontmatter(readFileSync(join(dir, file), 'utf8')).data;
        const meta = fm.jira as { profile?: unknown } | undefined;
        if (fm.type === 'jira' && typeof fm.key === 'string' && meta?.profile === profile.name)
          keys.push(fm.key);
      } catch {
        /* unreadable: not ours to judge */
      }
    }
    return keys;
  }

  private knownPeopleIds(): Set<string> {
    const ids = new Set<string>();
    const dir = join(this.root, this.config.folders.people);
    if (!existsSync(dir)) return ids;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      try {
        const fm = parseFrontmatter(readFileSync(join(dir, file), 'utf8')).data;
        const v = fm.jira;
        if (typeof v === 'string') ids.add(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') ids.add(x);
      } catch {
        /* unreadable person file: ignore */
      }
    }
    return ids;
  }

  private createPerson(assignee: { id: string; name: string }): string {
    const slug = assignee.name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '');
    const rel = `${this.config.folders.people}/${slug || assignee.id}.md`;
    const abs = join(this.root, rel);
    if (!existsSync(abs)) {
      writeFileAtomic(
        abs,
        `---\ntype: person\ntitle: ${JSON.stringify(assignee.name)}\njira: ${JSON.stringify(assignee.id)}\nactive: true\n---\n\n`,
      );
    }
    return rel;
  }
}

const OVERLAP_MINUTES = 5;

/** When this profile last completed: lastSyncAt (ISO), else the legacy UTC watermark. */
function lastRunOf(state: SyncState, profile: string): Date | null {
  const iso = state.lastSyncAt?.[profile];
  if (iso) {
    const d = new Date(iso);
    if (Number.isFinite(d.getTime())) return d;
  }
  const wm = state.watermarks[profile];
  const m = wm ? /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(wm) : null;
  if (!m) return null;
  const [, y, mo, d, h, mi] = m as unknown as [string, string, string, string, string, string];
  // the legacy watermark already carried the overlap
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi + OVERLAP_MINUTES));
}

function minutesSince(then: Date, now: Date): number {
  return Math.max(0, Math.ceil((now.getTime() - then.getTime()) / 60_000));
}

/** Jira JQL datetime literal: yyyy/MM/dd HH:mm, UTC (kept for the legacy watermark). */
export function jqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
