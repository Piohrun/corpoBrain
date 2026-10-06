/**
 * Turns the user's selection from a plan into file contents, and records the
 * outcome in the baseline. Pure: the caller reads files, validates the
 * organization model over the result, writes, and journals for undo.
 */
import { parseFrontmatter, setFrontmatterKey } from '../frontmatter.ts';
import {
  type BaselineValue,
  TEAMBOOK_ID_KEY,
  type TeambookBaseline,
  type TeambookChange,
  type TeambookPlan,
} from './plan.ts';

export interface TeambookWrite {
  path: string;
  /** null = the note is created */
  before: string | null;
  after: string;
  changeIds: string[];
}

export interface TeambookWrites {
  writes: TeambookWrite[];
  applied: string[];
  skipped: { id: string; reason: string }[];
}

const json = (v: unknown) => JSON.stringify(v ?? null);

export function buildTeambookWrites(
  plan: TeambookPlan,
  selectedIds: string[],
  read: (path: string) => string | null,
  /** starting content for a new note (a template), before fields are set */
  baseContent: (change: TeambookChange) => string,
): TeambookWrites {
  const byId = new Map(plan.changes.map((c) => [c.id, c]));
  const skipped: { id: string; reason: string }[] = [];
  const selected = new Set<string>();
  for (const id of new Set(selectedIds)) {
    const c = byId.get(id);
    if (!c) skipped.push({ id, reason: 'not part of this preview' });
    else if (c.status === 'blocked') skipped.push({ id, reason: c.reason });
    else selected.add(id);
  }

  // Each file is read once; anything stale or unwritable drops its changes.
  const contents = new Map<string, string | null>();
  const current = (path: string) => {
    if (!contents.has(path)) contents.set(path, read(path));
    return contents.get(path) as string | null;
  };
  for (const id of [...selected]) {
    const c = byId.get(id) as TeambookChange;
    const text = current(c.path);
    let problem: string | null = null;
    if (c.status === 'new') {
      if (text !== null) problem = `${c.path} was created since the preview`;
    } else if (text === null) {
      problem = `${c.path} no longer exists`;
    } else {
      const fm = parseFrontmatter(text);
      if (fm.error)
        problem = `${c.path}: frontmatter cannot be parsed — fix it in the editor first`;
      else if (c.status === 'link') {
        if (fm.data[TEAMBOOK_ID_KEY] !== undefined)
          problem = `${c.path} was linked since the preview`;
      } else if (c.field && json(fm.data[c.field]) !== json(c.current))
        problem = `${c.path}: ${c.field} changed since the preview — preview again`;
    }
    if (problem) {
      selected.delete(id);
      skipped.push({ id, reason: problem });
    }
  }

  // A change needs what it requires (a link or create) applied too, transitively.
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of [...selected]) {
      const missing = (byId.get(id) as TeambookChange).requires.find((r) => !selected.has(r));
      if (missing) {
        selected.delete(id);
        skipped.push({ id, reason: `needs ${missing}` });
        changed = true;
      }
    }
  }

  const perPath = new Map<string, TeambookChange[]>();
  for (const id of selected) {
    const c = byId.get(id) as TeambookChange;
    perPath.set(c.path, [...(perPath.get(c.path) ?? []), c]);
  }
  const writes: TeambookWrite[] = [];
  for (const [path, changes] of perPath) {
    const before = current(path);
    let text = before ?? baseContent(changes[0] as TeambookChange);
    for (const c of changes) {
      if (c.status === 'new') {
        text = setFrontmatterKey(text, 'type', c.scope === 'unit' ? 'org_unit' : 'person');
        text = setFrontmatterKey(text, TEAMBOOK_ID_KEY, c.externalId);
        for (const [key, value] of Object.entries(c.next as Record<string, unknown>))
          text = setFrontmatterKey(text, key, value);
      } else if (c.status === 'link') {
        text = setFrontmatterKey(text, TEAMBOOK_ID_KEY, c.externalId);
      } else if (c.field) {
        text = setFrontmatterKey(text, c.field, c.next);
      }
    }
    if (text !== before)
      writes.push({ path, before, after: text, changeIds: changes.map((c) => c.id) });
  }
  return { writes, applied: [...selected], skipped };
}

/** The baseline after applying `applied` and dismissing `dismissed`. */
export function nextBaseline(
  baseline: TeambookBaseline,
  plan: TeambookPlan,
  applied: string[],
  dismissed: string[],
): TeambookBaseline {
  const next: TeambookBaseline = structuredClone(baseline);
  const done = new Set(applied);
  const byId = new Map(plan.changes.map((c) => [c.id, c]));
  const set = (scope: 'unit' | 'person', id: string, field: string, value: BaselineValue) => {
    next[scope][id] ??= {};
    (next[scope][id] as Record<string, BaselineValue>)[field] = value;
  };
  for (const id of applied) {
    const c = byId.get(id);
    if (!c || !c.field || c.status === 'new' || c.status === 'link' || c.status === 'left')
      continue;
    set(c.scope, c.externalId, c.field, c.incoming);
    delete next.dismissed[c.id];
  }
  // Values that already agreed count as imported, once the note is tied to Teambook.
  for (const a of plan.agreed) {
    const gate = [`${a.scope}:${a.externalId}:create`, `${a.scope}:${a.externalId}:link`].find(
      (g) => byId.has(g),
    );
    if (gate && !done.has(gate)) continue;
    set(a.scope, a.externalId, a.field, a.value);
  }
  for (const id of dismissed) {
    const c = byId.get(id);
    if (c?.field && (c.status === 'conflict' || c.status === 'dismissed'))
      next.dismissed[id] = c.incoming;
  }
  return next;
}
