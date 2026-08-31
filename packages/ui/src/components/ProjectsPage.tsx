import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type BoardModel,
  type CalendarModel,
  type PlanPatch,
  type ProjectSummary,
  planApi,
  projectApi,
} from '../api.ts';
import { useVaultEvents } from '../hooks.ts';

const DAY = 22; // px per workday — one tiny box per day
const ROW = 34;
const HEAD = 54;

const shortDate = (iso: string | null): string =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    : '';

/** Projects: rollup cards on the left, the day-grid calendar on the right. */
export function ProjectsPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [untagged, setUntagged] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [model, setModel] = useState<CalendarModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    projectApi
      .list()
      .then((r) => {
        setProjects(r.projects);
        setUntagged(r.untagged);
        setSelected((cur) => cur ?? r.projects[0]?.path ?? null);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const loadTimeline = useCallback(() => {
    if (!selected) return setModel(null);
    projectApi
      .timeline(selected)
      .then(setModel)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  useEffect(loadList, [loadList]);
  useEffect(loadTimeline, [loadTimeline]);
  useVaultEvents(() => {
    loadList();
    loadTimeline();
  });

  const refresh = useCallback(() => {
    loadList();
    loadTimeline();
  }, [loadList, loadTimeline]);

  const patch = useCallback(
    (key: string, body: PlanPatch) => {
      planApi
        .patchIssue(key, body)
        .then(refresh)
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const createProject = () => {
    const title = window.prompt('Project name');
    if (!title?.trim()) return;
    projectApi
      .create(title.trim())
      .then((r) => {
        setSelected(r.path);
        loadList();
        onOpenNote(r.path);
      })
      .catch((e: Error) => setError(e.message));
  };

  const arrange = () => {
    if (!model || !selected) return;
    if (
      !window.confirm(
        'Auto-arrange writes a start day into every scheduled issue of this project (vault only, nothing goes to Jira). Continue?',
      )
    )
      return;
    projectApi
      .arrange(selected)
      .then(refresh)
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="projects">
      <aside className="proj-list">
        <div className="proj-list-head">
          <span className="title">Projects</span>
          <button type="button" className="plan-btn" onClick={createProject} title="New project">
            +
          </button>
        </div>
        {projects.length === 0 && (
          <p className="health-empty">
            No projects yet. Create one, then tag issues by epic, label, or straight from the
            calendar.
          </p>
        )}
        {projects.map((p) => (
          <button
            type="button"
            key={p.path}
            className={`proj-card${selected === p.path ? ' active' : ''}`}
            onClick={() => setSelected(p.path)}
          >
            <span className="proj-card-title">
              {p.color && <i className="proj-dot" style={{ background: p.color }} />}
              {p.title}
            </span>
            <span className="proj-bar" title={`${p.doneEffort} of ${p.effort} done`}>
              <i style={{ width: `${p.effort ? (p.doneEffort / p.effort) * 100 : 0}%` }} />
            </span>
            <span className="proj-meta">
              {p.done}/{p.issues} issues
              {p.forecastDate ? ` · lands ${shortDate(p.forecastDate)}` : ''}
            </span>
            {(p.conflicts > 0 || p.lateDeps > 0 || p.unestimated > 0 || p.unassigned > 0) && (
              <span className="proj-meta warn">
                {p.conflicts > 0 && `▣ ${p.conflicts} overlap `}
                {p.lateDeps > 0 && `⚠ ${p.lateDeps} dep `}
                {p.unestimated > 0 && `? ${p.unestimated} unest `}
                {p.unassigned > 0 && `👤 ${p.unassigned}`}
              </span>
            )}
          </button>
        ))}
        {untagged > 0 && (
          <p className="proj-untagged">
            {untagged} open issue{untagged === 1 ? '' : 's'} in no project
          </p>
        )}
      </aside>

      <div className="proj-main">
        {error && <div className="plan-error">{error}</div>}
        {!model ? (
          <div className="empty-state">
            {projects.length ? 'Loading…' : 'Create a project to see its calendar.'}
          </div>
        ) : (
          <>
            <div className="planning-header">
              <span className="title">{model.project.title}</span>
              <span className="health-stat">
                {model.project.done}/{model.project.issues} done · {model.project.remainingEffort}{' '}
                {model.unit} left
              </span>
              {model.finishDate && (
                <span
                  className={`health-stat${
                    model.target && model.finishDate > model.target ? ' bad' : ''
                  }`}
                  title="Earliest finish if work runs in dependency order within everyone's free days"
                >
                  lands <b>{shortDate(model.finishDate)}</b>
                  {model.target ? ` · target ${shortDate(model.target)}` : ''}
                </span>
              )}
              <span className="spacer" />
              <RosterButton model={model} onSaved={refresh} onError={setError} />
              <button
                type="button"
                className="plan-btn"
                onClick={arrange}
                title="Compute a dependency- and absence-aware schedule and pin every block to it"
              >
                ✨ auto-arrange
              </button>
              <button
                type="button"
                className="plan-btn"
                onClick={() => onOpenNote(model.project.path)}
              >
                note
              </button>
            </div>

            {model.warnings.length > 0 && (
              <div className="proj-warnings">
                {model.warnings.map((w) => (
                  <span key={w} className="digest-chip k-reopened">
                    ⚠ {w}
                  </span>
                ))}
              </div>
            )}

            <Calendar model={model} onOpenNote={onOpenNote} onPatch={patch} />
          </>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- the calendar

interface Drag {
  key: string;
  width: number;
  grab: number; // days between pointer and block start
  day: number;
  row: number;
  moved: boolean;
  mode: 'move' | 'resize';
  fromRail: boolean;
  origin: { day: number; row: number };
  path: string;
}

function Calendar({
  model,
  onOpenNote,
  onPatch,
}: {
  model: CalendarModel;
  onOpenNote: (path: string) => void;
  onPatch: (key: string, body: PlanPatch) => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const [search, setSearch] = useState<{
    day: number;
    row: number;
    cx: number;
    cy: number;
  } | null>(null);

  const width = model.days.length * DAY;
  const height = Math.max(model.rows.length, 8) * ROW;
  const rowIndex = useMemo(() => new Map(model.rows.map((r, i) => [r.assignee, i])), [model.rows]);
  const mondays = useMemo(
    () =>
      model.days
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1)
        .map(({ i }) => i),
    [model.days],
  );

  const sprintAt = useCallback(
    (day: number): string | null =>
      model.sprints.find((s) => day >= s.from && day < s.from + s.span)?.name ?? null,
    [model.sprints],
  );

  const pointToCell = useCallback((e: PointerEvent | React.PointerEvent) => {
    const el = bodyRef.current;
    if (!el) return { day: 0, row: 0 };
    const rect = el.getBoundingClientRect();
    return {
      day: Math.floor((e.clientX - rect.left) / DAY),
      row: Math.floor((e.clientY - rect.top) / ROW),
    };
  }, []);

  // window-level move/up so dragging works from the rail and past the edges
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const { day, row } = pointToCell(e);
      setDrag((d) => {
        if (!d) return d;
        const nd = Math.max(
          0,
          Math.min(day - (d.mode === 'move' ? d.grab : 0), model.days.length - 1),
        );
        const nr = Math.max(0, Math.min(row, model.rows.length - 1));
        const moved = d.moved || nd !== d.origin.day || (d.mode === 'move' && nr !== d.origin.row);
        return { ...d, day: nd, row: nr, moved };
      });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (!d.moved) {
        if (!d.fromRail && d.path) onOpenNote(d.path);
        return;
      }
      if (d.mode === 'resize') {
        const w = Math.max(1, d.day - d.origin.day + 1);
        if (w !== d.width) onPatch(d.key, { effort: w });
        return;
      }
      const body: PlanPatch = { start: model.days[d.day] ?? null };
      const targetRow = model.rows[d.row];
      const sourceRow = model.rows[d.origin.row];
      const rowChanged = d.fromRail || targetRow?.assignee !== sourceRow?.assignee;
      if (rowChanged && targetRow) {
        if (targetRow.assignee === '(unassigned)') body.assignee = null;
        else if (targetRow.jiraId) body.assignee = targetRow.jiraId;
        // a row for a person with no Jira id cannot hold an assignee yet — only the day moves
      }
      const sprint = sprintAt(d.day);
      if (sprint && (d.fromRail || sprint !== sprintAt(d.origin.day))) body.sprint = sprint;
      onPatch(d.key, body);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, model, onOpenNote, onPatch, pointToCell, sprintAt]);

  const startDrag = (
    e: React.PointerEvent,
    block: { key: string; start: number; span: number; assignee: string; path: string },
    mode: 'move' | 'resize',
    fromRail = false,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { day } = pointToCell(e);
    const row = rowIndex.get(block.assignee) ?? model.rows.length - 1;
    setDrag({
      key: block.key,
      width: block.span,
      grab: fromRail ? 0 : day - block.start,
      day: fromRail ? Math.max(day, 0) : block.start,
      row,
      moved: false,
      mode,
      fromRail,
      origin: { day: mode === 'resize' ? block.start : fromRail ? day : block.start, row },
      path: block.path,
    });
  };

  const onBackgroundUp = (e: React.PointerEvent) => {
    if (dragRef.current) return; // a drag is being committed
    if ((e.target as HTMLElement).closest('.cal-block')) return;
    const { day, row } = pointToCell(e);
    if (day < 0 || day >= model.days.length || row < 0) return;
    setSearch({
      day,
      row: Math.min(row, model.rows.length - 1),
      cx: e.clientX,
      cy: e.clientY,
    });
  };

  const ghostW = (d: Drag) =>
    d.mode === 'resize' ? Math.max(1, d.day - d.origin.day + 1) * DAY : d.width * DAY;

  return (
    <div className="planning-scroll">
      <div className="cal">
        <div className="cal-side" style={{ paddingTop: HEAD }}>
          {model.rows.map((r) => (
            <div className="cal-row-head" key={r.assignee} style={{ height: ROW }}>
              {r.color && <i className="proj-dot" style={{ background: r.color }} />}
              <button
                type="button"
                className="key-link"
                onClick={() => r.path && onOpenNote(r.path)}
                disabled={!r.path}
              >
                {r.name}
              </button>
              {r.inRoster && (
                <span className="cal-roster-mark" title="On the project roster">
                  •
                </span>
              )}
              {!r.jiraId && r.assignee !== '(unassigned)' && (
                <span
                  className="muted small"
                  title="This person note has no Jira id yet — set one (Organize panel) to drop issues on this row"
                >
                  ⚭
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="cal-track">
          <div className="cal-head" style={{ width }}>
            <div className="cal-months">
              {model.months.map((m) => (
                <span
                  key={`${m.label}${m.from}`}
                  style={{ left: m.from * DAY, width: m.span * DAY }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <div className="cal-sprints">
              {model.sprints.map((s) => (
                <span
                  key={s.name}
                  className={s.state === 'active' ? 'current' : ''}
                  style={{ left: s.from * DAY, width: s.span * DAY }}
                  title={s.name}
                >
                  {s.name}
                </span>
              ))}
            </div>
            <div className="cal-days">
              {model.days.map((d, i) => (
                <span
                  key={d}
                  className={mondays.includes(i) ? 'monday' : ''}
                  style={{ left: i * DAY, width: DAY }}
                >
                  {Number(d.slice(8))}
                </span>
              ))}
            </div>
          </div>

          <div
            ref={bodyRef}
            className="cal-body"
            style={{ width, height }}
            onPointerUp={onBackgroundUp}
          >
            {mondays.map((i) => (
              <i key={i} className="cal-week" style={{ left: i * DAY }} />
            ))}
            {model.sprints.map((s) => (
              <i
                key={s.name}
                className={`cal-sprint-band${s.state === 'active' ? ' current' : ''}`}
                style={{ left: s.from * DAY, width: s.span * DAY }}
              />
            ))}
            {model.today !== null && (
              <i className="cal-today" style={{ left: model.today * DAY }} title="today" />
            )}
            {model.rows.map((r, ri) => (
              <div key={r.assignee} className="cal-row" style={{ top: ri * ROW, height: ROW }}>
                {r.ooo.map((d) => (
                  <i key={`o${d}`} className="cal-away ooo" style={{ left: d * DAY, width: DAY }} />
                ))}
                {r.support.map((d) => (
                  <i
                    key={`s${d}`}
                    className="cal-away support"
                    style={{ left: d * DAY, width: DAY }}
                  />
                ))}
              </div>
            ))}
            {model.blocks.map((b) => {
              const ri = rowIndex.get(b.assignee) ?? model.rows.length - 1;
              const dragging = drag?.key === b.key;
              return (
                <button
                  type="button"
                  key={b.key}
                  className={`cal-block st-${b.statusCategory ?? 'new'}${b.conflict ? ' conflict' : ''}${
                    b.lateDeps.length ? ' latedep' : ''
                  }${b.estimated ? '' : ' noest'}${b.pinned ? '' : ' flowing'}${
                    dragging ? ' dragging' : ''
                  }`}
                  style={{
                    left: b.start * DAY,
                    width: b.span * DAY - 2,
                    top: ri * ROW + 4,
                    height: ROW - 8,
                  }}
                  onPointerDown={(e) => startDrag(e, b, 'move')}
                  title={`${b.key} — ${b.summary ?? ''}\n${b.workDays}d${b.estimated ? '' : ' (no estimate)'}${
                    b.awayDays
                      ? `, stretched over ${b.awayDays} away day${b.awayDays === 1 ? '' : 's'}`
                      : ''
                  }${b.pinned ? `\npinned to ${model.days[b.start] ?? ''}` : '\nflowing (no start pinned yet)'}${
                    b.conflict ? '\n▣ overlaps another block on this row' : ''
                  }${b.lateDeps.length ? `\n⚠ starts before ${b.lateDeps.join(', ')} finishes` : ''}\ndrag to move · drag edge to resize · click to open`}
                >
                  {b.clamped && <span className="cal-clamp">◂</span>}
                  <span className="tl-key">{b.key}</span>
                  {b.span * DAY > 90 && <span className="tl-sum">{b.summary}</span>}
                  <span
                    className="cal-resize"
                    onPointerDown={(e) => startDrag(e, b, 'resize')}
                    title="Drag to change the planned effort"
                  />
                </button>
              );
            })}
            {drag?.moved && (
              <div
                className="cal-ghost"
                style={{
                  left: (drag.mode === 'resize' ? drag.origin.day : drag.day) * DAY,
                  width: ghostW(drag),
                  top: (drag.mode === 'resize' ? drag.origin.row : drag.row) * ROW + 4,
                  height: ROW - 8,
                }}
              >
                {drag.mode === 'resize'
                  ? `${Math.max(1, drag.day - drag.origin.day + 1)}d`
                  : `${model.days[drag.day] ?? ''}`}
              </div>
            )}
          </div>
        </div>
      </div>

      {search &&
        createPortal(
          <IssueSearch
            model={model}
            at={search}
            onClose={() => setSearch(null)}
            onPick={(key, body) => {
              setSearch(null);
              onPatch(key, body);
            }}
          />,
          document.body,
        )}

      {model.rail.length > 0 && (
        <section>
          <h2 className="plan-h2">Not on the calendar ({model.rail.length})</h2>
          <div className="tl-backlog">
            {model.rail.map((b) => (
              <button
                type="button"
                key={b.key}
                className={`cal-block static${b.estimated ? '' : ' noest'}`}
                style={{ width: Math.max(b.days * DAY, 70) }}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    { key: b.key, start: 0, span: b.days, assignee: '(unassigned)', path: b.path },
                    'move',
                    true,
                  )
                }
                title={`${b.key} — ${b.summary ?? ''}\n${b.days}d · drag onto the grid to schedule`}
              >
                <span className="tl-key">{b.key}</span>
                <span className="tl-sum">{b.summary}</span>
              </button>
            ))}
          </div>
          <p className="muted small">
            Drag onto a person's row to schedule · click an empty day to search all of Jira.
          </p>
        </section>
      )}
    </div>
  );
}

// -------------------------------------------------- click-a-day issue search

function IssueSearch({
  model,
  at,
  onClose,
  onPick,
}: {
  model: CalendarModel;
  at: { day: number; row: number; cx: number; cy: number };
  onClose: () => void;
  onPick: (key: string, body: PlanPatch) => void;
}) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    planApi
      .board()
      .then(setBoard)
      .catch(() => {});
    inputRef.current?.focus();
  }, []);

  const inProject = useMemo(() => new Set(model.blocks.map((b) => b.key)), [model.blocks]);
  const matches = useMemo(() => {
    if (!board) return [];
    const needle = q.trim().toLowerCase();
    return board.issues
      .filter((i) => i.statusCategory !== 'done' && !inProject.has(i.key))
      .filter(
        (i) =>
          !needle ||
          i.key.toLowerCase().includes(needle) ||
          (i.summary ?? '').toLowerCase().includes(needle) ||
          (i.epic ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 25);
  }, [board, q, inProject]);

  const row = model.rows[at.row];
  const day = model.days[at.day];
  const sprint = model.sprints.find((s) => at.day >= s.from && at.day < s.from + s.span)?.name;

  const pick = (key: string, alreadyInProject: boolean) => {
    const body: PlanPatch = { start: day ?? null };
    if (!alreadyInProject) body.project = model.project.title;
    if (row?.jiraId) body.assignee = row.jiraId;
    if (sprint) body.sprint = sprint;
    onPick(key, body);
  };

  const left = Math.max(8, Math.min(at.cx, window.innerWidth - 344));
  const top = Math.max(8, Math.min(at.cy + 6, window.innerHeight - 380));

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away backdrop; Escape works too */}
      <div className="cal-search-backdrop" onPointerDown={onClose} />
      <div
        className="cal-search floating"
        style={{ left, top }}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <div className="cal-search-head">
          <b>{row?.name}</b> · {shortDate(day ?? null)}
          {sprint ? ` · ${sprint}` : ''}
          <span className="spacer" />
          <button type="button" className="row-del" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          ref={inputRef}
          className="plan-filter"
          placeholder="find a jira by key or text…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && matches[0]) {
              const first = matches[0];
              pick(first.key, first.plan.project === model.project.title);
            }
          }}
        />
        <div className="proj-add-list">
          {matches.map((i) => (
            <button
              type="button"
              key={i.key}
              className="proj-add-row"
              onClick={() => pick(i.key, i.plan.project === model.project.title)}
            >
              <b>{i.key}</b> {i.summary}
              <span className="muted small">
                {i.effectiveEffort !== null ? ` · ${i.effectiveEffort}d` : ' · no estimate'}
                {i.epic ? ` · ${i.epic}` : ''}
              </span>
            </button>
          ))}
          {board && matches.length === 0 && <span className="muted small">no matches</span>}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------- roster

function RosterButton({
  model,
  onSaved,
  onError,
}: {
  model: CalendarModel;
  onSaved: () => void;
  onError: (e: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<BoardModel | null>(null);

  useEffect(() => {
    if (!open || board) return;
    planApi
      .board()
      .then(setBoard)
      .catch(() => {});
  }, [open, board]);

  const rosterNames = model.rows.filter((r) => r.inRoster).map((r) => r.name);
  const candidates = (board?.people ?? []).filter(
    (p) => p.active && !model.rows.some((r) => r.path === p.path),
  );

  const save = (names: string[]) => {
    projectApi
      .roster(model.project.path, names)
      .then(() => {
        setOpen(false);
        onSaved();
      })
      .catch((e: Error) => onError(e.message));
  };

  return (
    <span className="cal-roster">
      <button
        type="button"
        className="plan-btn"
        onClick={() => setOpen((o) => !o)}
        title="Add people to this project so they have a row before any issues are assigned"
      >
        + person
      </button>
      {open && (
        <div className="cal-search cal-roster-pop">
          <div className="cal-search-head">
            <b>Add to {model.project.title}</b>
            <span className="spacer" />
            <button type="button" className="row-del" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div className="proj-add-list">
            {candidates.map((p) => (
              <button
                type="button"
                key={p.path}
                className="proj-add-row"
                onClick={() => save([...rosterNames, p.name])}
              >
                {p.name}
                <span className="muted small">
                  {p.region ? ` · ${p.region}` : ''}
                  {p.team ? ` · ${p.team}` : ''}
                </span>
              </button>
            ))}
            {candidates.length === 0 && <span className="muted small">everyone is here</span>}
          </div>
          {rosterNames.length > 0 && (
            <div className="cal-roster-current">
              {rosterNames.map((n) => (
                <button
                  type="button"
                  key={n}
                  className="digest-chip"
                  title="Remove from the roster (their scheduled issues keep the row)"
                  onClick={() => save(rosterNames.filter((x) => x !== n))}
                >
                  {n} ✕
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
