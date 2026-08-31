import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BoardIssue,
  type BoardModel,
  type JiraStatus,
  type PlanPatch,
  planApi,
  type SavedView,
  viewApi,
} from '../api.ts';
import { useJiraSync, useVaultEvents } from '../hooks.ts';
import { SyncProgressBar } from './SyncProgressBar.tsx';

interface Props {
  onOpenNote: (path: string) => void;
}

const UNASSIGNED = '(unassigned)';
type GroupBy = 'region' | 'team' | 'region-team' | 'none';

function lsGet(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* unavailable */
  }
}

export function PlanningPage({ onOpenNote }: Props) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState<string | null>(null);
  const [sprintFilter, setSprintFilter] = useState<string | null>(null);

  const [views, setViews] = useState<SavedView[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>(
    () => lsGet('cb.plan.groupBy', 'region') as GroupBy,
  );
  const [horizon, setHorizon] = useState<number>(() => Number(lsGet('cb.plan.horizon', '3')));

  useEffect(() => lsSet('cb.plan.groupBy', groupBy), [groupBy]);
  useEffect(() => lsSet('cb.plan.horizon', String(horizon)), [horizon]);

  const refresh = useCallback(() => {
    planApi
      .board()
      .then(setBoard)
      .catch((e: Error) => setError(e.message));
    planApi
      .jiraStatus()
      .then(setStatus)
      .catch(() => {});
    viewApi
      .list()
      .then(setViews)
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

  const patchPerson = useCallback(
    (body: Parameters<typeof planApi.patchPerson>[0]) => {
      planApi
        .patchPerson(body)
        .then(refresh)
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const { syncing, status: syncStatus, start: sync, error: syncError } = useJiraSync(refresh);

  /** Visible sprint columns: first N sprints, Backlog always last. */
  const visibleColumns = useMemo(() => {
    if (!board) return [];
    const sprints = board.columns.filter((c) => c !== 'Backlog').slice(0, horizon);
    return [...sprints, 'Backlog'];
  }, [board, horizon]);

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
      .filter((i) => !flagFilter || i.riskFlags.includes(flagFilter))
      .filter((i) => !sprintFilter || i.effectiveSprint === sprintFilter);
  }, [board, filter, flagFilter, sprintFilter]);

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
  const maxSprints = board.columns.filter((c) => c !== 'Backlog').length;

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
        {syncError && <span className="plan-error">{syncError}</span>}
        <button type="button" className="plan-btn" onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Jira'}
        </button>
      </div>
      <SyncProgressBar status={syncStatus} />

      <div className="views-bar">
        <label className="muted small">
          group{' '}
          <select
            className="cell-input"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          >
            <option value="region">by region</option>
            <option value="team">by team</option>
            <option value="region-team">region ▸ team</option>
            <option value="none">flat</option>
          </select>
        </label>
        <label className="muted small">
          sprints{' '}
          <select
            className="cell-input"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {Array.from({ length: Math.max(maxSprints, 1) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} ahead
              </option>
            ))}
          </select>
        </label>
        <select
          className="cell-input"
          value={sprintFilter ?? ''}
          onChange={(e) => setSprintFilter(e.target.value || null)}
        >
          <option value="">all sprints</option>
          {board.columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        {views.map((v) => (
          <button
            type="button"
            key={v.path}
            className="risk-chip"
            title={v.path}
            onClick={() => {
              setFilter(v.filter.text ?? '');
              setFlagFilter(v.filter.flag ?? null);
              setSprintFilter(v.filter.sprint ?? null);
            }}
          >
            {v.title}
          </button>
        ))}
        {(filter || flagFilter || sprintFilter) && (
          <button
            type="button"
            className="risk-chip"
            onClick={() => {
              const title = window.prompt('Save current filter as view:');
              if (!title) return;
              viewApi
                .save(title, {
                  ...(filter ? { text: filter } : {}),
                  ...(flagFilter ? { flag: flagFilter } : {}),
                  ...(sprintFilter ? { sprint: sprintFilter } : {}),
                })
                .then(refresh)
                .catch((e: Error) => setError(e.message));
            }}
          >
            + save view
          </button>
        )}
        {flagCounts.size > 0 && <span className="views-sep" />}
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
      </div>

      <div className="planning-scroll">
        <BandwidthGrid
          board={board}
          issues={issues}
          columns={visibleColumns}
          groupBy={groupBy}
          onPatch={patch}
          onPatchPerson={patchPerson}
          onOpenNote={onOpenNote}
        />
        <ChangesPanel board={board} onPatch={patch} onOpenNote={onOpenNote} />
        <SprintTable board={board} issues={issues} onPatch={patch} onOpenNote={onOpenNote} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- helpers

interface Row {
  id: string;
  name: string;
  jiraId: string | null;
  capacity: number | null;
  overrides: Record<string, number>;
  loadOverrides: Record<string, number>;
  region: string | null;
  team: string | null;
  editable: boolean;
  path: string | null;
}

function personName(board: BoardModel, assignee: string | null): string {
  if (!assignee) return '—';
  return board.people.find((p) => p.jiraIds.includes(assignee))?.name ?? assignee;
}

// ------------------------------------------------------------------- grid

function BandwidthGrid({
  board,
  issues,
  columns,
  groupBy,
  onPatch,
  onPatchPerson,
  onOpenNote,
}: {
  board: BoardModel;
  issues: BoardIssue[];
  columns: string[];
  groupBy: GroupBy;
  onPatch: (key: string, p: PlanPatch) => void;
  onPatchPerson: (body: {
    path: string;
    capacity?: number | null;
    overrides?: Record<string, number>;
    loadOverrides?: Record<string, number>;
  }) => void;
  onOpenNote: (path: string) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(lsGet('cb.plan.groups', '[]')) as string[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => lsSet('cb.plan.groups', JSON.stringify([...collapsed])), [collapsed]);

  const rows = useMemo<Row[]>(() => {
    const known: Row[] = board.people
      .filter((p) => p.active)
      .map((p) => ({
        id: p.path,
        name: p.name,
        jiraId: p.jiraIds[0] ?? null,
        capacity: p.capacity,
        overrides: p.overrides,
        loadOverrides: p.loadOverrides ?? {},
        region: p.region,
        team: p.team,
        editable: true,
        path: p.path,
      }));
    const knownIds = new Set(board.people.flatMap((p) => p.jiraIds));
    const extraIds = new Set<string>();
    for (const i of issues) {
      const a = i.effectiveAssignee ?? i.jiraAssignee;
      if (a && !knownIds.has(a)) extraIds.add(a);
    }
    const extras: Row[] = [...extraIds].map((id) => ({
      id,
      name: id,
      jiraId: id as string | null,
      capacity: null as number | null,
      overrides: {} as Record<string, number>,
      loadOverrides: {} as Record<string, number>,
      region: null,
      team: null,
      editable: false,
      path: null,
    }));
    return [
      ...known,
      ...extras,
      {
        id: UNASSIGNED,
        name: 'Unassigned',
        jiraId: null as string | null,
        capacity: null as number | null,
        overrides: {} as Record<string, number>,
        loadOverrides: {} as Record<string, number>,
        region: null,
        team: null,
        editable: false,
        path: null,
      },
    ];
  }, [board, issues]);

  const rowIdOf = useCallback(
    (assignee: string | null): string => {
      if (!assignee) return UNASSIGNED;
      const person = board.people.find((p) => p.jiraIds.includes(assignee));
      return person ? person.path : assignee;
    },
    [board],
  );

  const colSet = useMemo(() => new Set(columns), [columns]);
  const colOf = useCallback(
    (sprint: string | null): string | null => {
      if (!sprint) return 'Backlog';
      return colSet.has(sprint) ? sprint : null;
    },
    [colSet],
  );

  const { committed, planned, cellIssues } = useMemo(() => {
    const committed = new Map<string, number>();
    const planned = new Map<string, number>();
    const cellIssues = new Map<string, BoardIssue[]>();
    const add = (m: Map<string, number>, k: string, v: number) =>
      m.set(k, Math.round(((m.get(k) ?? 0) + v) * 100) / 100);
    for (const i of issues) {
      const effort = i.effectiveEffort ?? 0;
      const cCol = colOf(i.jiraSprint);
      if (cCol) add(committed, `${rowIdOf(i.jiraAssignee)}|${cCol}`, effort);
      const pCol = colOf(i.effectiveSprint === 'Backlog' ? null : i.effectiveSprint);
      if (pCol) {
        const key = `${rowIdOf(i.effectiveAssignee)}|${pCol}`;
        add(planned, key, effort);
        const arr = cellIssues.get(key) ?? [];
        arr.push(i);
        cellIssues.set(key, arr);
      }
    }
    return { committed, planned, cellIssues };
  }, [issues, colOf, rowIdOf]);

  interface Sub {
    key: string;
    label: string;
    members: Row[];
  }
  interface Group {
    key: string;
    label: string;
    members: Row[];
    subs: Sub[] | null;
  }

  const groups = useMemo<Group[]>(() => {
    const misc = (r: Row) => r.id === UNASSIGNED || !r.editable;
    const sortGroups = <T extends { label: string }>(list: T[]): T[] =>
      list.sort((a, b) => {
        if (a.label.startsWith('(') !== b.label.startsWith('('))
          return a.label.startsWith('(') ? 1 : -1;
        return a.label.localeCompare(b.label);
      });
    const byKey = (rows: Row[], keyOf: (r: Row) => string): Map<string, Row[]> => {
      const m = new Map<string, Row[]>();
      for (const r of rows) {
        const k = keyOf(r);
        const arr = m.get(k) ?? [];
        arr.push(r);
        m.set(k, arr);
      }
      return m;
    };
    if (groupBy === 'none') return [{ key: 'all', label: '', members: rows, subs: null }];
    if (groupBy === 'region' || groupBy === 'team') {
      const keyOf = (r: Row) =>
        misc(r) ? '(other)' : ((groupBy === 'region' ? r.region : r.team) ?? `(no ${groupBy})`);
      return sortGroups(
        [...byKey(rows, keyOf).entries()].map(([label, members]) => ({
          key: `g:${label}`,
          label,
          members,
          subs: null,
        })),
      );
    }
    // region ▸ team: two collapsible levels
    const top = byKey(rows, (r) => (misc(r) ? '(other)' : (r.region ?? '(no region)')));
    return sortGroups(
      [...top.entries()].map(([label, members]) => {
        if (label === '(other)') return { key: 'g:(other)', label, members, subs: null };
        const subs = sortGroups(
          [...byKey(members, (r) => r.team ?? '(no team)').entries()].map(
            ([subLabel, subMembers]) => ({
              key: `g:${label}/${subLabel}`,
              label: subLabel,
              members: subMembers,
            }),
          ),
        );
        return { key: `g:${label}`, label, members, subs };
      }),
    );
  }, [rows, groupBy]);

  const capOf = (row: Row, col: string): number | null =>
    col === 'Backlog' ? null : (row.overrides[col] ?? row.capacity);

  /** effective used load: manual override wins over the issue-derived sum */
  const plannedOf = (row: Row, col: string): number =>
    row.loadOverrides[col] ?? planned.get(`${row.id}|${col}`) ?? 0;

  const drop = (row: Row, col: string) => {
    if (!dragKey) return;
    const patch: PlanPatch = { sprint: col };
    if (row.id === UNASSIGNED) patch.assignee = null;
    else if (row.jiraId) patch.assignee = row.jiraId;
    onPatch(dragKey, patch);
    setDragKey(null);
  };

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const aggRow = (key: string, label: string, members: Row[], sub: boolean) => {
    const sumCommitted = (col: string) =>
      Math.round(
        members.reduce((acc, r) => acc + (committed.get(`${r.id}|${col}`) ?? 0), 0) * 100,
      ) / 100;
    const sumPlanned = (col: string) =>
      Math.round(members.reduce((acc, r) => acc + plannedOf(r, col), 0) * 100) / 100;
    const capSum = (col: string) =>
      members.reduce<number | null>((acc, r) => {
        const c = capOf(r, col);
        if (c === null) return acc;
        return (acc ?? 0) + c;
      }, null);
    return (
      <tr key={key} className={sub ? 'group-row group-sub' : 'group-row'}>
        <td>
          <button type="button" className="group-toggle" onClick={() => toggle(key)}>
            {collapsed.has(key) ? '▸' : '▾'} {label}{' '}
            <span className="muted">({members.length})</span>
          </button>
        </td>
        {columns.map((col) => {
          const c = sumCommitted(col);
          const p = sumPlanned(col);
          const cap = capSum(col);
          const over = cap !== null && p > cap;
          return (
            <td key={col} className={`group-cell${over ? ' over' : ''}`}>
              <LoadLine committedLoad={c} plannedLoad={p} cap={cap} />
            </td>
          );
        })}
      </tr>
    );
  };

  const memberRow = (row: Row) => (
    <tr key={row.id}>
      <td className="person-cell">
        <div>{row.name}</div>
        {row.editable && row.path && (
          <div className="muted small">
            <EditableNumber
              value={row.capacity}
              title="Default capacity per sprint"
              onCommit={(v) => onPatchPerson({ path: row.path as string, capacity: v })}
            />{' '}
            {board.unit}/sprint
          </div>
        )}
      </td>
      {columns.map((col) => {
        const cKey = `${row.id}|${col}`;
        const committedLoad = committed.get(cKey) ?? 0;
        const computedPlanned = planned.get(cKey) ?? 0;
        const loadOverridden = row.loadOverrides[col] !== undefined;
        const plannedLoad = plannedOf(row, col);
        const cap = capOf(row, col);
        const pct = cap ? plannedLoad / cap : null;
        const cls = pct === null ? '' : pct > 1 ? ' over' : pct > 0.85 ? ' warn' : ' ok';
        return (
          <td
            key={col}
            className={`bw-cell${cls}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(row, col)}
          >
            <div className="cell-load">
              {row.editable && row.path ? (
                <span>
                  {committedLoad !== plannedLoad && (
                    <>
                      <span className="load-committed">{committedLoad}</span>
                      {' → '}
                    </>
                  )}
                  <EditableLoad
                    value={loadOverridden ? (row.loadOverrides[col] as number) : null}
                    computed={computedPlanned}
                    title={
                      loadOverridden
                        ? `Manual used-load override (Jira-derived would be ${computedPlanned}); empty restores`
                        : 'Click to override the used load for this sprint (BAU, meetings, non-Jira work)'
                    }
                    onCommit={(v) => {
                      const loadOverrides = { ...row.loadOverrides };
                      if (v === null) delete loadOverrides[col];
                      else loadOverrides[col] = v;
                      onPatchPerson({ path: row.path as string, loadOverrides });
                    }}
                  />
                  {cap !== null && <span className="muted"> / {cap}</span>}
                  {cap !== null && plannedLoad > cap && <span className="over-flag"> over</span>}
                </span>
              ) : (
                <LoadLine committedLoad={committedLoad} plannedLoad={plannedLoad} cap={cap} />
              )}
              {row.editable && row.path && col !== 'Backlog' && (
                <span className="cap-edit">
                  <EditableNumber
                    value={row.overrides[col] ?? null}
                    placeholder={row.capacity !== null ? String(row.capacity) : '—'}
                    title={`Bandwidth override for ${col} (empty = default)`}
                    onCommit={(v) => {
                      const overrides = { ...row.overrides };
                      if (v === null) delete overrides[col];
                      else overrides[col] = v;
                      onPatchPerson({ path: row.path as string, overrides });
                    }}
                  />
                </span>
              )}
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
              {(cellIssues.get(cKey) ?? []).map((i) => {
                const moved = i.overridden.sprint || i.overridden.assignee;
                return (
                  <button
                    type="button"
                    key={i.key}
                    className={`chip${moved ? ' overridden' : ''}${i.riskFlags.length ? ' risky' : ''}`}
                    draggable
                    onDragStart={() => setDragKey(i.key)}
                    onDragEnd={() => setDragKey(null)}
                    onClick={() => onOpenNote(i.path)}
                    title={`${i.summary ?? ''}${
                      moved
                        ? `\nUNCOMMITTED: Jira has ${i.jiraSprint ?? 'Backlog'} / ${personName(board, i.jiraAssignee)}`
                        : ''
                    }${i.riskFlags.length ? `\nflags: ${i.riskFlags.join(', ')}` : ''}`}
                  >
                    {i.key}
                    {i.effectiveEffort !== null && (
                      <span className="chip-effort">{i.effectiveEffort}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </td>
        );
      })}
    </tr>
  );

  return (
    <section>
      <h2 className="plan-h2">Team bandwidth</h2>
      <div className="grid-wrap">
        <table className="bw-grid">
          <thead>
            <tr>
              <th>Person</th>
              {columns.map((c) => {
                const sprint = board.sprints.find((s) => s.name === c);
                return (
                  <th key={c}>
                    {c}
                    {sprint?.state === 'active' && <span className="badge-active">active</span>}
                    {sprint?.source === 'local' && <span className="sprint-badge">local</span>}
                    {sprint?.end && (
                      <div className="muted small">ends {sprint.end.slice(0, 10)}</div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <FragmentGroup key={g.key}>
                {g.label && aggRow(g.key, g.label, g.members, false)}
                {(!g.label || !collapsed.has(g.key)) &&
                  (g.subs
                    ? g.subs.map((sub) => (
                        <FragmentGroup key={sub.key}>
                          {aggRow(sub.key, sub.label, sub.members, true)}
                          {!collapsed.has(sub.key) && sub.members.map(memberRow)}
                        </FragmentGroup>
                      ))
                    : g.members.map(memberRow))}
              </FragmentGroup>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Drag a card to plan it locally (dashed = uncommitted, Jira is never modified). Click a
        capacity number to adjust bandwidth for that sprint; loads render{' '}
        <span className="load-planned">jira → planned</span> when they differ. Fold regions and
        teams with the ▾ toggles.
      </p>
    </section>
  );
}

function FragmentGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function LoadLine({
  committedLoad,
  plannedLoad,
  cap,
}: {
  committedLoad: number;
  plannedLoad: number;
  cap: number | null;
}) {
  const differs = committedLoad !== plannedLoad;
  return (
    <span>
      {differs ? (
        <>
          <span className="load-committed">{committedLoad}</span>
          {' → '}
          <b className="load-planned">{plannedLoad}</b>
        </>
      ) : (
        plannedLoad > 0 && <b>{plannedLoad}</b>
      )}
      {cap !== null && <span className="muted"> / {cap}</span>}
      {cap !== null && plannedLoad > cap && <span className="over-flag"> over</span>}
    </span>
  );
}

function EditableLoad({
  value,
  computed,
  title,
  onCommit,
}: {
  /** the override, or null when following the computed value */
  value: number | null;
  computed: number;
  title: string;
  onCommit: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        className={`load-edit${value !== null ? ' load-overridden' : ''}`}
        title={title}
        onClick={() => setEditing(true)}
      >
        <b className="load-planned">{value ?? computed}</b>
        {value !== null && <span className="load-pencil">✎</span>}
      </button>
    );
  }
  return (
    <input
      className="cap-input"
      type="number"
      step="0.5"
      ref={(el) => el?.focus()}
      defaultValue={value ?? computed}
      onBlur={(e) => {
        setEditing(false);
        const v = e.target.value === '' ? null : Number(e.target.value);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

function EditableNumber({
  value,
  placeholder,
  title,
  onCommit,
}: {
  value: number | null;
  placeholder?: string;
  title?: string;
  onCommit: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        type="button"
        className="cap-value"
        title={title ?? 'Click to edit'}
        onClick={() => setEditing(true)}
      >
        {value ?? placeholder ?? '—'}
      </button>
    );
  }
  return (
    <input
      className="cap-input"
      type="number"
      step="0.5"
      ref={(el) => el?.focus()}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      onBlur={(e) => {
        setEditing(false);
        const v = e.target.value === '' ? null : Number(e.target.value);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}

// ------------------------------------------------------------ changes

function ChangesPanel({
  board,
  onPatch,
  onOpenNote,
}: {
  board: BoardModel;
  onPatch: (key: string, p: PlanPatch) => void;
  onOpenNote: (path: string) => void;
}) {
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
        <span className="muted small">local only — Jira is untouched</span>
        <button
          type="button"
          className="risk-chip clear"
          onClick={() => {
            if (window.confirm(`Revert all ${changes.length} local changes?`)) {
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
