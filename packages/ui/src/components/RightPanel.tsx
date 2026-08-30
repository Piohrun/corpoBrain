import type { NoteResponse } from '../api.ts';

interface Props {
  note: NoteResponse | null;
  onOpen: (path: string) => void;
}

export function RightPanel({ note, onOpen }: Props) {
  if (!note) return <div className="right" />;
  const fm = note.meta?.frontmatter ?? {};
  const props = Object.entries(fm).filter(([k]) => !['id', 'title'].includes(k));
  return (
    <div className="right">
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
