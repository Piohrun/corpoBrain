import type { JiraStatus } from '../api.ts';

const PHASE_LABEL: Record<string, string> = {
  search: 'searching Jira',
  sprints: 'fetching boards',
  membership: 'mapping sprint membership',
  issues: 'writing issue notes',
  people: 'creating people',
  done: 'finishing',
};

export function SyncProgressBar({ status }: { status: JiraStatus | null }) {
  const p = status?.progress;
  if (!p) return null;
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : null;
  return (
    <div className="sync-progress" title={p.detail ?? ''}>
      <div className="sync-progress-label">
        {PHASE_LABEL[p.phase] ?? p.phase}
        {p.total > 0 && ` — ${p.current}/${p.total}`}
        {p.detail && p.phase !== 'search' && ` · ${p.detail}`}
      </div>
      <div className={`sync-progress-track${pct === null ? ' indeterminate' : ''}`}>
        <div className="sync-progress-fill" style={pct === null ? {} : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function lastSyncSummary(status: JiraStatus | null): string | null {
  const reports = status?.lastReports;
  if (!reports?.length) return null;
  const r = reports[0];
  if (!r) return null;
  return `last sync: ${r.fetched} fetched · +${r.created.length} new · ~${r.updated.length} updated · ${r.unchanged} unchanged${r.skipped.length ? ` · ${r.skipped.length} SKIPPED` : ''}`;
}
