import type { NoteResponse } from '../api.ts';

/** keys that are bookkeeping, not something a person wants to read */
const HIDDEN = new Set([
  'id',
  'order',
  'title',
  'jira',
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

const link = (v: unknown): string | null => {
  const m = typeof v === 'string' ? /^\[\[([^\]|#]+)/.exec(v) : null;
  return m ? (m[1] as string).trim() : null;
};

/**
 * The note's frontmatter as a row of chips above the editor, so the raw
 * `---` block can stay folded. Tags and links are live; anything else opens
 * the raw block for editing.
 */
export function PropertiesBar({
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
        const target = link(v);
        return target ? (
          <button
            type="button"
            key={k}
            className="prop-chip link"
            onClick={() => onNavigate(target)}
            title={k}
          >
            <span className="prop-key">{k}</span> {target}
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
}
