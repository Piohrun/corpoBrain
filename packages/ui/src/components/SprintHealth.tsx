import { useCallback, useEffect, useState } from 'react';
import { type HealthProblem, type HealthReport, planApi } from '../api.ts';

const LABELS: Record<string, string> = {
  'no-estimate': 'No estimate',
  'no-assignee': 'Nobody assigned',
  oversized: 'Too big to plan',
  blocked: 'Blocked',
  stale: 'Stalled',
  'not-started': 'Not started',
  'at-risk': 'At risk of spilling',
  overloaded: 'Over bandwidth',
  underloaded: 'Room for more',
  'unknown-assignee': 'Assignee has no person note',
};

const ICONS: Record<string, string> = {
  'no-estimate': '?',
  'no-assignee': '👤',
  oversized: '✂',
  blocked: '⛔',
  stale: '🕸',
  'not-started': '◷',
  'at-risk': '⚠',
  overloaded: '▲',
  underloaded: '▽',
  'unknown-assignee': '👻',
};

/** Problems in the selected sprint, replacing a flat list of issues nobody reads. */
export function SprintHealth({
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
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    planApi
      .health(sprint || undefined)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [sprint]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-checks after a vault change
  useEffect(load, [load, reloadKey]);

  if (error) return <section className="plan-error">Sprint health unavailable: {error}</section>;
  if (!report) return <section className="health-empty">Checking sprint…</section>;

  const groups = new Map<string, HealthProblem[]>();
  for (const p of report.problems) {
    const list = groups.get(p.kind) ?? [];
    list.push(p);
    groups.set(p.kind, list);
  }
  const t = report.totals;
  const pct = t.effort > 0 ? Math.round((t.doneEffort / t.effort) * 100) : 0;
  const highs = report.problems.filter((p) => p.severity === 'high').length;

  const toggle = (kind: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <section className="health">
      <div className="health-head">
        <select
          className="cell-input health-sprint"
          value={sprint}
          onChange={(e) => onSprint(e.target.value)}
        >
          {sprints.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className={`health-count${highs ? ' bad' : ''}`}>
          {report.problems.length === 0
            ? '✓ nothing to fix'
            : `${report.problems.length} to look at${highs ? ` · ${highs} urgent` : ''}`}
        </span>
        <span className="health-stat">
          {t.done}/{t.issues} done · {t.doneEffort} of {t.effort} {report.unit} ({pct}%)
        </span>
        {t.capacity > 0 && (
          <span className={`health-stat${t.effort > t.capacity ? ' bad' : ''}`}>
            {t.effort} {report.unit} planned vs {t.capacity} bandwidth
          </span>
        )}
        {report.elapsedPct !== null && (
          <span className="health-stat">
            {report.elapsedPct}% elapsed
            {report.daysLeft !== null &&
              (report.daysLeft >= 0
                ? ` · ${report.daysLeft} day${report.daysLeft === 1 ? '' : 's'} left`
                : ' · ended')}
          </span>
        )}
        <button type="button" className="plan-btn" onClick={load} title="Re-check">
          ↻
        </button>
      </div>
      {report.problems.length === 0 ? (
        <p className="health-empty">
          Everything in {report.sprint} is estimated, assigned and moving. Nice.
        </p>
      ) : (
        <div className="health-groups">
          {[...groups].map(([kind, list]) => (
            <div key={kind} className={`health-group sev-${list[0]?.severity ?? 'low'}`}>
              <button type="button" className="health-group-head" onClick={() => toggle(kind)}>
                <span className="health-icon">{ICONS[kind] ?? '•'}</span>
                <span className="health-label">{LABELS[kind] ?? kind}</span>
                <span className="health-badge">{list.length}</span>
                <span className="health-chev">{hidden.has(kind) ? '▸' : '▾'}</span>
              </button>
              {!hidden.has(kind) && (
                <ul className="health-list">
                  {list.map((p) => (
                    <li key={`${p.kind}:${p.issueKey ?? p.personPath ?? p.personName}`}>
                      {p.issueKey && (
                        <button
                          type="button"
                          className="key-link"
                          onClick={() => p.path && onOpenNote(p.path)}
                        >
                          {p.issueKey}
                        </button>
                      )}
                      {p.personName && !p.issueKey && (
                        <button
                          type="button"
                          className="key-link"
                          onClick={() => p.personPath && onOpenNote(p.personPath)}
                          disabled={!p.personPath}
                        >
                          {p.personName}
                        </button>
                      )}
                      <span className="health-detail">{p.detail}</span>
                      {p.summary && <span className="health-summary">{p.summary}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
