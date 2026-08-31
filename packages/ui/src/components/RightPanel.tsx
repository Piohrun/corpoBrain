import { useEffect, useState } from 'react';
import { type NoteListItem, type NoteResponse, treeApi } from '../api.ts';

interface Props {
  note: NoteResponse | null;
  notes: NoteListItem[];
  onOpen: (path: string) => void;
  onTag: (tag: string) => void;
  onMetaChanged: () => void;
}

export function RightPanel({ note, notes, onOpen, onTag, onMetaChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear stale errors when switching notes
  useEffect(() => setError(null), [note?.path]);

  if (!note) return <div className="right" />;
  const fm = note.meta?.frontmatter ?? {};
  const props = Object.entries(fm).filter(
    ([k]) => !['id', 'title', 'type', 'parent', 'order', 'tags'].includes(k),
  );
  const fmTags = (Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === 'string' ? [fm.tags] : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim());
  const fmTagsLower = new Set(fmTags.map((t) => t.toLowerCase()));
  const inlineTags = (note.tags ?? []).filter((t) => !fmTagsLower.has(t));
  const isJira = note.meta?.type === 'jira';
  const types = [...new Set(notes.map((n) => n.type))].filter((t) => t !== 'jira').sort();
  const parentValue = typeof fm.parent === 'string' ? fm.parent.replace(/^\[\[|\]\]$/g, '') : '';

  const patch = (body: {
    type?: string | null;
    parent?: string | null;
    order?: number | null;
    tags?: string[];
  }) => {
    setError(null);
    treeApi
      .meta({ path: note.path, ...body })
      .then(onMetaChanged)
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="right">
      {!isJira && (
        <>
          <h3>Organize</h3>
          <div className="meta-edit">
            <label>
              category (type)
              <input
                key={`type:${note.path}`}
                list="cb-types"
                defaultValue={note.meta?.type === 'note' ? '' : (note.meta?.type ?? '')}
                placeholder="note"
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== (note.meta?.type === 'note' ? null : note.meta?.type))
                    patch({ type: v });
                }}
              />
            </label>
            <datalist id="cb-types">
              {types.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <label>
              parent note
              <input
                key={`parent:${note.path}`}
                list="cb-parents"
                defaultValue={parentValue}
                placeholder="none (top level)"
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== (parentValue || null)) patch({ parent: v });
                }}
              />
            </label>
            <datalist id="cb-parents">
              {notes
                .filter((n) => !n.protected && n.type !== 'jira' && n.path !== note.path)
                .map((n) => (
                  <option key={n.path} value={n.title} />
                ))}
            </datalist>
            <label>
              order among siblings
              <input
                key={`order:${note.path}`}
                type="number"
                defaultValue={typeof fm.order === 'number' ? fm.order : ''}
                placeholder="—"
                onBlur={(e) => {
                  const v = e.target.value === '' ? null : Number(e.target.value);
                  if (v !== (typeof fm.order === 'number' ? fm.order : null)) patch({ order: v });
                }}
              />
            </label>
            <label htmlFor="cb-tag-add">tags</label>
            <div className="tag-edit">
              {fmTags.map((t) => (
                <span key={t} className="tag-row">
                  <button type="button" className="tag-open" onClick={() => onTag(t.toLowerCase())}>
                    #{t}
                  </button>
                  <button
                    type="button"
                    className="tag-remove"
                    title="Remove from frontmatter"
                    onClick={() => patch({ tags: fmTags.filter((x) => x !== t) })}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {inlineTags.map((t) => (
                <button
                  type="button"
                  key={t}
                  className="tag-row inline-tag"
                  title="From a #tag in the note body — edit the text to remove"
                  onClick={() => onTag(t)}
                >
                  #{t}
                </button>
              ))}
              <input
                id="cb-tag-add"
                className="tag-add"
                placeholder="+ add tag"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  const input = e.currentTarget;
                  const v = input.value.trim().replace(/^#/, '');
                  if (!v) return;
                  patch({ tags: [...fmTags, v] });
                  input.value = '';
                }}
              />
            </div>
            {error && <div className="plan-error">{error}</div>}
          </div>
        </>
      )}
      <h3>Backlinks ({note.backlinks.length})</h3>
      {note.backlinks.length === 0 && <div className="backlink muted">Nothing links here yet</div>}
      {note.backlinks.map((b) => (
        <button
          type="button"
          key={`${b.srcPath}:${b.line}:${b.kind}`}
          className="backlink"
          onClick={() => onOpen(b.srcPath)}
        >
          {b.srcTitle}
          <div className="muted">
            {b.srcPath}:{b.line} · {b.kind}
          </div>
        </button>
      ))}
      {props.length > 0 && (
        <>
          <h3>Properties</h3>
          <table className="prop-table">
            <tbody>
              {props.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{formatValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
