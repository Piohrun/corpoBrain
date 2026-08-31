/**
 * Render a Jira issue to its vault file per docs/SPEC.md §6.1–6.2.
 * The generated region ends at the marker; everything after it (and the
 * `plan:` frontmatter object plus `id:`) is user-owned and carried over.
 */
import { stringify as stringifyYaml } from 'yaml';
import type { VaultConfig } from '../config.ts';
import { parseFrontmatter } from '../frontmatter.ts';
import { JIRA_MARKER } from '../indexer.ts';
import { jiraTextToMarkdown } from './convert.ts';

export const RENDER_VERSION = 1;

/** Normalised issue: adapter output → renderer input. */
export interface NormalizedIssue {
  key: string;
  summary: string;
  description: unknown;
  status: string | null;
  statusCategory: 'new' | 'indeterminate' | 'done' | null;
  issueType: string | null;
  priority: string | null;
  assignee: { id: string; name: string } | null;
  reporter: { id: string; name: string } | null;
  sprint: { id: number; name: string } | null;
  sprints: string[];
  epic: string | null;
  parent: string | null;
  labels: string[];
  components: string[];
  fixVersions: string[];
  estimate: number | null;
  created: string | null;
  updated: string | null;
  resolved: string | null;
  url: string;
  links: { type: string; dir: 'inward' | 'outward'; key: string }[];
  comments: { author: string; created: string; body: unknown }[];
}

export function normalizeIssue(
  raw: { key: string; fields: Record<string, unknown> },
  opts: { baseUrl: string; estimateField?: string; epicLinkField?: string },
): NormalizedIssue {
  const f = raw.fields;
  const person = (v: unknown): { id: string; name: string } | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const id = (o.name ?? o.accountId ?? o.key) as string | undefined;
    return id ? { id, name: (o.displayName as string) ?? id } : null;
  };
  const status = f.status as { name?: string; statusCategory?: { key?: string } } | undefined;
  const catKey = status?.statusCategory?.key;
  const sprints = extractSprints(f);
  // An issue placed in several sprints maps to its LATEST placement: the
  // highest-id non-closed sprint (ids grow monotonically), else the highest
  // overall (a fully-closed history maps to its last sprint).
  const latest = (list: typeof sprints) =>
    list.length ? list.reduce((a, b) => (b.id > a.id ? b : a)) : undefined;
  const nonClosed = sprints.filter((s) => s.state !== 'closed');
  const active = latest(nonClosed) ?? latest(sprints);
  const links: NormalizedIssue['links'] = [];
  for (const l of (f.issuelinks as Record<string, unknown>[] | undefined) ?? []) {
    const type = l.type as { inward?: string; outward?: string } | undefined;
    const inw = l.inwardIssue as { key?: string } | undefined;
    const outw = l.outwardIssue as { key?: string } | undefined;
    if (inw?.key) links.push({ type: type?.inward ?? 'relates to', dir: 'inward', key: inw.key });
    if (outw?.key)
      links.push({ type: type?.outward ?? 'relates to', dir: 'outward', key: outw.key });
  }
  const estimateRaw = opts.estimateField ? f[opts.estimateField] : undefined;
  const comments = (
    (f.comment as { comments?: Record<string, unknown>[] } | undefined)?.comments ?? []
  ).map((c) => ({
    author: ((c.author as Record<string, unknown> | undefined)?.displayName as string) ?? 'unknown',
    created: (c.created as string) ?? '',
    body: c.body,
  }));
  return {
    key: raw.key,
    summary: (f.summary as string) ?? '',
    description: f.description,
    status: status?.name ?? null,
    statusCategory:
      catKey === 'new' || catKey === 'indeterminate' || catKey === 'done' ? catKey : null,
    issueType: (f.issuetype as { name?: string } | undefined)?.name ?? null,
    priority: (f.priority as { name?: string } | undefined)?.name ?? null,
    assignee: person(f.assignee),
    reporter: person(f.reporter),
    sprint: active ? { id: active.id, name: active.name } : null,
    sprints: sprints.map((s) => s.name),
    epic:
      (f.parent as { key?: string } | undefined)?.key ??
      (opts.epicLinkField ? ((f[opts.epicLinkField] as string) ?? null) : null),
    parent: (f.parent as { key?: string } | undefined)?.key ?? null,
    labels: (f.labels as string[] | undefined) ?? [],
    components: ((f.components as { name?: string }[] | undefined) ?? [])
      .map((c) => c.name ?? '')
      .filter(Boolean),
    fixVersions: ((f.fixVersions as { name?: string }[] | undefined) ?? [])
      .map((v) => v.name ?? '')
      .filter(Boolean),
    estimate: typeof estimateRaw === 'number' ? estimateRaw : null,
    created: (f.created as string) ?? null,
    updated: (f.updated as string) ?? null,
    resolved: (f.resolutiondate as string) ?? null,
    url: `${opts.baseUrl.replace(/\/+$/, '')}/browse/${raw.key}`,
    links,
    comments,
  };
}

/** Sprint field arrives either as objects (Cloud/newer DC) or toString blobs. */
function extractSprints(
  fields: Record<string, unknown>,
): { id: number; name: string; state: string }[] {
  for (const value of Object.values(fields)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const first = value[0];
    if (
      first &&
      typeof first === 'object' &&
      'state' in first &&
      'name' in first &&
      'id' in first
    ) {
      return (value as { id: number; name: string; state: string }[]).map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
      }));
    }
    if (typeof first === 'string' && first.includes('com.atlassian.greenhopper')) {
      return value
        .map((s: string) => {
          const id = /[[,]id=(\d+)/.exec(s);
          const name = /[[,]name=([^,\]]+)[,\]]/.exec(s);
          const state = /[[,]state=([A-Za-z]+)[,\]]/.exec(s);
          return id && name
            ? {
                id: Number(id[1]),
                name: name[1] as string,
                state: (state?.[1] ?? '').toLowerCase(),
              }
            : null;
        })
        .filter((x): x is { id: number; name: string; state: string } => x !== null);
    }
  }
  return [];
}

// ------------------------------------------------------------------ render

/** Escape anything in untrusted Jira text that this spec would interpret. */
export function neutralize(text: string): string {
  return text
    .replace(/<!--\s*jira:end\s*-->/g, '<!-- jira:end (escaped) -->')
    .replace(/^---[ \t]*$/gm, '\\---');
}

const wl = (key: string) => `[[${key}]]`;

export function renderIssueFile(
  issue: NormalizedIssue,
  opts: {
    config: VaultConfig;
    profile: string;
    syncedAt: string;
    /** carried over from the existing file */
    id?: string | undefined;
    plan?: Record<string, unknown> | undefined;
    userRegion?: string | undefined;
  },
): string {
  const fm: Record<string, unknown> = {};
  if (opts.id) fm.id = opts.id;
  fm.type = 'jira';
  fm.key = issue.key;
  fm.summary = issue.summary;
  if (issue.status !== null) fm.status = issue.status;
  if (issue.statusCategory !== null) fm.status_category = issue.statusCategory;
  if (issue.issueType !== null) fm.issue_type = issue.issueType;
  if (issue.priority !== null) fm.priority = issue.priority;
  if (issue.assignee) {
    fm.assignee = issue.assignee.id;
    fm.assignee_name = issue.assignee.name;
  }
  if (issue.reporter) fm.reporter = issue.reporter.id;
  if (issue.sprint) {
    fm.sprint = issue.sprint.name;
    fm.sprint_id = issue.sprint.id;
  }
  if (issue.sprints.length > 1) fm.sprints = issue.sprints;
  if (issue.epic) fm.epic = wl(issue.epic);
  if (issue.parent) fm.parent = wl(issue.parent);
  if (issue.labels.length) fm.labels = issue.labels;
  if (issue.components.length) fm.components = issue.components;
  if (issue.fixVersions.length) fm.fix_versions = issue.fixVersions;
  if (issue.estimate !== null) fm.estimate = issue.estimate;
  if (opts.config.jira.estimateField) fm.estimate_field = opts.config.jira.estimateField;
  if (issue.created) fm.created = issue.created;
  if (issue.updated) fm.updated = issue.updated;
  fm.resolved = issue.resolved;
  fm.url = issue.url;
  if (issue.links.length) {
    fm.links = issue.links.map((l) => ({ type: l.type, dir: l.dir, key: wl(l.key) }));
  }
  fm.jira = { synced: opts.syncedAt, profile: opts.profile, render: RENDER_VERSION };
  if (opts.plan && Object.keys(opts.plan).length) fm.plan = opts.plan;

  const yaml = stringifyYaml(fm, { lineWidth: 0, schema: 'core' }).trimEnd();

  const headerBits = [
    issue.status ? `**Status:** ${issue.status}` : null,
    issue.assignee ? `**Assignee:** ${issue.assignee.name}` : null,
    issue.sprint ? `**Sprint:** ${issue.sprint.name}` : null,
    issue.estimate !== null ? `**Estimate:** ${issue.estimate}` : null,
  ].filter(Boolean);

  const body: string[] = [];
  body.push(`# ${issue.key} — ${neutralize(issue.summary)}`);
  if (headerBits.length) body.push(headerBits.join(' · '));
  const desc = jiraTextToMarkdown(issue.description);
  if (desc) body.push('## Description', neutralize(desc));
  if (issue.links.length) {
    body.push('## Links', issue.links.map((l) => `- ${l.type} ${wl(l.key)}`).join('\n'));
  }
  if (opts.config.jira.syncComments && issue.comments.length) {
    body.push(
      '## Comments',
      issue.comments
        .map(
          (c) =>
            `**${c.author}** · ${c.created.slice(0, 10)}\n\n${neutralize(jiraTextToMarkdown(c.body))}`,
        )
        .join('\n\n---\n\n'),
    );
  }

  const userRegion = opts.userRegion ?? '\n## My notes\n\n';
  return `---\n${yaml}\n---\n\n${body.join('\n\n')}\n\n${JIRA_MARKER}\n${userRegion}`;
}

export type MergeOutcome =
  | { action: 'write'; content: string }
  | { action: 'skip'; reason: string }
  | { action: 'unchanged' };

/** SPEC §6.2 write algorithm, pure: existing content in, decision out. */
export function mergeIssueFile(
  issue: NormalizedIssue,
  existing: string | null,
  opts: { config: VaultConfig; profile: string; syncedAt: string },
): MergeOutcome {
  if (existing === null) {
    return { action: 'write', content: renderIssueFile(issue, opts) };
  }
  const fmParsed = parseFrontmatter(existing);
  const id = typeof fmParsed.data.id === 'string' ? fmParsed.data.id : undefined;
  const plan =
    fmParsed.data.plan &&
    typeof fmParsed.data.plan === 'object' &&
    !Array.isArray(fmParsed.data.plan)
      ? (fmParsed.data.plan as Record<string, unknown>)
      : undefined;

  const markerIdx = findMarker(existing);
  if (markerIdx === -1) {
    const policy = opts.config.jira.missingMarker;
    if (policy === 'skip') {
      return { action: 'skip', reason: `marker missing in jira file for ${issue.key}` };
    }
    if (policy === 'append') {
      const oldBody = existing.slice(fmParsed.bodyOffset).replace(/^\s*\n/, '');
      const content = renderIssueFile(issue, {
        ...opts,
        id,
        plan,
        userRegion: `\n## My notes (recovered)\n\n${oldBody}`,
      });
      return { action: 'write', content };
    }
    // overwrite
    return { action: 'write', content: renderIssueFile(issue, { ...opts, id, plan }) };
  }
  // Strip the marker line's own newline; render() re-adds exactly one.
  const userRegion = existing.slice(markerIdx + JIRA_MARKER.length).replace(/^[ \t]*\r?\n/, '');
  const content = renderIssueFile(issue, { ...opts, id, plan, userRegion });
  // Idempotence: ignore the volatile synced timestamp when comparing.
  if (stripSynced(content) === stripSynced(existing)) return { action: 'unchanged' };
  return { action: 'write', content };
}

function findMarker(text: string): number {
  const re = /^<!-- jira:end -->[ \t]*$/m;
  const m = re.exec(text);
  return m ? m.index : -1;
}

function stripSynced(text: string): string {
  return text.replace(/^\s*synced: .*$/m, '');
}
