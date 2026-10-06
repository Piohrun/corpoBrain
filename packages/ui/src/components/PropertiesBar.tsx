import { memo } from 'react';
import type { NoteResponse } from '../api.ts';

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

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(fmt).filter(Boolean).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

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
  // a note without a frontmatter block gets no bar at all
  if (!/^\ufeff?---[ \t]*\r?\n/.test(note.content)) return null;
  const type = typeof fm.type === 'string' ? fm.type : null;
  const created = typeof fm.created === 'string' ? fm.created.slice(0, 10) : null;
  const parent = link(fm.parent);
  const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(fmt).filter(Boolean) : [];
  const rest = Object.entries(fm).filter(
    ([k, v]) =>
      !HIDDEN.has(k) &&
      !['type', 'tags', 'created', 'parent', 'aliases', 'plan'].includes(k) &&
      v !== null &&
      v !== '' &&
      !(Array.isArray(v) && v.length === 0),
  );
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
          ↑ {parent}
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
      {rest.map(([k, v]) => {
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
                    {l.label}
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
            <span className="prop-key">{k}</span> {single.label}
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
