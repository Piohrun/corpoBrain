import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ObjectRow, objectsApi, type TypeCount } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { useVaultEvents } from '../hooks.ts';

const HIDDEN_KEYS = new Set(['id', 'type', 'title', 'jira']);

export function ObjectsPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const dlg = useDialogs();
  const [types, setTypes] = useState<TypeCount[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<ObjectRow[]>([]);
  const [groupBy, setGroupBy] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    objectsApi
      .types()
      .then((t) => {
        setTypes(t);
        setSelected((s) => s ?? t.find((x) => x.type !== 'note')?.type ?? t[0]?.type ?? null);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false; // a slower earlier list must not overwrite this one
    objectsApi
      .list(selected)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setRows([]);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const create = (type: string, title: string, then: () => void) => {
    const folder =
      type === 'person' ? 'people' : type === 'note' || type === 'daily' ? 'notes' : type;
    const safe = title.replace(/[\\:*?"<>|/]/g, '-');
    api
      .createTyped(`${folder}/${safe}.md`, title, type)
      .then(() => {
        setError(null);
        then();
      })
      .catch((e: Error) => setError(e.message));
  };

  const columns = useMemo(() => {
    const keys = new Map<string, number>();
    for (const r of rows) {
      for (const k of Object.keys(r.frontmatter)) {
        if (!HIDDEN_KEYS.has(k)) keys.set(k, (keys.get(k) ?? 0) + 1);
      }
    }
    return [...keys.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);
  }, [rows]);

  const groups = useMemo(() => {
    if (!groupBy) return [['', rows]] as [string, ObjectRow[]][];
    const m = new Map<string, ObjectRow[]>();
    for (const r of rows) {
      const key = formatValue(r.frontmatter[groupBy]) || '(none)';
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows, groupBy]);

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Objects</span>
        {types.map((t) => (
          <button
            type="button"
            key={t.type}
            className={`risk-chip${selected === t.type ? ' active' : ''}`}
            onClick={() => setSelected(t.type)}
          >
            {t.type} <b>{t.count}</b>
          </button>
        ))}
        <button
          type="button"
          className="risk-chip"
          title="Create a category: the first note of a new type"
          onClick={async () => {
            const type = await dlg.prompt(
              'New category (type) name, e.g. retro, vendor, incident:',
            );
            if (!type?.trim()) return;
            const t = type
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-');
            const title = await dlg.prompt(`Title of the first ${t} note:`);
            if (!title?.trim()) return;
            create(t, title.trim(), () => {
              setSelected(t);
              refresh();
            });
          }}
        >
          + new category
        </button>
        {selected && (
          <button
            type="button"
            className="risk-chip"
            onClick={async () => {
              const title = await dlg.prompt(`Title of the new ${selected} note:`);
              if (!title?.trim()) return;
              create(selected, title.trim(), refresh);
            }}
          >
            + new {selected}
          </button>
        )}
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        <select
          className="cell-input"
          aria-label="group by"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
        >
          <option value="">no grouping</option>
          {columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="planning-scroll">
        {groups.map(([group, items]) => (
          <section key={group || '(all)'}>
            {group && <h2 className="plan-h2">{group}</h2>}
            <div className="grid-wrap">
              <table className="issue-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.path}>
                      <td>
                        <button
                          type="button"
                          className="key-link"
                          onClick={() => onOpenNote(r.path)}
                        >
                          {r.title}
                        </button>
                      </td>
                      {columns.map((c) => (
                        <td key={c} className="muted">
                          {formatValue(r.frontmatter[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {rows.length === 0 && <div className="empty-state">No objects of this type yet.</div>}
      </div>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.replace(/^\[\[|\]\]$/g, '');
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
