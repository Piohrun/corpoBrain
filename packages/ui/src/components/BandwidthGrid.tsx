import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BoardIssue, BoardModel, PlanPatch } from '../api.ts';
import { nameColor, statusColor, statusTitle } from '../colors.ts';
import { lsGet, lsJson, lsSet, lsSetJson } from '../storage.ts';
import { EditableNumber } from './EditableNumber.tsx';
import { type GroupBy, personName, type Row, UNASSIGNED } from './planningShared.ts';
import {
  boundedColumnWidth,
  ColumnResizeHandle,
  usePersistentColumnWidths,
} from './resizableColumns.tsx';

const BANDWIDTH_WIDTHS_KEY = 'cb.plan.bandwidthColumnWidths.v1';
const PERSON_WIDTH = { fallback: 160, min: 120, max: 360 };
const SPRINT_WIDTH = { fallback: 190, min: 120, max: 520 };
const BACKLOG_FALLBACK_WIDTH = 140;

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
  const {
    widths: columnWidths,
    setWidth: setColumnWidth,
    resetWidth: resetColumnWidth,
    resetAll: resetColumnWidths,
  } = usePersistentColumnWidths(BANDWIDTH_WIDTHS_KEY);
  const gridWrapRef = useRef<HTMLDivElement>(null);
  const [gridViewportWidth, setGridViewportWidth] = useState(0);
  useEffect(() => {
    const element = gridWrapRef.current;
    if (!element) return;
    const measure = () => setGridViewportWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const personColumnWidth = boundedColumnWidth(
    columnWidths.person,
    PERSON_WIDTH.fallback,
    PERSON_WIDTH.min,
    PERSON_WIDTH.max,
  );
  const sprintCount = columns.filter((column) => column !== 'Backlog').length;
  const responsiveSprintFallback =
    gridViewportWidth > 0 && sprintCount > 0
      ? Math.max(
          SPRINT_WIDTH.fallback,
          (gridViewportWidth - PERSON_WIDTH.fallback - BACKLOG_FALLBACK_WIDTH) / sprintCount,
        )
      : SPRINT_WIDTH.fallback;
  const sprintColumnWidth = (column: string) =>
    boundedColumnWidth(
      columnWidths[`sprint:${column}`],
      column === 'Backlog' ? BACKLOG_FALLBACK_WIDTH : responsiveSprintFallback,
      SPRINT_WIDTH.min,
      SPRINT_WIDTH.max,
    );
  const tableWidth =
    personColumnWidth + columns.reduce((total, column) => total + sprintColumnWidth(column), 0);

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

  /** Every affected sprint gets a cue; whole-sprint absence remains stronger. */
  const availabilityOf = (
    row: Row,
    col: string,
    cap: number | null,
  ): { cls: string; label: string; title: string } | null => {
    if (col === 'Backlog' || !row.editable) return null;
    const a = row.absence[col];
    const off = a ? a.ooo + (a.holiday ?? 0) : 0;
    const support = a?.support ?? 0;
    if (a && (off > 0 || support > 0)) {
      const wholeSprintAway = a.total > 0 && off >= a.total;
      const supportEveryAvailableDay =
        !wholeSprintAway && a.total > 0 && support > 0 && off + support >= a.total;
      const labels = [
        a.ooo > 0 ? `${a.ooo}d OOO` : '',
        (a.holiday ?? 0) > 0 ? `${a.holiday}d holiday` : '',
        support > 0 ? `${support}d support` : '',
      ].filter(Boolean);
      const classes = [
        'has-availability',
        off > 0 ? 'has-away' : '',
        support > 0 ? 'has-support' : '',
        wholeSprintAway ? 'away-all' : '',
        supportEveryAvailableDay ? 'support-only' : '',
      ].filter(Boolean);
      return {
        cls: classes.join(' '),
        label: wholeSprintAway ? 'away' : labels.join(' · '),
        title: `${row.name} · ${col}: ${labels.join(', ')}. Effective availability ${a.available}/${a.total} working days.`,
      };
    }
    if (cap === 0) {
      return {
        cls: 'has-availability no-bandwidth',
        label: 'no bandwidth',
        title: `${row.name} has 0 ${board.unit} for ${col}`,
      };
    }
    return null;
  };

  const memberRow = (row: Row) => {
    const visibleAvailability = columns.reduce(
      (summary, col) => {
        if (col === 'Backlog') return summary;
        const a = row.absence[col];
        if (!a) return summary;
        summary.ooo += a.ooo;
        summary.holiday += a.holiday ?? 0;
        summary.support += a.support;
        if (a.ooo > 0 || (a.holiday ?? 0) > 0 || a.support > 0) {
          const parts = [
            a.ooo > 0 ? `${a.ooo}d OOO` : '',
            (a.holiday ?? 0) > 0 ? `${a.holiday}d holiday` : '',
            a.support > 0 ? `${a.support}d support` : '',
          ].filter(Boolean);
          summary.details.push(`${col}: ${parts.join(', ')}`);
        }
        return summary;
      },
      { ooo: 0, holiday: 0, support: 0, details: [] as string[] },
    );
    const away = visibleAvailability.ooo + visibleAvailability.holiday;
    const personClasses = [
      away > 0 ? 'has-away' : '',
      visibleAvailability.support > 0 ? 'has-support' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <tr
        key={row.id}
        className={`bw-person-row ${personClasses}`}
        data-person-id={row.path ?? row.id}
      >
        <td
          className={`person-cell ${personClasses}`}
          title={
            visibleAvailability.details.length ? visibleAvailability.details.join('\n') : undefined
          }
        >
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
          {visibleAvailability.details.length > 0 && (
            <div className="person-availability">
              {visibleAvailability.ooo > 0 && (
                <span className="avail-chip ooo">{visibleAvailability.ooo}d OOO</span>
              )}
              {visibleAvailability.holiday > 0 && (
                <span className="avail-chip holiday">{visibleAvailability.holiday}d holiday</span>
              )}
              {visibleAvailability.support > 0 && (
                <span className="avail-chip support">{visibleAvailability.support}d support</span>
              )}
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
          const availability = availabilityOf(row, col, cap);
          return (
            <td
              key={col}
              className={`bw-cell${cls}${collapsedCol ? ' backlog-col' : ''}${
                availability ? ` ${availability.cls}` : ''
              }`}
              title={availability?.title}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(row, col)}
            >
              {availability && (
                <span className={`bw-presence ${availability.cls}`}>{availability.label}</span>
              )}
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
                        availability
                          ? `${availability.title} Bandwidth ${row.capacity} → ${row.suggested[col]}. Type a number to override.`
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
  };

  return (
    <section>
      <div className="plan-section-title">
        <h2 className="plan-h2">Team bandwidth</h2>
        <span className="muted small">Drag header dividers to resize</span>
        {Object.keys(columnWidths).length > 0 && (
          <button type="button" className="column-reset" onClick={resetColumnWidths}>
            Reset widths
          </button>
        )}
      </div>
      <div className="grid-wrap bw-wrap" ref={gridWrapRef}>
        <table className="bw-grid resizable-grid" style={{ width: tableWidth }}>
          <colgroup>
            <col style={{ width: personColumnWidth }} />
            {columns.map((column) => (
              <col key={column} style={{ width: sprintColumnWidth(column) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="resizable-head">
                Person
                <ColumnResizeHandle
                  label="Person"
                  width={personColumnWidth}
                  min={PERSON_WIDTH.min}
                  max={PERSON_WIDTH.max}
                  onResize={(width) => setColumnWidth('person', width)}
                  onReset={() => resetColumnWidth('person')}
                />
              </th>
              {columns.map((c) => {
                const sprint = board.sprints.find((s) => s.name === c);
                const widthKey = `sprint:${c}`;
                const width = sprintColumnWidth(c);
                if (c === 'Backlog') {
                  return (
                    <th
                      key={c}
                      className={`resizable-head${backlogCollapsed ? ' backlog-col' : ''}`}
                    >
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
                      <ColumnResizeHandle
                        label="Backlog"
                        width={width}
                        min={SPRINT_WIDTH.min}
                        max={SPRINT_WIDTH.max}
                        onResize={(next) => setColumnWidth(widthKey, next)}
                        onReset={() => resetColumnWidth(widthKey)}
                      />
                    </th>
                  );
                }
                return (
                  <th key={c} className="resizable-head">
                    {c}
                    {sprint?.state === 'active' && <span className="badge-active">active</span>}
                    {sprint?.source === 'local' && <span className="sprint-badge">local</span>}
                    {sprint?.end && (
                      <div className="muted small">ends {sprint.end.slice(0, 10)}</div>
                    )}
                    <ColumnResizeHandle
                      label={c}
                      width={width}
                      min={SPRINT_WIDTH.min}
                      max={SPRINT_WIDTH.max}
                      onResize={(next) => setColumnWidth(widthKey, next)}
                      onReset={() => resetColumnWidth(widthKey)}
                    />
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
        . Availability is called out on each person and affected sprint. Fold with the ▾ toggles.
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
