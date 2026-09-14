import { useEffect, useState } from 'react';
import { type JiraStatus, planApi, type SyncRun } from '../api.ts';

export function SyncHistory({ status }: { status: JiraStatus | null }) {
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [fallback, setFallback] = useState('');
  const lastId = status?.lastRun?.id;
  const outcome = status?.lastRun?.outcome;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh persisted history when the current job starts or settles
  useEffect(() => {
    let alive = true;
    planApi
      .jiraHistory()
      .then((result) => {
        if (alive) {
          setRuns(result.runs);
          setError(result.warning);
        }
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [lastId, outcome]);

  const copy = async (run: SyncRun) => {
    const text = JSON.stringify(run, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(run.id);
      setFallback('');
    } catch {
      setFallback(text);
    }
  };
  return (
    <section className="sync-history">
      <details>
        <summary className="plan-h2">Sync history ({runs.length})</summary>
        {error && <p className="plan-error">{error}</p>}
        {!runs.length && <p className="muted">No sync runs recorded yet.</p>}
        {runs.map((run) => {
          const fetched = run.reports.reduce((sum, r) => sum + r.fetched, 0);
          const warnings = [...new Set(run.reports.flatMap((r) => r.warnings))];
          return (
            <div key={run.id} className="sync-history-run">
              <div className="sync-progress-heading">
                <strong>
                  {run.outcome} · {run.profiles.join(', ') || 'no profile'}
                </strong>
                <button type="button" className="risk-chip" onClick={() => void copy(run)}>
                  {copied === run.id ? 'Copied' : 'Copy diagnostics'}
                </button>
              </div>
              <div className="muted small">
                {new Date(run.startedAt).toLocaleString()} · {run.full ? 'full' : 'incremental'} ·{' '}
                {run.outcome === 'running'
                  ? 'in progress'
                  : `${(run.durationMs / 1000).toFixed(1)}s`}{' '}
                · {fetched} fetched in completed profiles · {run.retries} retries
              </div>
              {run.progress && run.outcome !== 'success' && (
                <div className="small">
                  Last progress: {run.progress.profile} · {run.progress.phase} ·{' '}
                  {run.progress.current}/{run.progress.total || '?'}
                </div>
              )}
              {run.error && <div className="plan-error">{run.error}</div>}
              {warnings.length > 0 && (
                <div className="sync-warnings">
                  {warnings.map((w) => (
                    <div key={w}>{w}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {fallback && (
          <label>
            Copy these diagnostics manually
            <textarea
              className="sync-diagnostics"
              readOnly
              value={fallback}
              onFocus={(e) => e.target.select()}
            />
          </label>
        )}
      </details>
    </section>
  );
}
