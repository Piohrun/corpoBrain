/** Jira sync engine: fetch → cache → render vault files. SPEC §6. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraProfile, VaultConfig } from '../config.ts';
import { parseFrontmatter } from '../frontmatter.ts';
import { writeFileAtomic } from '../vault.ts';
import type { JiraSprint, RawIssue } from './adapter.ts';
import { mergeIssueFile, normalizeIssue } from './render.ts';

/** Structural subset of JiraAdapter so tests can stub it. */
export interface AdapterLike {
  search(jql: string, extraFields?: string[]): Promise<RawIssue[]>;
  sprints(boardId: number, closedLimit?: number): Promise<JiraSprint[]>;
  sprintIssueKeys(sprintId: number): Promise<string[]>;
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
}

interface SyncState {
  watermarks: Record<string, string>;
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

  async run(profileName?: string): Promise<SyncReport[]> {
    const profiles = this.config.jira.profiles.filter(
      (p) => !profileName || p.name === profileName,
    );
    if (!profiles.length)
      throw new Error(`no jira profile${profileName ? ` named ${profileName}` : 's configured'}`);
    const reports: SyncReport[] = [];
    for (const profile of profiles) reports.push(await this.runProfile(profile));
    return reports;
  }

  private async runProfile(profile: JiraProfile): Promise<SyncReport> {
    const syncStart = this.now();
    const state = this.loadState();
    const watermark = state.watermarks[profile.name];
    const jql = watermark ? `(${profile.jql}) AND updated >= "${watermark}"` : profile.jql;
    const extraFields = this.config.jira.estimateField ? [this.config.jira.estimateField] : [];
    this.emit({ profile: profile.name, phase: 'search', current: 0, total: 0, detail: jql });
    const issues = await this.adapter.search(jql, extraFields);
    this.emit({
      profile: profile.name,
      phase: 'search',
      current: issues.length,
      total: issues.length,
    });

    // Sprints + membership come from the Agile API (no custom-field guessing).
    const sprintByKey = new Map<string, { id: number; name: string }>();
    const allSprints: JiraSprint[] = [];
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
      const sprints = await this.adapter.sprints(boardId);
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
      const dedup = new Map(allSprints.map((s) => [s.id, s]));
      writeFileSync(
        join(this.cacheDir(), 'sprints.json'),
        `${JSON.stringify([...dedup.values()], null, 2)}\n`,
      );
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
    };

    const syncedAt = syncStart.toISOString();
    const knownPeople = this.knownPeopleIds();
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
      writeFileSync(
        join(this.cacheDir(), 'issues', `${raw.key}.json`),
        `${JSON.stringify(raw, null, 2)}\n`,
      );
      const issue = normalizeIssue(raw, {
        baseUrl: this.config.jira.baseUrl,
        ...(this.config.jira.estimateField
          ? { estimateField: this.config.jira.estimateField }
          : {}),
      });
      const agile = sprintByKey.get(issue.key);
      if (agile) issue.sprint = agile;

      const relPath = `${profile.folder}/${issue.key}.md`;
      const abs = join(this.root, relPath);
      const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
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

/** Jira JQL datetime literal: yyyy/MM/dd HH:mm (in the server's zone; UTC is close enough with the overlap). */
export function jqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
