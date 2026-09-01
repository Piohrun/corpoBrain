import { useMemo } from 'react';
import type { BoardIssue, BoardModel, PlanPatch } from '../api.ts';
import { statusColor } from '../colors.ts';

export function SprintTable({
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
  const sorted = useMemo(
    () =>
      [...issues].sort((a, b) => {
        const ca = board.columns.indexOf(a.effectiveSprint);
        const cb = board.columns.indexOf(b.effectiveSprint);
        if (ca !== cb) return ca - cb;
        const ra = a.plan.rank ?? Number.POSITIVE_INFINITY;
        const rb = b.plan.rank ?? Number.POSITIVE_INFINITY;
        if (ra !== rb) return ra - rb;
        return a.key.localeCompare(b.key);
      }),
    [issues, board.columns],
  );

  const assigneeOptions = board.people
    .filter((p) => p.active && p.jiraIds.length)
    .map((p) => ({ id: p.jiraIds[0] as string, name: p.name }));

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
            {sorted.map((i) => (
              <tr key={i.key}>
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
                  <select
                    className={`cell-input${i.overridden.sprint ? ' overridden' : ''}`}
                    value={i.effectiveSprint}
                    onChange={(e) => onPatch(i.key, { sprint: e.target.value })}
                  >
                    {board.columns.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className={`cell-input${i.overridden.assignee ? ' overridden' : ''}`}
                    value={i.effectiveAssignee ?? ''}
                    onChange={(e) => onPatch(i.key, { assignee: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {assigneeOptions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                    {i.effectiveAssignee &&
                      !assigneeOptions.some((a) => a.id === i.effectiveAssignee) && (
                        <option value={i.effectiveAssignee}>{i.effectiveAssignee}</option>
                      )}
                  </select>
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
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
