import { useEffect, useState } from 'react';
import { type NoteListItem, type NoteResponse, treeApi } from '../api.ts';

interface Props {
  note: NoteResponse | null;
  notes: NoteListItem[];
  onOpen: (path: string) => void;
  onMetaChanged: () => void;
}

export function RightPanel({ note, notes, onOpen, onMetaChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear stale errors when switching notes
  useEffect(() => setError(null), [note?.path]);

  if (!note) return <div className="right" />;
  const fm = note.meta?.frontmatter ?? {};
  const props = Object.entries(fm).filter(
    ([k]) => !['id', 'title', 'type', 'parent', 'order'].includes(k),
  );
  const isJira = note.meta?.type === 'jira';
  const types = [...new Set(notes.map((n) => n.type))].filter((t) => t !== 'jira').sort();
  const parentValue = typeof fm.parent === 'string' ? fm.parent.replace(/^\[\[|\]\]$/g, '') : '';

  const patch = (body: { type?: string | null; parent?: string | null; order?: number | null }) => {
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
