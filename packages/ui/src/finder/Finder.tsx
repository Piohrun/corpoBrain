import { useEffect, useMemo, useRef, useState } from 'react';
import { keyLabel } from '../shortcuts.ts';
import { splitMatches } from './match.ts';
import { useFinderRegistry } from './registry.tsx';
import type { FinderAction, FinderFollowUp, FinderItem, FinderSection } from './types.ts';

interface Row {
  section: FinderSection;
  item: FinderItem;
}

const ASYNC_DELAY = 60;

/**
 * The one search surface. Sections come from whatever pages are mounted
 * (see registry.tsx); the query is matched by every section, sync results
 * render on each keystroke and async ones slot in when they arrive.
 *
 * Keys: ↑↓ move · Tab/⇧Tab jump sections · Enter primary action ·
 * → or Ctrl+Enter open the action list · Space toggle selection in a
 * multi section · Esc close (or back out of a follow-up / action list).
 */
export function Finder() {
  const reg = useFinderRegistry();
  const { isOpen, close, request } = reg;
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Map<string, Row>>(new Map());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionCursor, setActionCursor] = useState(0);
  const [followUp, setFollowUp] = useState<FinderFollowUp['pick'] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const asyncSeq = useRef(0);

  // reset on open
  useEffect(() => {
    if (!isOpen) return;
    setQuery(request?.query ?? '');
    setCursor(0);
    setSelected(new Map());
    setResults(new Map());
    setActionsOpen(false);
    setFollowUp(null);
    setBusy(null);
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [isOpen, request]);

  // which sections apply: a follow-up pick, a requested section, a prefix, or all
  const { sections, effectiveQuery } = useMemo(() => {
    if (followUp) return { sections: [followUp.section], effectiveQuery: query };
    let list = reg.sections;
    let q = query;
    if (request?.section) list = list.filter((s) => s.id === request.section);
    else {
      const prefixed = list.find((s) => s.prefix && query.startsWith(s.prefix));
      if (prefixed) {
        list = [prefixed];
        q = query.slice((prefixed.prefix as string).length);
      }
    }
    return { sections: list, effectiveQuery: q };
  }, [reg.sections, request, query, followUp]);

  // Sync sections run on every change; async ones after a short pause. Search
  // never runs during render, and a section's previous results stay on screen
  // until the new ones land, so typing does not flicker.
  const [results, setResults] = useState<Map<string, FinderItem[]>>(new Map());
  useEffect(() => {
    if (!isOpen) return;
    const trimmed = effectiveQuery.trim();
    setResults((prev) => {
      const next = new Map(prev);
      for (const s of sections) {
        if (s.async) continue;
        if (!trimmed && s.showEmpty === false) {
          next.delete(s.id);
          continue;
        }
        const res = s.search(effectiveQuery);
        if (!(res instanceof Promise)) next.set(s.id, res);
      }
      return next;
    });
    const seq = ++asyncSeq.current;
    const t = setTimeout(() => {
      for (const s of sections) {
        if (!s.async) continue;
        if (!trimmed && s.showEmpty === false) {
          setResults((prev) => {
            const next = new Map(prev);
            next.delete(s.id);
            return next;
          });
          continue;
        }
        Promise.resolve(s.search(effectiveQuery))
          .then((items) => {
            if (seq !== asyncSeq.current) return;
            setResults((prev) => new Map(prev).set(s.id, items));
          })
          .catch(() => {});
      }
    }, ASYNC_DELAY);
    return () => clearTimeout(t);
  }, [isOpen, sections, effectiveQuery]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of sections) {
      const items = results.get(s.id) ?? [];
      const seen = new Set<string>();
      let n = 0;
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({ section: s, item });
        if (++n >= (s.limit ?? 8)) break;
      }
    }
    return out;
  }, [sections, results]);

  // keep the cursor on a real row
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, rows.length - 1)));
  }, [rows.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const current = rows[cursor] ?? null;
  const selectedRows = [...selected.values()];
  /** what an action runs on: the chips if any (same section), else the highlighted row */
  const targetRows = (row: Row | null): Row[] => {
    if (selectedRows.length && row && selectedRows[0]?.section.id === row.section.id)
      return selectedRows;
    if (selectedRows.length && !row) return selectedRows;
    return row ? [row] : [];
  };

  const actionsFor = (row: Row | null): FinderAction[] => {
    // a follow-up is a plain pick: one action, whatever the section offers normally
    if (followUp) return [{ id: 'pick', label: 'pick', run: () => {} }];
    const targets = targetRows(row);
    const section = targets[0]?.section ?? row?.section;
    if (!section) return [];
    const items = targets.map((r) => r.item);
    return section.actions.filter((a) => !a.when || a.when(items));
  };

  const runAction = async (action: FinderAction, row: Row | null) => {
    const targets = targetRows(row);
    if (!targets.length) return;
    if (followUp) {
      const picked = targets[0]?.item;
      const onPick = followUp.onPick;
      setFollowUp(null);
      close();
      if (picked) await onPick(picked);
      return;
    }
    setBusy(action.id);
    try {
      const result = await action.run(
        targets.map((r) => r.item),
        { query: effectiveQuery, close, context: request?.context ?? {} },
      );
      if (result && typeof result === 'object' && 'pick' in result) {
        setFollowUp(result.pick);
        setSelected(new Map());
        setQuery('');
        setCursor(0);
        setActionsOpen(false);
        setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        close();
      }
    } finally {
      setBusy(null);
    }
  };

  const toggleSelect = (row: Row) => {
    if (!row.section.multi) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const key = `${row.section.id}:${row.item.id}`;
      if (next.has(key)) next.delete(key);
      else {
        // chips belong to one section at a time
        for (const k of [...next.keys()]) if (!k.startsWith(`${row.section.id}:`)) next.delete(k);
        next.set(key, row);
      }
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const acts = actionsFor(current);
    if (actionsOpen) {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setActionsOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActionCursor((c) => Math.min(c + 1, acts.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActionCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const a = acts[actionCursor];
        if (a) void runAction(a, current);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (followUp) setFollowUp(null);
      else if (selected.size) setSelected(new Map());
      else close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!current) return;
      const ids = [...new Set(rows.map((r) => r.section.id))];
      const at = ids.indexOf(current.section.id);
      const nextId = ids[(at + (e.shiftKey ? ids.length - 1 : 1)) % ids.length];
      const idx = rows.findIndex((r) => r.section.id === nextId);
      if (idx >= 0) setCursor(idx);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        if (acts.length > 1) {
          setActionCursor(0);
          setActionsOpen(true);
        }
        return;
      }
      const a = acts[0];
      if (a) void runAction(a, current);
    } else if (e.key === 'ArrowRight' && current && acts.length > 1) {
      const input = inputRef.current;
      // only when the caret is at the end, so editing the query still works
      if (input && input.selectionStart === input.value.length) {
        e.preventDefault();
        setActionCursor(0);
        setActionsOpen(true);
      }
    } else if (e.key === ' ' && current?.section.multi && !query.trim().includes(' ')) {
      // Space toggles selection unless the user is typing a multi-word query
      const input = inputRef.current;
      if (input && input.value === '') {
        e.preventDefault();
        toggleSelect(current);
      } else if (e.ctrlKey) {
        e.preventDefault();
        toggleSelect(current);
      }
    }
  };

  if (!isOpen) return null;

  const primary = actionsFor(current)[0];
  const chips = selectedRows;
  let lastSection: string | null = null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; keys are handled on the input
    <div
      className="finder-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="finder" role="dialog" aria-modal="true" aria-label="Find">
        <div className="finder-head">
          {followUp && <span className="finder-crumb">{followUp.title}</span>}
          {chips.map((r) => (
            <button
              type="button"
              key={`${r.section.id}:${r.item.id}`}
              className="finder-chip"
              title="Remove from selection"
              onClick={() => toggleSelect(r)}
            >
              {r.item.label} ✕
            </button>
          ))}
          <input
            ref={inputRef}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="finder-list"
            aria-autocomplete="list"
            aria-activedescendant={current ? `finder-row-${cursor}` : undefined}
            aria-label="Find"
            placeholder={
              followUp
                ? 'pick one…'
                : sections.length === 1
                  ? `${sections[0]?.title.toLowerCase()}…`
                  : 'find anything…'
            }
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
              setActionsOpen(false);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="finder-list" id="finder-list" ref={listRef} role="listbox">
          {rows.map((r, i) => {
            const header = r.section.id !== lastSection;
            lastSection = r.section.id;
            const key = `${r.section.id}:${r.item.id}`;
            const isSel = selected.has(key);
            return (
              <div key={key}>
                {header && (
                  <div className="finder-section">
                    {r.section.title}
                    {r.section.multi && (
                      <span className="muted small"> · space to select several</span>
                    )}
                  </div>
                )}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the combobox input (aria-activedescendant) */}
                <div
                  id={`finder-row-${i}`}
                  data-row={i}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === cursor}
                  className={`finder-row${i === cursor ? ' active' : ''}${isSel ? ' selected' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    if (r.section.multi && (e.ctrlKey || e.metaKey || e.shiftKey)) toggleSelect(r);
                    else {
                      const a = actionsFor(r)[0];
                      if (a) void runAction(a, r);
                    }
                  }}
                >
                  {r.section.multi && (
                    <span className={`finder-check${isSel ? ' on' : ''}`} aria-hidden="true">
                      {isSel ? '☑' : '☐'}
                    </span>
                  )}
                  {r.item.icon !== undefined && <span className="finder-icon">{r.item.icon}</span>}
                  <span className="finder-label">
                    {splitMatches(r.item.label, effectiveQuery).map((p, j) =>
                      p.hit ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
                        <mark key={j}>{p.text}</mark>
                      ) : (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
                        <span key={j}>{p.text}</span>
                      ),
                    )}
                    {r.item.detail && <span className="finder-detail">{r.item.detail}</span>}
                  </span>
                  {r.item.hint && <span className="finder-hint">{r.item.hint}</span>}
                  {i === cursor && primary && !actionsOpen && (
                    <span className="finder-action-hint">
                      {primary.label}
                      <kbd>↵</kbd>
                      {actionsFor(r).length > 1 && <kbd title="more actions">→</kbd>}
                    </span>
                  )}
                </div>
                {i === cursor && actionsOpen && (
                  <div className="finder-actions" role="menu">
                    {actionsFor(r).map((a, ai) => (
                      <button
                        type="button"
                        key={a.id}
                        role="menuitem"
                        className={`finder-action${ai === actionCursor ? ' active' : ''}`}
                        onMouseEnter={() => setActionCursor(ai)}
                        onClick={() => void runAction(a, r)}
                      >
                        {a.label}
                        {a.keys && <kbd>{keyLabel(a.keys)}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="finder-empty">
              {effectiveQuery.trim()
                ? (sections[0]?.emptyText ?? 'Nothing matches')
                : 'Type to search'}
            </div>
          )}
        </div>
        <div className="finder-foot">
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>Tab</kbd> next section
          </span>
          <span>
            <kbd>↵</kbd> {primary?.label ?? 'open'}
          </span>
          <span>
            <kbd>→</kbd> actions
          </span>
          {sections.some((s) => s.multi) && (
            <span>
              <kbd>Space</kbd> select
            </span>
          )}
          <span>
            <kbd>Esc</kbd> {followUp ? 'back' : selected.size ? 'clear' : 'close'}
          </span>
          {busy && <span className="muted">working…</span>}
        </div>
      </div>
    </div>
  );
}
