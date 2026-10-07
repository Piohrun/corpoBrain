import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ObjectRow, objectsApi, type TypeCount, treeApi } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { ctxTarget } from '../finder/ContextMenu.tsx';
import { rankBy } from '../finder/match.ts';
import { useFinderSections } from '../finder/registry.tsx';
import { type FinderSection, section } from '../finder/types.ts';
import { useVaultEvents } from '../hooks.ts';
import { naturalCompare } from '../sort.ts';
import { useProgressive } from './progressive.tsx';

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

  // re-read the current type's rows after an edit made from here
  const reloadRows = useCallback(() => {
    if (!selected) return;
    objectsApi
      .list(selected)
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  // ---- Ctrl+F and right-click: the objects of the selected type ----
  const finderSections = useMemo<FinderSection[]>(() => {
    if (!selected) return [];
    const itemOf = (r: ObjectRow) => ({
      id: r.path,
      label: r.title,
      detail: r.path,
      data: r,
    });
    const edit = (r: ObjectRow, body: { type?: string; set?: Record<string, unknown> }) =>
      treeApi
        .meta({ path: r.path, ...body })
        .then(() => {
          setError(null);
          refresh();
          reloadRows();
        })
        .catch((e: Error) => setError(e.message));
    return [
      section<ObjectRow>({
        id: 'objects',
        title: `Objects · ${selected}`,
        order: 10,
        limit: 10,
        search: (q) =>
          rankBy(rows, q, (r) => [r.title, r.path], 40).map(({ row, score }) => ({
            ...itemOf(row),
            score,
          })),
        resolve: (id) => {
          const r = rows.find((x) => x.path === id);
          return r ? itemOf(r) : null;
        },
        actions: [
          {
            id: 'open',
            label: 'open',
            run: ([r], ctx) => {
              ctx.close();
              if (r) onOpenNote(r.data.path);
            },
          },
          {
            id: 'set',
            label: 'set a property…',
            when: (list) => list.length === 1,
            run: ([r]) => {
              if (!r) return;
              const row = r.data;
              // the table's columns first, then any property this object already has
              const keys = [
                ...new Set([
                  ...columns,
                  ...Object.keys(row.frontmatter).filter((k) => !HIDDEN_KEYS.has(k)),
                ]),
              ];
              return {
                pick: {
                  title: `Property of “${row.title}”`,
                  section: section<{ key: string; isNew: boolean }>({
                    id: 'objects-property',
                    title: 'Property',
                    order: 0,
                    search: (q) => {
                      const hits = rankBy(keys, q, (k) => [k]).map(({ row: key }) => ({
                        id: key,
                        label: key,
                        hint: formatValue(row.frontmatter[key]) || undefined,
                        data: { key, isNew: false },
                      }));
                      const typed = q
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9_-]+/g, '_');
                      if (typed && !keys.includes(typed) && !HIDDEN_KEYS.has(typed))
                        hits.push({
                          id: `new:${typed}`,
                          label: `new property “${typed}”`,
                          hint: undefined,
                          data: { key: typed, isNew: true },
                        });
                      return hits;
                    },
                    actions: [],
                  }),
                  onPick: async (picked) => {
                    const { key } = picked.data as { key: string };
                    const current = formatValue(row.frontmatter[key]);
                    const value = await dlg.prompt({
                      title: `Set ${key}`,
                      label: `${key} of ${row.title} (empty removes it)`,
                      initial: current,
                      confirmLabel: 'Set',
                    });
                    if (value === null || value.trim() === current) return;
                    await edit(row, { set: { [key]: value.trim() || null } });
                  },
                },
              };
            },
          },
          {
            id: 'type',
            label: 'change type…',
            when: (list) => list.length === 1,
            run: async ([r], ctx) => {
              ctx.close();
              if (!r) return;
              const type = await dlg.prompt({
                title: 'Change type',
                label: `New type for ${r.data.title} (e.g. ${types
                  .map((t) => t.type)
                  .slice(0, 4)
                  .join(', ')})`,
                initial: selected,
                confirmLabel: 'Change',
              });
              const t = type
                ?.trim()
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, '-');
              if (t && t !== selected) await edit(r.data, { type: t });
            },
          },
        ],
      }),
    ];
  }, [selected, rows, columns, types, onOpenNote, dlg, refresh, reloadRows]);
  useFinderSections('objects', finderSections);

  const groups = useMemo(() => {
    if (!groupBy) return [['', rows]] as [string, ObjectRow[]][];
    const m = new Map<string, ObjectRow[]>();
    for (const r of rows) {
      const key = formatValue(r.frontmatter[groupBy]) || '(none)';
      const arr = m.get(key) ?? [];
      arr.push(r);
      m.set(key, arr);
    }
    return [...m.entries()].sort(([a], [b]) => naturalCompare(a, b));
  }, [rows, groupBy]);

  // Thousands of objects (every Jira issue): rows arrive as the table scrolls
  // into view; one budget across the groups, in display order.
  const { shown, sentinel } = useProgressive(rows.length, 200, groups);
  const visibleGroups = useMemo(() => {
    let budget = shown;
    const out: [string, ObjectRow[]][] = [];
    for (const [group, items] of groups) {
      if (budget <= 0) break;
      out.push([group, items.slice(0, budget)]);
      budget -= items.length;
    }
    return out;
  }, [groups, shown]);

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
        {visibleGroups.map(([group, items]) => (
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
                    <tr key={r.path} data-path={r.path} {...ctxTarget('objects', r.path)}>
                      <td>
                        <button
                          type="button"
                          className="text-link"
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
        {shown < rows.length && (
          <div ref={sentinel as React.RefObject<HTMLDivElement>} className="muted small">
            {rows.length - shown} more…
          </div>
        )}
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
