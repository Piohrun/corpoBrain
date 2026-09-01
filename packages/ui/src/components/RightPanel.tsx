import { useEffect, useState } from 'react';
import {
  type CategoryField,
  fieldsApi,
  type NoteListItem,
  type NoteResponse,
  treeApi,
} from '../api.ts';

interface Props {
  note: NoteResponse | null;
  notes: NoteListItem[];
  onOpen: (path: string) => void;
  onTag: (tag: string) => void;
  onMetaChanged: (newPath?: string) => void;
}

export function RightPanel({ note, notes, onOpen, onTag, onMetaChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<CategoryField[]>([]);
  const [sprintOverrides, setSprintOverrides] = useState<string[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear stale errors when switching notes
  useEffect(() => setError(null), [note?.path]);

  const category = note ? categoryOf(note.path) : null;
  useEffect(() => {
    if (!category || category === 'jira') {
      setFields([]);
      setSprintOverrides(null);
      return;
    }
    let cancelled = false; // a slow answer for the previous category must not land here
    fieldsApi
      .forCategory(category)
      .then((r) => {
        if (cancelled) return;
        setFields(r.fields);
        setSprintOverrides(r.sprintOverrides);
      })
      .catch(() => {
        if (cancelled) return;
        setFields([]);
        setSprintOverrides(null);
      });
    return () => {
      cancelled = true;
    };
  }, [category]);

  if (!note) return <div className="right" />;
  const fm = note.meta?.frontmatter ?? {};
  const fieldKeys = new Set(fields.map((f) => f.key));
  const props = Object.entries(fm).filter(
    ([k]) =>
      !['id', 'title', 'type', 'parent', 'order', 'tags', 'capacity_overrides'].includes(k) &&
      !fieldKeys.has(k),
  );
  const fmTags = (Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === 'string' ? [fm.tags] : [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim());

  const isJira = note.meta?.type === 'jira';
  const categories = [...new Set(notes.map((n) => categoryOf(n.path)))]
    .filter((c) => c !== 'jira' && c !== 'private')
    .sort();
  const parentValue = typeof fm.parent === 'string' ? fm.parent.replace(/^\[\[|\]\]$/g, '') : '';

  const patch = (body: {
    type?: string | null;
    parent?: string | null;
    order?: number | null;
    tags?: string[];
    set?: Record<string, unknown>;
  }) => {
    setError(null);
    treeApi
      .meta({ path: note.path, ...body })
      .then((r) => onMetaChanged(r.path))
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="right">
      {!isJira && (
        <>
          <h3>Organize</h3>
          <div className="meta-edit">
            <label>
              category
              <input
                key={`cat:${note.path}`}
                list="cb-types"
                defaultValue={categoryOf(note.path)}
                placeholder="notes"
                title="Categories are the folders on the left. A new name creates a new category; changing it moves the note (cross-category parents are unlinked)."
                onBlur={(e) => {
                  const v = e.target.value.trim().toLowerCase() || null;
                  if ((v ?? 'notes') !== categoryOf(note.path)) patch({ type: v });
                }}
              />
            </label>
            <datalist id="cb-types">
              {categories.map((t) => (
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
            {fields.length > 0 && (
              <>
                <label htmlFor="cb-field-0">{category} fields</label>
                {fields.map((f, idx) => (
                  <FieldEditor
                    key={`${note.path}:${f.key}`}
                    id={idx === 0 ? 'cb-field-0' : undefined}
                    field={f}
                    value={fm[f.key]}
                    onCommit={(v) => patch({ set: { [f.key]: v } })}
                  />
                ))}
              </>
            )}
            {sprintOverrides && sprintOverrides.length > 0 && (
              <>
                <label htmlFor="cb-ov-0">capacity overrides</label>
                {sprintOverrides.map((sprint, idx) => {
                  const overrides =
                    fm.capacity_overrides && typeof fm.capacity_overrides === 'object'
                      ? (fm.capacity_overrides as Record<string, number>)
                      : {};
                  return (
                    <label key={`${note.path}:${sprint}`} className="field-row">
                      <span className="field-key">{sprint}</span>
                      <input
                        key={`${note.path}:${sprint}:${overrides[sprint] ?? ''}`}
                        id={idx === 0 ? 'cb-ov-0' : undefined}
                        type="number"
                        step="0.5"
                        defaultValue={overrides[sprint] ?? ''}
                        placeholder="default"
                        onBlur={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          if (v === (overrides[sprint] ?? null)) return;
                          const next = { ...overrides };
                          if (v === null) delete next[sprint];
                          else next[sprint] = v;
                          patch({
                            set: {
                              capacity_overrides: Object.keys(next).length ? next : null,
                            },
                          });
                        }}
                      />
                    </label>
                  );
                })}
              </>
            )}
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

function categoryOf(path: string): string {
  return path.includes('/') ? (path.split('/')[0] as string) : 'notes';
}

function FieldEditor({
  id,
  field,
  value,
  onCommit,
}: {
  id?: string | undefined;
  field: CategoryField;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  if (field.kind === 'boolean') {
    return (
      <label className="field-row">
        <span className="field-key">{field.key}</span>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onCommit(e.target.checked)}
        />
      </label>
    );
  }
  const display =
    value === null || value === undefined
      ? ''
      : Array.isArray(value)
        ? value.join(', ')
        : String(value);
  return (
    <label className="field-row" title={`source: ${field.source}`}>
      <span className="field-key">{field.key}</span>
      <input
        id={id}
        type={field.kind === 'number' ? 'number' : 'text'}
        step={field.kind === 'number' ? '0.5' : undefined}
        defaultValue={display}
        placeholder="—"
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (raw === display.trim()) return;
          if (raw === '') return onCommit(null);
          if (field.kind === 'number') {
            const n = Number(raw);
            return onCommit(Number.isFinite(n) ? n : null);
          }
          if (field.kind === 'list')
            return onCommit(
              raw
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
            );
          onCommit(raw);
        }}
      />
    </label>
  );
}
