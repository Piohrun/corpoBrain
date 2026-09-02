import { useCallback, useEffect, useState } from 'react';
import { type FlowIssue, type FlowSprint, flowApi } from '../api.ts';
import { lsGet, lsSet } from '../storage.ts';

const WINDOWS = [30, 90, 180];

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

  if (error) return <section className="health-empty">Flow: {error}</section>;
  if (!data) return <section className="health-empty">Reading history…</section>;

  const ref = data.reference;
  const p85 = ref.cycle.p85 ?? null;
  const p50 = ref.cycle.p50 ?? null;
  const scale = Math.max(p85 ?? 0, ...data.open.map((o) => o.times.ageDays ?? 0), 1) * 1.15;
  const noHistory =
    ref.cycle.n === 0 && data.open.every((o) => o.bands.length <= 1) && data.done.length === 0;

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
  return (
    <div className="flow-row">
      <button type="button" className="key-link flow-key" onClick={() => onOpenNote(issue.path)}>
        {issue.key}
      </button>
      <span className="flow-sum" title={issue.summary ?? ''}>
        {issue.summary}
        {issue.assigneeName ? <span className="muted small"> · {issue.assigneeName}</span> : null}
      </span>
      <span className="flow-bar-wrap" title={right}>
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
  return (
    <span
      className="flow-strip"
      title={spans.map((s) => `${s.status} ${fmtDays(s.ms / 86_400_000)}`).join(' → ')}
    >
      {spans.map((s) => (
        <i
          key={`${s.status}:${s.from}`}
          className={`flow-seg ${s.category ?? 'other'}`}
          style={{ width: `${Math.max((s.ms / total) * 100, 1.5)}%` }}
        />
      ))}
    </span>
  );
}
