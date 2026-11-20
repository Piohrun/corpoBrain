import { memo, useEffect, useState } from 'react';
import type { NoteResponse } from '../api.ts';
import { useNoteTitle } from '../note-titles.tsx';
import { lsGet, lsSet } from '../storage.ts';

/** keys that are bookkeeping, not something a person wants to read */
const HIDDEN = new Set([
  'id',
  'order',
  'title',
  'jira',
  'outlook',
  'track_id',
  'source_path',
  'source_line',
  'excerpt',
]);

/** a work note's own status block shows these (core/work.ts): chips would only repeat it */
const WORK_STATUS_KEYS = new Set([
  'repo',
  'branch',
  'stage',
  'waiting_on',
  'state',
  'next',
  'chat',
  'updated',
  'clone',
  'uat_branch',
  'release_branch',
  'pr',
]);

/**
 * A mirrored Jira issue says these elsewhere: key and summary are its title,
 * the rest is bookkeeping of the sync.
 */
const JIRA_QUIET_KEYS = new Set(['key', 'summary', 'status_category', 'sprint_id', 'updated']);

/** chips shown before "+N more": a long frontmatter block should not push the note down */
const SHOWN_FIRST = 6;

/** does the note start with a frontmatter block? (without one there is no bar) */
export const hasFrontmatterBlock = (content: string): boolean =>
  /^\ufeff?---[ \t]*\r?\n/.test(content);

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(fmt).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    // `capacity_overrides: {Sprint 38: 3}` reads as "Sprint 38: 3", not as JSON
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.every(([, x]) => x === null || typeof x !== 'object')
      ? entries.map(([k, x]) => `${k}: ${fmt(x)}`).join(', ')
      : JSON.stringify(v);
  }
  return String(v);
};

const webLink = (v: unknown): string | null =>
  typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim()) ? v.trim() : null;

const link = (v: unknown): string | null => linkOf(v)?.target ?? null;

/** `[[target|label]]` → its target and the text to show (the alias, else the target). */
const linkOf = (v: unknown): { target: string; label: string } | null => {
  const m =
    typeof v === 'string'
      ? /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(v.trim())
      : null;
  if (!m) return null;
  const target = (m[1] as string).trim();
  return { target, label: m[2]?.trim() || target };
};

/**
 * The note's frontmatter as a row of chips above the editor, so the raw
 * `---` block can stay folded. Tags and links are live; anything else opens
 * the raw block for editing.
 */
export const PropertiesBar = memo(function PropertiesBar({
  note,
  folded,
  onToggleFold,
  onEdit,
  onTag,
  onNavigate,
}: {
  note: NoteResponse;
  folded: boolean;
  onToggleFold: () => void;
  onEdit: () => void;
  onTag: (tag: string) => void;
  onNavigate: (target: string) => void;
}) {
  const fm = note.meta?.frontmatter ?? {};
  const titleFor = useNoteTitle();
  /** what a link shows: its alias, else the linked note's title, else the target */
  const shown = (l: { target: string; label: string }) =>
    l.label !== l.target ? l.label : (titleFor(l.target) ?? l.target);
  // the same choice for every note: someone who wants every chip sets it once
  const [showAll, setShowAll] = useState(() => lsGet('cb.props.all') === 'yes');
  useEffect(() => lsSet('cb.props.all', showAll ? 'yes' : 'no'), [showAll]);
  // a note without a frontmatter block gets no bar at all
  if (!hasFrontmatterBlock(note.content)) return null;
  const type = typeof fm.type === 'string' ? fm.type : null;
  const created = typeof fm.created === 'string' ? fm.created.slice(0, 10) : null;
  const parent = link(fm.parent);
  const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(fmt).filter(Boolean) : [];
  const rest = Object.entries(fm).filter(
    ([k, v]) =>
      !HIDDEN.has(k) &&
      !(type === 'work' && WORK_STATUS_KEYS.has(k)) &&
      !(type === 'jira' && JIRA_QUIET_KEYS.has(k)) &&
      !['type', 'tags', 'created', 'parent', 'aliases', 'plan'].includes(k) &&
      v !== null &&
      v !== '' &&
      !(Array.isArray(v) && v.length === 0),
  );
  // the first few in the order they were written; a link out (open in Jira) is never folded away
  let room = SHOWN_FIRST;
  const visible = showAll ? rest : rest.filter(([, v]) => webLink(v) !== null || room-- > 0);
  const hiddenKeys = rest.filter((e) => !visible.includes(e)).map(([k]) => k);
  const hasAny =
    type !== null ||
    note.tags.length > 0 ||
    created !== null ||
    parent !== null ||
    aliases.length > 0 ||
    rest.length > 0;
  if (!folded || !hasAny) {
    // raw block visible in the editor: just the switch back
    return (
      <div className="props-bar">
        <span className="muted small">{hasAny ? 'properties shown as text' : 'no properties'}</span>
        <span className="spacer" />
        <button
          type="button"
          className="props-toggle"
          onClick={onToggleFold}
          title="Toggle between chips and the raw frontmatter block"
        >
          {folded ? 'show raw' : 'show chips'}
        </button>
      </div>
    );
  }
  return (
    <div className="props-bar">
      {type && type !== 'note' && (
        <span className="prop-chip kind" title="type">
          {type}
        </span>
      )}
      {note.tags.map((t) => (
        <button
          type="button"
          key={`t${t}`}
          className="prop-chip tag"
          onClick={() => onTag(t)}
          title="Filter the sidebar by this tag"
        >
          #{t}
        </button>
      ))}
      {parent && (
        <button
          type="button"
          className="prop-chip link"
          onClick={() => onNavigate(parent)}
          title="parent note"
        >
          ↑ {titleFor(parent) ?? parent}
        </button>
      )}
      {aliases.map((a) => (
        <span key={`a${a}`} className="prop-chip" title="alias">
          aka {a}
        </span>
      ))}
      {created && (
        <span className="prop-chip muted" title="created">
          {created}
        </span>
      )}
      {visible.map(([k, v]) => {
        const web = webLink(v);
        if (web)
          return (
            <a
              key={k}
              className="prop-chip link"
              href={web}
              target="_blank"
              rel="noopener noreferrer"
              title={web}
            >
              {type === 'jira' && k === 'url' ? 'open in Jira' : k} ↗
            </a>
          );
        const single = linkOf(v);
        const many = Array.isArray(v) && v.length > 0 ? v.map(linkOf) : null;
        if (many?.every(Boolean)) {
          return (
            <span key={k} className="prop-chip" title={k}>
              <span className="prop-key">{k}</span>{' '}
              {(many as { target: string; label: string }[]).map((l, i) => (
                <span key={l.target}>
                  {i > 0 && ', '}
                  <button
                    type="button"
                    className="prop-inline-link"
                    onClick={() => onNavigate(l.target)}
                    title={l.target}
                  >
                    {shown(l)}
                  </button>
                </span>
              ))}
            </span>
          );
        }
        return single ? (
          <button
            type="button"
            key={k}
            className="prop-chip link"
            onClick={() => onNavigate(single.target)}
            title={`${k}: ${single.target}`}
          >
            <span className="prop-key">{k}</span> {shown(single)}
          </button>
        ) : (
          <button
            type="button"
            key={k}
            className="prop-chip"
            onClick={onEdit}
            title={`${k} — click to edit the properties`}
          >
            <span className="prop-key">{k}</span> {fmt(v).slice(0, 40)}
          </button>
        );
      })}
      {(showAll ? rest.length > SHOWN_FIRST : hiddenKeys.length > 0) && (
        <button
          type="button"
          className="prop-chip more"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          title={showAll ? 'Show only the first properties' : hiddenKeys.join(', ')}
        >
          {showAll ? 'fewer' : `+${hiddenKeys.length} more`}
        </button>
      )}
      <span className="spacer" />
      <button
        type="button"
        className="props-toggle"
        onClick={onEdit}
        title="Edit the properties as text"
      >
        edit
      </button>
      <button
        type="button"
        className="props-toggle"
        onClick={onToggleFold}
        title="Show the raw frontmatter block"
      >
        raw
      </button>
    </div>
  );
});
