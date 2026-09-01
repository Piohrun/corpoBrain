import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BoardIssue, BoardModel, PlanPatch } from '../api.ts';
import { nameColor, statusColor, statusTitle } from '../colors.ts';
import { lsGet, lsJson, lsSet, lsSetJson } from '../storage.ts';
import { EditableNumber } from './EditableNumber.tsx';
import { type GroupBy, personName, type Row, UNASSIGNED } from './planningShared.ts';

export function BandwidthGrid({
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
  const [backlogCollapsed, setBacklogCollapsed] = useState(
    () => lsGet('cb.plan.backlogCollapsed', 'true') === 'true',
  );
  useEffect(() => lsSet('cb.plan.backlogCollapsed', String(backlogCollapsed)), [backlogCollapsed]);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(lsJson<string[]>('cb.plan.groups', [])),
  );
  useEffect(() => lsSetJson('cb.plan.groups', [...collapsed]), [collapsed]);

  const rows = useMemo<Row[]>(() => {
    const known: Row[] = board.people
      .filter((p) => p.active)
      .map((p) => ({
        id: p.path,
        name: p.name,
        jiraId: p.jiraIds[0] ?? null,
        capacity: p.capacity,
        capacityIsDefault: p.capacityIsDefault,
        overrides: p.overrides,
        loadOverrides: p.loadOverrides ?? {},
        suggested: p.suggested ?? {},
        absence: p.absence ?? {},
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
      capacityIsDefault: false,
      overrides: {} as Record<string, number>,
      loadOverrides: {} as Record<string, number>,
      suggested: {} as Record<string, number>,
      absence: {} as Row['absence'],
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
        capacityIsDefault: false,
        overrides: {} as Record<string, number>,
        loadOverrides: {} as Record<string, number>,
        suggested: {} as Record<string, number>,
        absence: {} as Row['absence'],
        region: null,
        team: null,
        editable: false,
        path: null,
      },
    ];
  }, [board, issues]);

  /** explicit hub colors (people/<Region|Team>.md color:) override the hash hue */
  const hubColor = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of board.people) {
      if (p.color && (p.name === p.region || p.name === p.team)) map.set(p.name, p.color);
    }
    return (name: string | null) => (name && map.get(name)) || nameColor(name);
  }, [board]);

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
    // group order comes from the hub note's position in the notes tree
    const hubOrder = new Map<string, number>();
    for (const p of board.people) {
      if (p.sortOrder !== null) hubOrder.set(p.name.toLowerCase(), p.sortOrder);
    }
    const sortGroups = <T extends { label: string }>(list: T[]): T[] =>
      list.sort((a, b) => {
        if (a.label.startsWith('(') !== b.label.startsWith('('))
          return a.label.startsWith('(') ? 1 : -1;
        const oa = hubOrder.get(a.label.toLowerCase()) ?? Number.POSITIVE_INFINITY;
        const ob = hubOrder.get(b.label.toLowerCase()) ?? Number.POSITIVE_INFINITY;
        return oa - ob || a.label.localeCompare(b.label);
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
  }, [rows, groupBy, board.people]);

  const capOf = (row: Row, col: string): number | null =>
    col === 'Backlog' ? null : (row.overrides[col] ?? row.suggested[col] ?? row.capacity);

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
            {collapsed.has(key) ? '▸' : '▾'}{' '}
            {!label.startsWith('(') && (
              <span className="group-mark" style={{ background: hubColor(label) }} />
            )}
            {label} <span className="muted">({members.length})</span>
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

  /**
   * Whole-sprint presence, so a row reads at a glance: nobody home for the
   * sprint (leave/holiday every working day, or bandwidth pinned to 0) vs.
   * on the support rota for every day they are not off.
   */
  const presenceOf = (
    row: Row,
    col: string,
    cap: number | null,
  ): { cls: string; label: string; title: string } | null => {
    if (col === 'Backlog' || !row.editable) return null;
    const a = row.absence[col];
    const off = a ? a.ooo + (a.holiday ?? 0) : 0;
    if (a && a.total > 0 && off >= a.total) {
      return {
        cls: 'away-all',
        label: 'away',
        title: `${row.name} is away for the whole of ${col} (${a.ooo}d leave, ${a.holiday ?? 0}d holiday)`,
      };
    }
    if (a && a.total > 0 && a.support > 0 && off + a.support >= a.total) {
      return {
        cls: 'support-only',
        label: off > 0 ? `support · ${off}d away` : 'support',
        title: `${row.name} is on the support rota for every working day of ${col} they are not away (${a.support}d support, ${off}d off)`,
      };
    }
    if (cap === 0) {
      return {
        cls: 'away-all',
        label: 'no bandwidth',
        title: `${row.name} has 0 ${board.unit} for ${col}`,
      };
    }
    return null;
  };

  const memberRow = (row: Row) => (
    <tr key={row.id}>
      <td className="person-cell">
        <div>
          <span
            className="region-mark"
            style={{ background: hubColor(row.region) }}
            title={row.region ?? 'no region'}
          />
          {row.path ? (
            <button
              type="button"
              className="person-link"
              title="Open person overview"
              onClick={() => onOpenNote(row.path as string)}
            >
              {row.name}
            </button>
          ) : (
            row.name
          )}
        </div>
        {row.editable && row.path && (
          <div className="muted small">
            <EditableNumber
              value={row.capacity}
              dimmed={row.capacityIsDefault}
              title={
                row.capacityIsDefault
                  ? 'Inherited from the vault default — click to set explicitly'
                  : 'Default capacity per sprint'
              }
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
        const collapsedCol = col === 'Backlog' && backlogCollapsed;
        const cellCards = cellIssues.get(cKey) ?? [];
        const presence = presenceOf(row, col, cap);
        return (
          <td
            key={col}
            className={`bw-cell${cls}${collapsedCol ? ' backlog-col' : ''}${
              presence ? ` ${presence.cls}` : ''
            }`}
            title={presence?.title}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(row, col)}
          >
            {presence && <span className={`bw-presence ${presence.cls}`}>{presence.label}</span>}
            <div className="cell-load">
              {row.editable && row.path ? (
                <span>
                  {committedLoad !== plannedLoad && (
                    <>
                      <span className="load-committed">{committedLoad}</span>
                      {' → '}
                    </>
                  )}
                  <EditableNumber
                    variant="load"
                    value={loadOverridden ? (row.loadOverrides[col] as number) : null}
                    fallback={computedPlanned}
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
                    placeholder={
                      row.suggested[col] !== undefined
                        ? `✈ ${row.suggested[col]}`
                        : row.capacity !== null
                          ? String(row.capacity)
                          : '—'
                    }
                    title={
                      row.absence[col]
                        ? `${row.name} is away ${row.absence[col]?.ooo ?? 0}d + ${
                            row.absence[col]?.support ?? 0
                          }d support in ${col}: bandwidth ${row.capacity} → ${row.suggested[col]}. Type a number to override.`
                        : `Bandwidth override for ${col} (empty = default)`
                    }
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
            {collapsedCol ? (
              cellCards.length > 0 && (
                <div className="muted small backlog-count" title="Expand via the Backlog header">
                  {cellCards.length} card{cellCards.length === 1 ? '' : 's'}
                </div>
              )
            ) : (
              <div className="chips">
                {cellCards.map((i) => {
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
                      title={`${statusTitle(i.status, i.statusCategory)} — ${i.summary ?? ''}${
                        moved
                          ? `\nUNCOMMITTED: Jira has ${i.jiraSprint ?? 'Backlog'} / ${personName(board, i.jiraAssignee)}`
                          : ''
                      }${i.riskFlags.length ? `\nflags: ${i.riskFlags.join(', ')}` : ''}`}
                    >
                      <span
                        className="status-dot"
                        style={{ background: statusColor(i.status, i.statusCategory) }}
                      />
                      {i.key}
                      {i.effectiveEffort !== null && (
                        <span className="chip-effort">{i.effectiveEffort}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
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
                if (c === 'Backlog') {
                  return (
                    <th key={c} className={backlogCollapsed ? 'backlog-col' : ''}>
                      <button
                        type="button"
                        className="group-toggle"
                        title={
                          backlogCollapsed ? 'Expand backlog cards' : 'Collapse backlog to counts'
                        }
                        onClick={() => setBacklogCollapsed((v) => !v)}
                      >
                        {backlogCollapsed ? '▸' : '▾'} Backlog
                      </button>
                    </th>
                  );
                }
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
        <span className="load-planned">jira → planned</span> when they differ. Status:{' '}
        <span className="color-legend">
          <span>
            <span className="status-dot" style={{ background: 'var(--st-todo)' }} />
            to&nbsp;do
          </span>
          <span>
            <span className="status-dot" style={{ background: 'var(--st-progress)' }} />
            in&nbsp;progress
          </span>
          <span>
            <span className="status-dot" style={{ background: 'var(--st-ready)' }} />
            ready/review
          </span>
          <span>
            <span className="status-dot" style={{ background: 'var(--st-done)' }} />
            done
          </span>
        </span>
        . Fold with the ▾ toggles.
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

/**
 * Click-to-edit number. `fallback` is what shows (and what the input starts
 * from) while no explicit value is set; the load variant renders it bold with
 * a pencil once overridden, the capacity variant as a muted placeholder.
 */
