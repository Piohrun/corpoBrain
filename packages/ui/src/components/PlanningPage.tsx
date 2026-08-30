import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BoardIssue,
  type BoardModel,
  type JiraStatus,
  type PlanPatch,
  planApi,
} from '../api.ts';
import { useVaultEvents } from '../hooks.ts';

interface Props {
  onOpenNote: (path: string) => void;
}

const UNASSIGNED = '(unassigned)';

export function PlanningPage({ onOpenNote }: Props) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    planApi
      .board()
      .then(setBoard)
      .catch((e: Error) => setError(e.message));
    planApi
      .jiraStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(() => refresh());

  const patch = useCallback(
    (key: string, p: PlanPatch) => {
      planApi
        .patchIssue(key, p)
        .then(refresh)
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const sync = useCallback(() => {
    setSyncing(true);
    setError(null);
    planApi
      .jiraSync()
      .then(refresh)
      .catch((e: Error) => setError(e.message))
      .finally(() => setSyncing(false));
  }, [refresh]);

  const issues = useMemo(() => {
    if (!board) return [];
    const q = filter.trim().toLowerCase();
    return board.issues
      .filter((i) => i.statusCategory !== 'done')
      .filter(
        (i) =>
          !q ||
          i.key.toLowerCase().includes(q) ||
          (i.summary ?? '').toLowerCase().includes(q) ||
          (i.effectiveAssignee ?? '').toLowerCase().includes(q) ||
          (i.plan.bucket ?? '').toLowerCase().includes(q),
      )
      .filter((i) => !flagFilter || i.riskFlags.includes(flagFilter));
  }, [board, filter, flagFilter]);

  if (!board) {
    return (
      <div className="planning">
        <div className="empty-state">{error ? `Failed to load board: ${error}` : 'Loading…'}</div>
      </div>
    );
  }

  const flagCounts = new Map<string, number>();
  for (const i of board.issues) {
    if (i.statusCategory === 'done') continue;
    for (const f of i.riskFlags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  }

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Planning</span>
        <span className="muted">capacity in {board.unit}</span>
        <input
          className="plan-filter"
          placeholder="Filter issues…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        {status?.lastSynced && (
          <span className="muted">synced {status.lastSynced.slice(0, 16).replace('T', ' ')}</span>
        )}
        <button type="button" className="plan-btn" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Jira'}
        </button>
      </div>

      {flagCounts.size > 0 && (
        <div className="risk-strip">
          {[...flagCounts.entries()].map(([flag, n]) => (
            <button
              type="button"
              key={flag}
              className={`risk-chip${flagFilter === flag ? ' active' : ''}`}
              onClick={() => setFlagFilter(flagFilter === flag ? null : flag)}
            >
              {flag} <b>{n}</b>
            </button>
          ))}
          {flagFilter && (
            <button type="button" className="risk-chip clear" onClick={() => setFlagFilter(null)}>
              ✕ clear
            </button>
          )}
        </div>
      )}

      <div className="planning-scroll">
        <BandwidthGrid board={board} issues={issues} onPatch={patch} onOpenNote={onOpenNote} />
        <SprintTable board={board} issues={issues} onPatch={patch} onOpenNote={onOpenNote} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- grid

function BandwidthGrid({
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
  const [dragKey, setDragKey] = useState<string | null>(null);

  const rows = useMemo(() => {
    const known = board.people
      .filter((p) => p.active)
      .map((p) => ({
        id: p.path,
        name: p.name,
        jiraId: p.jiraIds[0] ?? null,
        capacity: p.capacity,
        overrides: p.overrides,
      }));
    const extra = Object.keys(board.loads)
      .filter((k) => k !== UNASSIGNED && !known.some((r) => r.id === k))
      .map((id) => ({
        id,
        name: id,
        jiraId: id as string | null,
        capacity: null as number | null,
        overrides: {} as Record<string, number>,
      }));
    return [
      ...known,
      ...extra,
      {
        id: UNASSIGNED,
        name: 'Unassigned',
        jiraId: null as string | null,
        capacity: null as number | null,
        overrides: {} as Record<string, number>,
      },
    ];
  }, [board]);

  const issuesFor = (rowId: string, col: string): BoardIssue[] => {
    const row = rows.find((r) => r.id === rowId);
    return issues.filter((i) => {
      if (i.effectiveSprint !== col) return false;
      if (rowId === UNASSIGNED) return !i.effectiveAssignee;
      if (!i.effectiveAssignee) return false;
      const person = board.people.find((p) => p.path === rowId);
      return person
        ? person.jiraIds.includes(i.effectiveAssignee)
        : i.effectiveAssignee === row?.jiraId;
    });
  };

  const drop = (rowId: string, col: string) => {
    if (!dragKey) return;
    const row = rows.find((r) => r.id === rowId);
    const patch: PlanPatch = { sprint: col };
    if (rowId === UNASSIGNED) patch.assignee = null;
    else if (row?.jiraId) patch.assignee = row.jiraId;
    onPatch(dragKey, patch);
    setDragKey(null);
  };

  return (
    <section>
      <h2 className="plan-h2">Team bandwidth</h2>
      <div className="grid-wrap">
        <table className="bw-grid">
          <thead>
            <tr>
              <th>Person</th>
              {board.columns.map((c) => {
                const sprint = board.sprints.find((s) => s.name === c);
                return (
                  <th key={c}>
                    {c}
                    {sprint?.state === 'active' && <span className="badge-active">active</span>}
                    {sprint?.end && (
                      <div className="muted small">ends {sprint.end.slice(0, 10)}</div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="person-cell">
                  <div>{row.name}</div>
                  {row.capacity !== null && (
                    <div className="muted small">
                      {row.capacity} {board.unit}/sprint
                    </div>
                  )}
                </td>
                {board.columns.map((col) => {
                  const load = board.loads[row.id]?.[col] ?? 0;
                  const cap = col === 'Backlog' ? null : (row.overrides[col] ?? row.capacity);
                  const pct = cap ? load / cap : null;
                  const cls = pct === null ? '' : pct > 1 ? ' over' : pct > 0.85 ? ' warn' : ' ok';
                  return (
                    <td
                      key={col}
                      className={`bw-cell${cls}`}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => drop(row.id, col)}
                    >
                      <div className="cell-load">
                        {load > 0 && <b>{load}</b>}
                        {cap !== null && <span className="muted"> / {cap}</span>}
                        {pct !== null && pct > 1 && <span className="over-flag"> over</span>}
                      </div>
                      {cap !== null && (
                        <div className="cap-bar">
                          <div
                            className="cap-fill"
                            style={{ width: `${Math.min(100, (pct ?? 0) * 100)}%` }}
                          />
                        </div>
                      )}
                      <div className="chips">
                        {issuesFor(row.id, col).map((i) => (
                          <button
                            type="button"
                            key={i.key}
                            className={`chip${i.overridden.sprint || i.overridden.assignee ? ' overridden' : ''}${i.riskFlags.length ? ' risky' : ''}`}
                            draggable
                            onDragStart={() => setDragKey(i.key)}
                            onDragEnd={() => setDragKey(null)}
                            onClick={() => onOpenNote(i.path)}
                            title={`${i.summary ?? ''}${i.riskFlags.length ? `\nflags: ${i.riskFlags.join(', ')}` : ''}`}
                          >
                            {i.key}
                            {i.effectiveEffort !== null && (
                              <span className="chip-effort">{i.effectiveEffort}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Drag a card into a cell to plan it locally (writes <code>plan.sprint</code> /{' '}
        <code>plan.assignee</code> — Jira is never modified). Dashed border = locally overridden.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ table

function SprintTable({
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
                    className="cell-input rank"
                    type="number"
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
                <td className="muted">{i.status}</td>
                <td>
                  <input
                    className="cell-input effort"
                    type="number"
                    step="0.5"
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
                    className="cell-input note"
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
