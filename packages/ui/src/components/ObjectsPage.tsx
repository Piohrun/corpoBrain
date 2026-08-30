import { useCallback, useEffect, useMemo, useState } from 'react';
import { useVaultEvents } from '../hooks.ts';

interface TypeCount {
  type: string;
  count: number;
}

interface ObjectRow {
  path: string;
  title: string;
  mtime: number;
  frontmatter: Record<string, unknown>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

const HIDDEN_KEYS = new Set(['id', 'type', 'title', 'jira']);

export function ObjectsPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [types, setTypes] = useState<TypeCount[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<ObjectRow[]>([]);
  const [groupBy, setGroupBy] = useState<string>('');

  const refresh = useCallback(() => {
    fetchJson<TypeCount[]>('/api/objects/types')
      .then((t) => {
        setTypes(t);
        setSelected((s) => s ?? t.find((x) => x.type !== 'note')?.type ?? t[0]?.type ?? null);
      })
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  useEffect(() => {
    if (!selected) return;
    fetchJson<ObjectRow[]>(`/api/objects/list?type=${encodeURIComponent(selected)}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [selected]);

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
        <span className="spacer" />
        <select className="cell-input" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
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
