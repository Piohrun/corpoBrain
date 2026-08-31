import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type BoardModel,
  type ProjectSummary,
  planApi,
  projectApi,
  type TimelineModel,
} from '../api.ts';
import { useVaultEvents } from '../hooks.ts';

const DAY_PX = 22;
const ROW_H = 38;
const BLOCK_H = 24;
const SPRINT_DAYS_FALLBACK = 10;

function workingDays(start: string | null, end: string | null): number {
  if (!start || !end) return SPRINT_DAYS_FALLBACK;
  const from = new Date(start);
  const to = new Date(end);
  // a sprint end with no time means the end of that day
  if (!to.getUTCHours() && !to.getUTCMinutes() && !to.getUTCSeconds()) {
    to.setUTCDate(to.getUTCDate() + 1);
  }
  if (!(to > from)) return SPRINT_DAYS_FALLBACK;
  let n = 0;
  const cur = new Date(from);
  while (cur < to) {
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n || SPRINT_DAYS_FALLBACK;
}

const shortDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/** Projects: rollups on the left, a draggable capacity-aware timeline on the right. */
export function ProjectsPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [untagged, setUntagged] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [model, setModel] = useState<TimelineModel | null>(null);
  const [mode, setMode] = useState<'plan' | 'forecast'>('plan');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

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
    (key: string, body: Parameters<typeof planApi.patchIssue>[1]) => {
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
            No projects yet. Create one, then tag issues by epic, label, or by hand.
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
              {p.forecastSprint ? ` · lands ${p.forecastSprint}` : ''}
            </span>
            {(p.violations > 0 || p.unestimated > 0 || p.unassigned > 0) && (
              <span className="proj-meta warn">
                {p.violations > 0 && `⚠ ${p.violations} dependency `}
                {p.unestimated > 0 && `? ${p.unestimated} unestimated `}
                {p.unassigned > 0 && `👤 ${p.unassigned} unassigned`}
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
            {projects.length ? 'Loading…' : 'Create a project to see its timeline.'}
          </div>
        ) : (
          <>
            <div className="planning-header">
              <span className="title">{model.project.title}</span>
              <div className="digest-ranges">
                <button
                  type="button"
                  className={`tab${mode === 'plan' ? ' active' : ''}`}
                  onClick={() => setMode('plan')}
                  title="Where the work sits today"
                >
                  Plan
                </button>
                <button
                  type="button"
                  className={`tab${mode === 'forecast' ? ' active' : ''}`}
                  onClick={() => setMode('forecast')}
                  title="Where capacity and dependencies actually put it"
                >
                  Forecast
                </button>
              </div>
              <span className="spacer" />
              <span className="health-stat">
                {model.project.done}/{model.project.issues} done · {model.project.remainingEffort}{' '}
                {model.unit} left
              </span>
              {model.forecast.finishSprint && (
                <span className="health-stat">
                  lands <b>{model.forecast.finishSprint}</b>
                  {model.forecast.finishDate ? ` (${model.forecast.finishDate})` : ''}
                </span>
              )}
              {model.project.target && (
                <span
                  className={`health-stat${
                    model.forecast.finishDate && model.forecast.finishDate > model.project.target
                      ? ' bad'
                      : ''
                  }`}
                >
                  target {model.project.target}
                </span>
              )}
              <button type="button" className="plan-btn" onClick={() => setAdding((a) => !a)}>
                + issues
              </button>
              <button
                type="button"
                className="plan-btn"
                onClick={() => onOpenNote(model.project.path)}
              >
                note
              </button>
            </div>

            {(model.forecast.violations.length > 0 || model.forecast.cycles.length > 0) && (
              <div className="proj-warnings">
                {model.forecast.violations.map((v) => (
                  <span key={`${v.key}:${v.blocker}`} className="digest-chip k-reopened">
                    ⚠ {v.detail}
                  </span>
                ))}
                {model.forecast.cycles.map((c) => (
                  <span key={c.join()} className="digest-chip k-reopened">
                    ⟳ dependency cycle: {c.join(' → ')}
                  </span>
                ))}
              </div>
            )}

            {adding && <AddIssues project={model.project.title} onTag={patch} />}

            <Timeline model={model} mode={mode} onOpenNote={onOpenNote} onPatch={patch} />
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

function Timeline({
  model,
  mode,
  onOpenNote,
  onPatch,
}: {
  model: TimelineModel;
  mode: 'plan' | 'forecast';
  onOpenNote: (path: string) => void;
  onPatch: (key: string, body: { sprint?: string; assignee?: string | null }) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [hover, setHover] = useState<{ row: string; sprint: string } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const bands = useMemo(() => {
    let left = 0;
    return model.sprints.map((s) => {
      const days = workingDays(s.start, s.end);
      const band = { ...s, days, left, width: days * DAY_PX };
      left += band.width;
      return band;
    });
  }, [model.sprints]);
  const totalWidth = bands.reduce((w, b) => w + b.width, 0);

  const blocks = mode === 'plan' ? model.planBlocks : model.forecastBlocks;
  const rows = model.rows;
  const bandOf = (name: string) => bands.find((b) => b.name === name);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bandOf is derived from bands
  const positioned = useMemo(
    () =>
      blocks
        .map((b) => {
          const band = bandOf(b.sprint);
          const row = rows.findIndex((r) => r.assignee === b.assignee);
          if (!band || row < 0) return null;
          return {
            block: b,
            row,
            x: band.left + b.offsetDays * DAY_PX,
            w: Math.max(b.days * DAY_PX, 12),
            y: row * ROW_H + (ROW_H - BLOCK_H) / 2,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [blocks, bands, rows],
  );

  const byKey = new Map(positioned.map((p) => [p.block.key, p]));
  const arrows = positioned.flatMap((p) =>
    p.block.blockedBy
      .map((dep) => {
        const from = byKey.get(dep);
        if (!from) return null;
        return {
          id: `${dep}->${p.block.key}`,
          x1: from.x + from.w,
          y1: from.y + BLOCK_H / 2,
          x2: p.x,
          y2: p.y + BLOCK_H / 2,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null),
  );

  const sprintAt = (clientX: number): string | null => {
    const el = trackRef.current;
    if (!el) return null;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return (
      bands.find((b) => x >= b.left && x < b.left + b.width)?.name ?? bands.at(-1)?.name ?? null
    );
  };

  const drop = (e: React.DragEvent, assignee: string) => {
    e.preventDefault();
    const key = dragKey ?? e.dataTransfer.getData('text/plain');
    setDragKey(null);
    setHover(null);
    if (!key) return;
    const sprint = sprintAt(e.clientX);
    const body: { sprint?: string; assignee?: string | null } = {};
    if (sprint) body.sprint = sprint;
    body.assignee = assignee === '(unassigned)' ? null : assignee;
    onPatch(key, body);
  };

  return (
    <div className="planning-scroll">
      <div className="timeline">
        <div className="tl-side">
          <div className="tl-corner" />
          {rows.map((r) => (
            <div className="tl-row-head" key={r.assignee} style={{ height: ROW_H }}>
              {r.color && <i className="proj-dot" style={{ background: r.color }} />}
              <button
                type="button"
                className="key-link"
                onClick={() => r.path && onOpenNote(r.path)}
                disabled={!r.path}
              >
                {r.name}
              </button>
            </div>
          ))}
        </div>

        <div className="tl-track" ref={trackRef}>
          <div className="tl-head" style={{ width: totalWidth }}>
            {bands.map((b) => (
              <div
                key={b.name}
                className={`tl-band-head${b.state === 'active' ? ' current' : ''}`}
                style={{ width: b.width }}
              >
                <b>{b.name}</b>
                <span className="small muted">
                  {shortDate(b.start)}
                  {b.end ? `–${shortDate(b.end)}` : ''}
                </span>
              </div>
            ))}
          </div>

          <div className="tl-grid" style={{ width: totalWidth, height: rows.length * ROW_H }}>
            {bands.map((b) => (
              <div
                key={b.name}
                className={`tl-band${b.state === 'active' ? ' current' : ''}`}
                style={{ left: b.left, width: b.width }}
              />
            ))}
            {rows.map((r, i) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: drop target for the timeline; the blocks themselves are buttons
              <div
                key={r.assignee}
                className={`tl-row${hover?.row === r.assignee ? ' drop' : ''}`}
                style={{ top: i * ROW_H, height: ROW_H }}
                onDragOver={(e) => {
                  if (mode !== 'plan') return;
                  e.preventDefault();
                  const sprint = sprintAt(e.clientX);
                  if (sprint) setHover({ row: r.assignee, sprint });
                }}
                onDrop={(e) => mode === 'plan' && drop(e, r.assignee)}
              />
            ))}
            {arrows.length > 0 && (
              <svg
                className="tl-arrows"
                width={totalWidth}
                height={rows.length * ROW_H}
                aria-hidden="true"
              >
                <title>dependencies</title>
                {arrows.map((a) => (
                  <path
                    key={a.id}
                    d={`M ${a.x1} ${a.y1} C ${a.x1 + 18} ${a.y1}, ${a.x2 - 18} ${a.y2}, ${a.x2} ${a.y2}`}
                  />
                ))}
              </svg>
            )}
            {positioned.map(({ block, x, w, y }) => (
              <button
                type="button"
                key={block.key}
                className={`tl-block st-${block.statusCategory ?? 'new'}${
                  block.overflow ? ' overflow' : ''
                }${block.slipped ? ' slipped' : ''}${block.estimated ? '' : ' noest'}`}
                style={{ left: x, width: w, top: y, height: BLOCK_H }}
                draggable={mode === 'plan'}
                onDragStart={(e) => {
                  setDragKey(block.key);
                  e.dataTransfer.setData('text/plain', block.key);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => {
                  setDragKey(null);
                  setHover(null);
                }}
                onClick={() => onOpenNote(block.path)}
                title={`${block.key} — ${block.summary ?? ''}\n${block.days} days${
                  block.estimated ? '' : ' (no estimate)'
                }${block.overflow ? '\nruns past this sprint’s bandwidth' : ''}${
                  block.slipped ? `\nforecast moves it from ${block.plannedSprint}` : ''
                }`}
              >
                <span className="tl-key">{block.key}</span>
                <span className="tl-sum">{block.summary}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {model.backlog.length > 0 && (
        <section>
          <h2 className="plan-h2">Not scheduled ({model.backlog.length})</h2>
          <div className="tl-backlog">
            {model.backlog.map((b) => (
              <button
                type="button"
                key={b.key}
                className={`tl-block static st-${b.statusCategory ?? 'new'}`}
                draggable={mode === 'plan'}
                onDragStart={(e) => {
                  setDragKey(b.key);
                  e.dataTransfer.setData('text/plain', b.key);
                }}
                onClick={() => onOpenNote(b.path)}
                title={`${b.key} — ${b.summary ?? ''}`}
              >
                <span className="tl-key">{b.key}</span>
                <span className="tl-sum">{b.summary}</span>
              </button>
            ))}
          </div>
          <p className="muted small">Drag one onto a person’s row to plan it into that sprint.</p>
        </section>
      )}
    </div>
  );
}

// --------------------------------------------------------------- tag issues

function AddIssues({
  project,
  onTag,
}: {
  project: string;
  onTag: (key: string, body: { project: string }) => void;
}) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    planApi
      .board()
      .then(setBoard)
      .catch(() => {});
  }, []);

  const matches = useMemo(() => {
    if (!board) return [];
    const needle = q.trim().toLowerCase();
    return board.issues
      .filter((i) => i.statusCategory !== 'done' && i.plan.project !== project)
      .filter(
        (i) =>
          !needle ||
          i.key.toLowerCase().includes(needle) ||
          (i.summary ?? '').toLowerCase().includes(needle) ||
          (i.epic ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 40);
  }, [board, q, project]);

  return (
    <div className="proj-add">
      <input
        className="plan-filter"
        placeholder="find issues by key, summary or epic…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="proj-add-list">
        {matches.map((i) => (
          <button
            type="button"
            key={i.key}
            className="proj-add-row"
            onClick={() => onTag(i.key, { project })}
            title={`Tag ${i.key} into ${project}`}
          >
            <b>{i.key}</b> {i.summary}
            {i.epic && <span className="muted small"> · {i.epic}</span>}
          </button>
        ))}
        {board && matches.length === 0 && <span className="muted small">no matches</span>}
      </div>
    </div>
  );
}
