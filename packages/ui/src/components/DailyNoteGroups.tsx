import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { type DailyEntry, type DailyGroup, dailyGroupKeysForPath } from '../daily-notes.ts';
import { lsJson, lsSetJson } from '../storage.ts';

const STORAGE_KEY = 'corpobrain.dailyGroups';

export function DailyNoteGroups({
  groups,
  currentPath,
  openSequence,
  renderNote,
}: {
  groups: DailyGroup[];
  currentPath: string | null;
  openSequence: number;
  renderNote: (entry: DailyEntry, depth: number) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => lsJson(STORAGE_KEY, {}));
  useEffect(() => lsSetJson(STORAGE_KEY, expanded), [expanded]);

  // Keep the dependency stable across tree refreshes: manually collapsing a
  // group remains possible while its note is open. A new selection reveals it.
  const revealKeys = JSON.stringify(dailyGroupKeysForPath(groups, currentPath));
  const revealSelection = currentPath ? `${openSequence}:${currentPath}` : null;
  useEffect(() => {
    if (!revealSelection) return;
    const keys = JSON.parse(revealKeys) as string[];
    pendingReveal.current = keys.length ? currentPath : null;
    setExpanded((previous) => {
      if (keys.every((key) => previous[key] === true)) return previous;
      return { ...previous, ...Object.fromEntries(keys.map((key) => [key, true])) };
    });
  }, [currentPath, revealSelection, revealKeys]);

  // Expansion may need another render before the selected row exists.
  useEffect(() => {
    if (!pendingReveal.current) return;
    const row = [...(container.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
      (element) => element.dataset.path === pendingReveal.current,
    );
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      pendingReveal.current = null;
    }
  });

  const renderGroup = (group: DailyGroup, depth: number): ReactNode => {
    const open = expanded[group.key] ?? group.defaultOpen;
    const setOpen = (value: boolean) =>
      setExpanded((previous) => ({ ...previous, [group.key]: value }));
    const count = `${group.count} daily ${group.count === 1 ? 'note' : 'notes'}`;
    return (
      <div key={group.key} className="daily-note-group">
        <button
          type="button"
          className={`daily-group-toggle daily-group-${group.kind}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={open}
          aria-label={`${group.label}, ${count}`}
          title={`${group.kind === 'week' ? 'Monday–Sunday · ' : ''}${count}`}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setOpen(event.key === 'ArrowRight');
          }}
        >
          <span className="tree-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="daily-group-label">{group.label}</span>
          <span className="daily-group-count" aria-hidden="true">
            {group.count}
          </span>
        </button>
        {open && (
          <>
            {group.groups.map((child) => renderGroup(child, depth + 1))}
            {group.notes.map((entry) => renderNote(entry, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="daily-note-groups" ref={container}>
      {groups.map((group) => renderGroup(group, 0))}
    </div>
  );
}
