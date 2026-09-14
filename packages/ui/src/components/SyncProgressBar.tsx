import type { JiraStatus } from '../api.ts';

const PHASE_LABEL: Record<string, string> = {
  search: 'searching Jira',
  sprints: 'fetching boards',
  membership: 'mapping sprint membership',
  issues: 'writing issue notes',
  people: 'creating people',
  done: 'finishing',
};

export function SyncProgressBar({
  status,
  onCancel,
  cancelling = false,
}: {
  status: JiraStatus | null;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  const p = status?.progress;
  if (!status?.syncing) return null;
  const pct = p && p.total > 0 ? Math.round((p.current / p.total) * 100) : null;
  return (
    <div className="sync-progress" title={p?.detail ?? ''}>
      <div className="sync-progress-heading">
        <div className="sync-progress-label">
          {cancelling
            ? 'Cancelling sync…'
            : p
              ? (PHASE_LABEL[p.phase] ?? p.phase)
              : 'Starting sync…'}
          {p && p.total > 0 && ` — ${p.current}/${p.total}`}
          {p && p.total === 0 && p.current > 0 && ` — ${p.current} so far`}
          {!cancelling && p?.detail && (p.phase !== 'search' || p.retrying) && ` · ${p.detail}`}
        </div>
        {onCancel && (
          <button
            type="button"
            className="risk-chip"
            disabled={cancelling || !status.runId}
            onClick={onCancel}
          >
            Cancel sync
          </button>
        )}
      </div>
      <div className={`sync-progress-track${pct === null ? ' indeterminate' : ''}`}>
        <div className="sync-progress-fill" style={pct === null ? {} : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function lastSyncSummary(status: JiraStatus | null): string | null {
  if (status?.lastRun?.outcome === 'cancelled')
    return 'Last sync cancelled; completed profiles were kept.';
  if (status?.lastRun?.outcome === 'interrupted')
    return 'Last sync interrupted by a server restart.';
  const reports = status?.lastReports;
  if (!reports?.length) return null;
  const r = reports[0];
  if (!r) return null;
  return `last sync: ${r.fetched} fetched · +${r.created.length} new · ~${r.updated.length} updated · ${r.unchanged} unchanged · ${r.sprints ?? 0} sprints${r.skipped.length ? ` · ${r.skipped.length} SKIPPED` : ''}${r.changes ? ` · ${r.changes} changes` : ''}${r.warnings?.length ? ` · ⚠ ${r.warnings.length}` : ''}`;
}
