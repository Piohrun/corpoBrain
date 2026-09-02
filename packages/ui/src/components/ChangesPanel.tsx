import type { BoardModel, PlanPatch } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { personName } from './planningShared.ts';

export function ChangesPanel({
  board,
  onPatch,
  onOpenNote,
}: {
  board: BoardModel;
  onPatch: (key: string, p: PlanPatch) => void;
  onOpenNote: (path: string) => void;
}) {
  const dlg = useDialogs();
  const changes = board.issues.filter(
    (i) =>
      i.statusCategory !== 'done' &&
      (i.plan.sprint !== null || i.plan.assignee !== null || i.plan.effort !== null),
  );
  if (changes.length === 0) return null;
  return (
    <section>
      <h2 className="plan-h2">
        Uncommitted changes ({changes.length}){' '}
        <span className="muted small">local only — push to Jira from the ⚙ page (write-back)</span>
        <button
          type="button"
          className="risk-chip clear"
          onClick={async () => {
            if (await dlg.confirm(`Revert all ${changes.length} local changes?`)) {
              for (const i of changes)
                onPatch(i.key, { sprint: null, assignee: null, effort: null });
            }
          }}
        >
          revert all
        </button>
      </h2>
      <div className="changes-panel">
        {changes.map((i) => (
          <div key={i.key} className="change-row">
            <button type="button" className="key-link" onClick={() => onOpenNote(i.path)}>
              {i.key}
            </button>
            <span className="change-diffs">
              {i.plan.sprint !== null && (
                <span className="change-diff">
                  <span className="load-committed">{i.jiraSprint ?? 'Backlog'}</span> →{' '}
                  <b className="load-planned">{i.plan.sprint}</b>
                </span>
              )}
              {i.plan.assignee !== null && (
                <span className="change-diff">
                  <span className="load-committed">{personName(board, i.jiraAssignee)}</span> →{' '}
                  <b className="load-planned">{personName(board, i.plan.assignee)}</b>
                </span>
              )}
              {i.plan.effort !== null && (
                <span className="change-diff">
                  effort <span className="load-committed">{i.estimate ?? '—'}</span> →{' '}
                  <b className="load-planned">{i.plan.effort}</b>
                </span>
              )}
              {i.plan.note && <span className="muted small">“{i.plan.note}”</span>}
            </span>
            <button
              type="button"
              className="risk-chip clear"
              title="Clear local sprint/assignee/effort for this issue"
              onClick={() => onPatch(i.key, { sprint: null, assignee: null, effort: null })}
            >
              revert
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
