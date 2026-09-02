import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { type FlowIssue, type FlowSprint, flowApi } from '../api.ts';
import { lsGet, lsSet } from '../storage.ts';
import {
  boundedColumnWidth,
  ColumnResizeHandle,
  usePersistentColumnWidths,
} from './resizableColumns.tsx';

const WINDOWS = [30, 90, 180];
const FLOW_WIDTHS_KEY = 'cb.plan.flowColumnWidths.v1';
const FLOW_COLUMNS = [
  { id: 'issue', label: 'Issue', fallback: 90, min: 72, max: 220 },
  { id: 'summary', label: 'Summary / owner', fallback: 250, min: 140, max: 620 },
  { id: 'elapsed', label: 'Age / cycle', fallback: 350, min: 160, max: 720 },
  { id: 'history', label: 'Status history', fallback: 140, min: 90, max: 420 },
  { id: 'details', label: 'Timing', fallback: 190, min: 130, max: 420 },
] as const;

const fmtDays = (d: number | null): string => (d === null ? '—' : `${Math.round(d * 10) / 10}d`);
const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * Flow: how long work really takes, from the Jira changelog. Aging open work
 * is shown against the team's own recent percentiles so "is this one stuck?"
 * has a number behind it; scope churn shows what the sprint absorbed. Team
 * and issue level; the per-person split is opt-in and off by default.
 */
export function FlowPanel({
  sprints,
  sprint,
  onSprint,
  onOpenNote,
  reloadKey,
}: {
  sprints: string[];
  sprint: string;
  onSprint: (s: string) => void;
  onOpenNote: (path: string) => void;
  reloadKey: number;
}) {
  const [data, setData] = useState<FlowSprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(() => Number(lsGet('cb.flow.days', '90')));
  const [byPerson, setByPerson] = useState(false);
  const {
    widths: flowColumnWidths,
    setWidth: setFlowColumnWidth,
    resetWidth: resetFlowColumnWidth,
    resetAll: resetFlowColumnWidths,
  } = usePersistentColumnWidths(FLOW_WIDTHS_KEY);
  const [flowViewportWidth, setFlowViewportWidth] = useState(0);
  const stopFlowMeasure = useRef<() => void>(() => {});
  const flowGridRef = useCallback((element: HTMLDivElement | null) => {
    stopFlowMeasure.current();
    stopFlowMeasure.current = () => {};
    if (!element) return;
    const measure = () => setFlowViewportWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      stopFlowMeasure.current = () => window.removeEventListener('resize', measure);
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    stopFlowMeasure.current = () => observer.disconnect();
  }, []);

  const load = useCallback(() => {
    flowApi
      .sprint(sprint || undefined, { days, byPerson })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [sprint, days, byPerson]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the external refresh trigger
  useEffect(load, [load, reloadKey]);
  useEffect(() => lsSet('cb.flow.days', String(days)), [days]);
  useEffect(() => () => stopFlowMeasure.current(), []);

  if (error) return <section className="health-empty">Flow: {error}</section>;
  if (!data) return <section className="health-empty">Reading history…</section>;

  const ref = data.reference;
  const p85 = ref.cycle.p85 ?? null;
  const p50 = ref.cycle.p50 ?? null;
  const scale = Math.max(p85 ?? 0, ...data.open.map((o) => o.times.ageDays ?? 0), 1) * 1.15;
  const noHistory =
    ref.cycle.n === 0 && data.open.every((o) => o.bands.length <= 1) && data.done.length === 0;
  const flowBaseWidth =
    FLOW_COLUMNS.reduce((total, column) => total + column.fallback, 0) +
    (FLOW_COLUMNS.length - 1) * 10;
  const elapsedFill = Math.max(0, flowViewportWidth - flowBaseWidth);
  const resolvedFlowColumns = FLOW_COLUMNS.map((column) => ({
    ...column,
    width: boundedColumnWidth(
      flowColumnWidths[column.id],
      column.fallback + (column.id === 'elapsed' ? elapsedFill : 0),
      column.min,
      column.max,
    ),
  }));
  const flowGridWidth =
    resolvedFlowColumns.reduce((total, column) => total + column.width, 0) +
    (resolvedFlowColumns.length - 1) * 10;
  const flowGridStyle = {
    '--flow-columns': resolvedFlowColumns.map((column) => `${column.width}px`).join(' '),
    '--flow-grid-min': `${flowGridWidth}px`,
  } as CSSProperties;

  return (
    <section className="health flow">
      <div className="health-head">
        <select
          className="cell-input health-sprint"
          value={data.sprint.name}
          onChange={(e) => onSprint(e.target.value)}
        >
          {sprints.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="health-stat" title="Cycle time: first In Progress → Done, calendar days">
          cycle p50 <b>{fmtDays(p50)}</b> · p85 <b>{fmtDays(p85)}</b>
        </span>
        <span className="health-stat" title="Lead time: created → Done, calendar days">
          lead p50 <b>{fmtDays(ref.lead.p50)}</b> · p85 <b>{fmtDays(ref.lead.p85)}</b>
        </span>
        <span className="muted small">
          from {ref.cycle.n} issue{ref.cycle.n === 1 ? '' : 's'} finished in the last
        </span>
        <select
          className="cell-input"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="reference window"
        >
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              {w} days
            </option>
          ))}
        </select>
        <span className="spacer" />
        <label
          className="plan-label muted small"
          title="Team-level by default; this splits the finished work by assignee"
        >
          <input
            type="checkbox"
            checked={byPerson}
            onChange={(e) => setByPerson(e.target.checked)}
          />{' '}
          by person
        </label>
        <button type="button" className="plan-btn" onClick={load} title="Re-read">
          ↻
        </button>
      </div>

      {noHistory && (
        <p className="health-empty">
          No transition history yet. Run a Jira sync (a full re-sync backfills every issue's
          changelog), then this page fills in.
        </p>
      )}

      {(data.open.length > 0 || data.done.length > 0) && (
        <div className="flow-grid-scroll" ref={flowGridRef}>
          <div className="flow-grid-canvas" style={flowGridStyle}>
            <div className="flow-legend muted small">
              <span className="flow-legend-group">
                Age / cycle:
                <i className="flow-legend-swatch normal" />{' '}
                {p50 === null ? 'elapsed (no baseline yet)' : 'within p50'}
                <i className="flow-legend-swatch warn" /> past p50
                <i className="flow-legend-swatch late" /> past p85
              </span>
              <span className="flow-legend-group">
                Status history:
                <i className="flow-legend-swatch todo" /> to do / other
                <i className="flow-legend-swatch progress" /> in progress
                <i className="flow-legend-swatch done" /> done
              </span>
              <span>Hover a bar segment for its status, dates, and duration.</span>
              <span className="spacer" />
              {Object.keys(flowColumnWidths).length > 0 && (
                <button type="button" className="column-reset" onClick={resetFlowColumnWidths}>
                  Reset widths
                </button>
              )}
            </div>
            <div className="flow-row flow-column-head">
              {resolvedFlowColumns.map((column) => (
                <div key={column.id}>
                  {column.label}
                  <ColumnResizeHandle
                    label={`Flow ${column.label}`}
                    width={column.width}
                    min={column.min}
                    max={column.max}
                    onResize={(width) => setFlowColumnWidth(column.id, width)}
                    onReset={() => resetFlowColumnWidth(column.id)}
                  />
                </div>
              ))}
            </div>

            {data.open.length > 0 && (
              <>
                <h3 className="flow-h3">
                  Aging work in progress
                  <span className="muted small">
                    {' '}
                    — age since first In Progress, against the team's p50 / p85
                  </span>
                </h3>
                <div className="flow-rows">
                  {data.open.map((o) => (
                    <FlowRow
                      key={o.key}
                      issue={o}
                      onOpenNote={onOpenNote}
                      bar={o.times.ageDays}
                      scale={scale}
                      p50={p50}
                      p85={p85}
                      right={
                        o.times.ageDays === null
                          ? `not started · ${fmtDays(o.times.inStatusDays)} in ${o.status ?? '?'}`
                          : `${fmtDays(o.times.ageDays)} old · ${fmtDays(o.times.inStatusDays)} in ${o.status ?? '?'}`
                      }
                    />
                  ))}
                </div>
              </>
            )}

            {data.done.length > 0 && (
              <>
                <h3 className="flow-h3">
                  Finished in this sprint <span className="muted small">({data.done.length})</span>
                </h3>
                <div className="flow-rows">
                  {data.done.map((o) => (
                    <FlowRow
                      key={o.key}
                      issue={o}
                      onOpenNote={onOpenNote}
                      bar={o.times.cycleDays}
                      scale={scale}
                      p50={p50}
                      p85={p85}
                      right={`cycle ${fmtDays(o.times.cycleDays)} · lead ${fmtDays(o.times.leadDays)}`}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {(data.churn.added.length > 0 ||
        data.churn.removed.length > 0 ||
        data.churn.reestimated.length > 0) && (
        <>
          <h3 className="flow-h3">Scope changes during the sprint</h3>
          <div className="flow-churn">
            {data.churn.added.map((a) => (
              <span key={`a${a.key}${a.at}`} className="digest-chip k-created" title={a.by ?? ''}>
                + {a.key} added {shortDate(a.at)}
              </span>
            ))}
            {data.churn.removed.map((r) => (
              <span key={`r${r.key}${r.at}`} className="digest-chip k-reopened" title={r.by ?? ''}>
                − {r.key} pulled {shortDate(r.at)}
                {r.to ? ` → ${r.to}` : ''}
              </span>
            ))}
            {data.churn.reestimated.map((r) => (
              <span key={`e${r.key}${r.at}`} className="digest-chip" title={r.by ?? ''}>
                ≈ {r.key} {r.from ?? '—'} → {r.to ?? '—'} {shortDate(r.at)}
              </span>
            ))}
          </div>
        </>
      )}

      {ref.timeInStatus.length > 0 && (
        <>
          <h3 className="flow-h3">
            Where the time goes{' '}
            <span className="muted small">
              — average days per status, finished work, last {data.windowDays} days
            </span>
          </h3>
          <div className="flow-rows">
            {ref.timeInStatus.map((t) => {
              const top = ref.timeInStatus[0]?.avgDays ?? 1;
              return (
                <div key={t.status} className="flow-row">
                  <span className="flow-key">{t.status}</span>
                  <span className="flow-bar-wrap">
                    <i
                      className="flow-bar status"
                      style={{ width: `${(t.avgDays / top) * 100}%` }}
                    />
                  </span>
                  <span className="flow-right muted small">{fmtDays(t.avgDays)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {data.people && data.people.length > 0 && (
        <>
          <h3 className="flow-h3">
            By person <span className="muted small">— finished work in the window</span>
          </h3>
          <div className="grid-wrap">
            <table className="issue-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Done</th>
                  <th>Cycle p50</th>
                  <th>Cycle p85</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.assignee}>
                    <td>{p.name}</td>
                    <td>{p.done}</td>
                    <td>{fmtDays(p.cycle.p50)}</td>
                    <td>{fmtDays(p.cycle.p85)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function FlowRow({
  issue,
  onOpenNote,
  bar,
  scale,
  p50,
  p85,
  right,
}: {
  issue: FlowIssue;
  onOpenNote: (path: string) => void;
  bar: number | null;
  scale: number;
  p50: number | null;
  p85: number | null;
  right: string;
}) {
  const cls =
    bar === null
      ? ''
      : p85 !== null && bar > p85
        ? ' late'
        : p50 !== null && bar > p50
          ? ' warn'
          : '';
  const rangeMeaning =
    bar === null
      ? 'No age or cycle-time bar is available yet.'
      : cls === ' late'
        ? `Red means this is past the team's p85${p85 === null ? '' : ` (${fmtDays(p85)})`}.`
        : cls === ' warn'
          ? `Amber means this is past the team's p50${p50 === null ? '' : ` (${fmtDays(p50)})`} but within p85.`
          : p50 === null
            ? 'Blue shows elapsed time; there is no cycle-time baseline yet.'
            : `Blue means this is within the team's typical range (at or below p50 ${fmtDays(p50)}).`;
  const markerMeaning = [
    p50 === null ? '' : `Gray marker: p50 ${fmtDays(p50)}.`,
    p85 === null ? '' : `Red marker: p85 ${fmtDays(p85)}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const barTitle = `${right}\n${rangeMeaning}${markerMeaning ? ` ${markerMeaning}` : ''}`;
  return (
    <div className="flow-row">
      <button type="button" className="key-link flow-key" onClick={() => onOpenNote(issue.path)}>
        {issue.key}
      </button>
      <span className="flow-sum" title={issue.summary ?? ''}>
        {issue.summary}
        {issue.assigneeName ? <span className="muted small"> · {issue.assigneeName}</span> : null}
      </span>
      <span className="flow-bar-wrap" title={barTitle} role="img" aria-label={barTitle}>
        {p50 !== null && (
          <i className="flow-mark p50" style={{ left: `${(p50 / scale) * 100}%` }} />
        )}
        {p85 !== null && (
          <i className="flow-mark p85" style={{ left: `${(p85 / scale) * 100}%` }} />
        )}
        {bar !== null && (
          <i
            className={`flow-bar${cls}`}
            style={{ width: `${Math.min((bar / scale) * 100, 100)}%` }}
          />
        )}
      </span>
      <StatusStrip bands={issue.bands} />
      <span className="flow-right muted small">{right}</span>
    </div>
  );
}

/** The issue's life as proportional status segments, coloured by category. */
function StatusStrip({ bands }: { bands: FlowIssue['bands'] }) {
  const now = Date.now();
  const spans = bands.map((b) => ({
    ...b,
    ms: Math.max(0, (b.to ? new Date(b.to).getTime() : now) - new Date(b.from).getTime()),
  }));
  const total = spans.reduce((a, b) => a + b.ms, 0) || 1;
  const categoryLabel = (category: FlowIssue['bands'][number]['category']) => {
    if (category === 'new') return 'to do';
    if (category === 'indeterminate') return 'in progress';
    if (category === 'done') return 'done';
    return 'other';
  };
  const titleOf = (span: (typeof spans)[number]) =>
    `${span.status} · ${categoryLabel(span.category)} · ${fmtDays(span.ms / 86_400_000)} · ${shortDate(span.from)} → ${span.to ? shortDate(span.to) : 'now'}`;
  return (
    <span className="flow-strip">
      {spans.map((span) => (
        <button
          type="button"
          key={`${span.status}:${span.from}`}
          className={`flow-seg ${span.category ?? 'other'}`}
          style={{ width: `${Math.max((span.ms / total) * 100, 1.5)}%` }}
          aria-label={titleOf(span)}
          tabIndex={0}
        >
          <span className="flow-seg-tip" role="tooltip">
            {titleOf(span)}
          </span>
        </button>
      ))}
    </span>
  );
}
