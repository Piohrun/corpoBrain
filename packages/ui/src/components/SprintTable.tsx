import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardIssue, BoardModel, PlanPatch } from '../api.ts';
import { statusColor } from '../colors.ts';
import { useProgressive } from './progressive.tsx';

interface Option {
  value: string;
  label: string;
}

/** Rows rendered per step; more are added as the end of the table scrolls into view. */
const PAGE = 200;

/**
 * A select that only exists while it is being edited. Thousands of rows each
 * carrying every person as an <option> built millions of DOM nodes; a row now
 * shows text, and one real <select> mounts on click (or Enter/Space).
 */
function ChoiceCell({
  value,
  label,
  options,
  overridden,
  ariaLabel,
  onChange,
}: {
  value: string;
  label: string;
  options: () => Option[];
  overridden: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!editing) return;
    ref.current?.focus();
    // open the native list straight away where the browser allows it
    try {
      ref.current?.showPicker?.();
    } catch {
      /* not supported or not allowed: the focused select is enough */
    }
  }, [editing]);
  if (!editing)
    return (
      <button
        type="button"
        className={`cell-input cell-choice${overridden ? ' overridden' : ''}`}
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
      >
        {label}
      </button>
    );
  const list = options();
  return (
    <select
      ref={ref}
      className={`cell-input${overridden ? ' overridden' : ''}`}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => {
        setEditing(false);
        if (e.target.value !== value) onChange(e.target.value);
      }}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setEditing(false);
      }}
    >
      {list.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {value && !list.some((o) => o.value === value) && <option value={value}>{value}</option>}
    </select>
  );
}

const IssueRow = memo(function IssueRow({
  i,
  sprintOptions,
  assigneeOptions,
  assigneeName,
  onPatch,
  onOpenNote,
}: {
  i: BoardIssue;
  sprintOptions: () => Option[];
  assigneeOptions: () => Option[];
  assigneeName: string;
  onPatch: (key: string, p: PlanPatch) => void;
  onOpenNote: (path: string) => void;
}) {
  return (
    <tr>
      <td>
        <input
          key={`${i.key}:${i.plan.rank ?? ''}`}
          className="cell-input rank"
          type="number"
          aria-label={`rank of ${i.key}`}
          defaultValue={i.plan.rank ?? ''}
          onBlur={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            if (v !== i.plan.rank) onPatch(i.key, { rank: v });
          }}
        />
      </td>
      <td>
        <button type="button" className="key-link" onClick={() => onOpenNote(i.path)}>
          {i.key}
        </button>
      </td>
      <td className="summary-cell" title={i.summary ?? ''}>
        {i.summary}
      </td>
      <td>
        <ChoiceCell
          value={i.effectiveSprint}
          label={i.effectiveSprint}
          options={sprintOptions}
          overridden={i.overridden.sprint}
          ariaLabel={`sprint of ${i.key}`}
          onChange={(sprint) => onPatch(i.key, { sprint })}
        />
      </td>
      <td>
        <ChoiceCell
          value={i.effectiveAssignee ?? ''}
          label={assigneeName}
          options={assigneeOptions}
          overridden={i.overridden.assignee}
          ariaLabel={`assignee of ${i.key}`}
          onChange={(assignee) => onPatch(i.key, { assignee: assignee || null })}
        />
      </td>
      <td className="muted">
        <span
          className="status-dot"
          style={{ background: statusColor(i.status, i.statusCategory) }}
        />
        {i.status}
      </td>
      <td>
        <input
          key={`${i.key}:${i.effectiveEffort ?? ''}`}
          className="cell-input effort"
          type="number"
          step="0.5"
          aria-label={`effort of ${i.key}`}
          defaultValue={i.effectiveEffort ?? ''}
          title={i.plan.effort !== null ? 'local effort' : 'from Jira estimate'}
          onBlur={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value);
            if (v !== i.effectiveEffort) onPatch(i.key, { effort: v });
          }}
        />
      </td>
      <td>
        <select
          className="cell-input"
          aria-label={`risk of ${i.key}`}
          value={i.plan.risk ?? ''}
          onChange={(e) => onPatch(i.key, { risk: e.target.value || null })}
        >
          <option value="">—</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </td>
      <td>
        <input
          key={`${i.key}:${i.plan.note ?? ''}`}
          className="cell-input note"
          aria-label={`note on ${i.key}`}
          defaultValue={i.plan.note ?? ''}
          placeholder="…"
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== i.plan.note) onPatch(i.key, { note: v });
          }}
        />
      </td>
      <td className="flags-cell">
        {i.riskFlags.map((f) => (
          <span key={f} className="flag">
            {f}
          </span>
        ))}
      </td>
    </tr>
  );
});

export const SprintTable = memo(function SprintTable({
  board,
  issues,
  onPatch,
  onOpenNote,
}: {
  board: BoardModel;
  issues: BoardIssue[];
  onPatch: (key: string, p: PlanPatch) => void;
  onOpenNote: (path: string) => void;
}) {
  const sorted = useMemo(() => {
    const column = new Map(board.columns.map((c, n) => [c, n]));
    return [...issues].sort((a, b) => {
      const ca = column.get(a.effectiveSprint) ?? -1;
      const cb = column.get(b.effectiveSprint) ?? -1;
      if (ca !== cb) return ca - cb;
      const ra = a.plan.rank ?? Number.POSITIVE_INFINITY;
      const rb = b.plan.rank ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.key.localeCompare(b.key);
    });
  }, [issues, board.columns]);

  const { assigneeOptions, sprintOptions, nameOf } = useMemo(() => {
    const people = board.people
      .filter((p) => p.active && p.jiraIds.length)
      .map((p) => ({ value: p.jiraIds[0] as string, label: p.name }));
    const names = new Map(people.map((p) => [p.value, p.label]));
    const assignees = [{ value: '', label: '—' }, ...people];
    const sprints = board.columns.map((c) => ({ value: c, label: c }));
    return {
      assigneeOptions: () => assignees,
      sprintOptions: () => sprints,
      nameOf: (id: string | null) => (id ? (names.get(id) ?? id) : '—'),
    };
  }, [board.people, board.columns]);

  // Progressive rendering: grow the rendered slice as its end comes into view.
  const { shown, sentinel } = useProgressive(sorted.length, PAGE, sorted);
  const visible = sorted.length > shown ? sorted.slice(0, shown) : sorted;

  return (
    <section>
      <h2 className="plan-h2">Issues ({sorted.length})</h2>
      <div className="grid-wrap">
        <table className="issue-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Key</th>
              <th>Summary</th>
              <th>Sprint</th>
              <th>Assignee</th>
              <th>Status</th>
              <th>Effort</th>
              <th>Risk</th>
              <th>Note</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <IssueRow
                key={i.key}
                i={i}
                sprintOptions={sprintOptions}
                assigneeOptions={assigneeOptions}
                assigneeName={nameOf(i.effectiveAssignee)}
                onPatch={onPatch}
                onOpenNote={onOpenNote}
              />
            ))}
            {visible.length < sorted.length && (
              <tr ref={sentinel as React.RefObject<HTMLTableRowElement>}>
                <td colSpan={10} className="muted small">
                  {sorted.length - visible.length} more…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
});
