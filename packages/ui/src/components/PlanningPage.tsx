import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type BoardModel,
  type JiraStatus,
  type PlanPatch,
  planApi,
  type SavedView,
  viewApi,
} from '../api.ts';
import { useJiraSync, useVaultEvents } from '../hooks.ts';
import { lsGet, lsSet } from '../storage.ts';
import { BandwidthGrid } from './BandwidthGrid.tsx';
import { ChangesPanel } from './ChangesPanel.tsx';
import { FlowPanel } from './FlowPanel.tsx';
import type { GroupBy } from './planningShared.ts';
import { SprintHealth } from './SprintHealth.tsx';
import { SprintTable } from './SprintTable.tsx';
import { SyncProgressBar } from './SyncProgressBar.tsx';

interface Props {
  onOpenNote: (path: string) => void;
}

export function PlanningPage({ onOpenNote }: Props) {
  const [board, setBoard] = useState<BoardModel | null>(null);
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [flagFilter, setFlagFilter] = useState<string | null>(null);
  const [sprintFilter, setSprintFilter] = useState<string | null>(null);

  const [views, setViews] = useState<SavedView[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>(
    () => lsGet('cb.plan.groupBy', 'region') as GroupBy,
  );
  const [horizon, setHorizon] = useState<number>(() => Number(lsGet('cb.plan.horizon', '3')));
  const [bottom, setBottom] = useState<'health' | 'issues' | 'flow'>(() => {
    const stored = lsGet('cb.plan.bottom', 'health');
    return stored === 'issues' || stored === 'flow' ? stored : 'health'; // 'availability' moved to its own page
  });
  const [healthSprint, setHealthSprint] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => lsSet('cb.plan.groupBy', groupBy), [groupBy]);
  useEffect(() => lsSet('cb.plan.horizon', String(horizon)), [horizon]);
  useEffect(() => lsSet('cb.plan.bottom', bottom), [bottom]);

  const refresh = useCallback(() => {
    planApi
      .board()
      .then(setBoard)
      .catch((e: Error) => setError(e.message));
    planApi
      .jiraStatus()
      .then(setStatus)
      .catch(() => {});
    viewApi
      .list()
      .then(setViews)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(() => {
    refresh();
    setReloadKey((k) => k + 1);
  });

  const patch = useCallback(
    (key: string, p: PlanPatch) => {
      planApi
        .patchIssue(key, p)
        .then(refresh)
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const patchPerson = useCallback(
    (body: Parameters<typeof planApi.patchPerson>[0]) => {
      planApi
        .patchPerson(body)
        .then(refresh)
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const { syncing, status: syncStatus, start: sync, error: syncError } = useJiraSync(refresh);

  /** Visible sprint columns: first N sprints, Backlog always last. */
  const visibleColumns = useMemo(() => {
    if (!board) return [];
    const sprints = board.columns.filter((c) => c !== 'Backlog').slice(0, horizon);
    return [...sprints, 'Backlog'];
  }, [board, horizon]);

  const issues = useMemo(() => {
    if (!board) return [];
    const q = filter.trim().toLowerCase();
    return board.issues
      .filter((i) => i.statusCategory !== 'done')
      .filter(
        (i) =>
          !q ||
          i.key.toLowerCase().includes(q) ||
          (i.summary ?? '').toLowerCase().includes(q) ||
          (i.effectiveAssignee ?? '').toLowerCase().includes(q) ||
          (i.plan.bucket ?? '').toLowerCase().includes(q),
      )
      .filter((i) => !flagFilter || i.riskFlags.includes(flagFilter))
      .filter((i) => !sprintFilter || i.effectiveSprint === sprintFilter);
  }, [board, filter, flagFilter, sprintFilter]);

  if (!board) {
    return (
      <div className="planning">
        <div className="empty-state">{error ? `Failed to load board: ${error}` : 'Loading…'}</div>
      </div>
    );
  }

  const flagCounts = new Map<string, number>();
  for (const i of board.issues) {
    if (i.statusCategory === 'done') continue;
    for (const f of i.riskFlags) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);
  }
  const maxSprints = board.columns.filter((c) => c !== 'Backlog').length;

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Planning</span>
        <span className="muted">capacity in {board.unit}</span>
        <input
          className="plan-filter"
          placeholder="Filter issues…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        {status?.lastSynced && (
          <span className="muted">synced {status.lastSynced.slice(0, 16).replace('T', ' ')}</span>
        )}
        {syncError && <span className="plan-error">{syncError}</span>}
        <button type="button" className="plan-btn" onClick={() => sync()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync Jira'}
        </button>
      </div>
      <SyncProgressBar status={syncStatus} />

      <div className="views-bar">
        <label className="muted small">
          group{' '}
          <select
            className="cell-input"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          >
            <option value="region">by region</option>
            <option value="team">by team</option>
            <option value="region-team">region ▸ team</option>
            <option value="none">flat</option>
          </select>
        </label>
        <label className="muted small">
          sprints{' '}
          <select
            className="cell-input"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {Array.from({ length: Math.max(maxSprints, 1) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} ahead
              </option>
            ))}
          </select>
        </label>
        <select
          className="cell-input"
          value={sprintFilter ?? ''}
          onChange={(e) => setSprintFilter(e.target.value || null)}
        >
          <option value="">all sprints</option>
          {board.columns.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        {views.map((v) => (
          <button
            type="button"
            key={v.path}
            className="risk-chip"
            title={v.path}
            onClick={() => {
              setFilter(v.filter.text ?? '');
              setFlagFilter(v.filter.flag ?? null);
              setSprintFilter(v.filter.sprint ?? null);
            }}
          >
            {v.title}
          </button>
        ))}
        {(filter || flagFilter || sprintFilter) && (
          <button
            type="button"
            className="risk-chip"
            onClick={() => {
              const title = window.prompt('Save current filter as view:');
              if (!title) return;
              viewApi
                .save(title, {
                  ...(filter ? { text: filter } : {}),
                  ...(flagFilter ? { flag: flagFilter } : {}),
                  ...(sprintFilter ? { sprint: sprintFilter } : {}),
                })
                .then(refresh)
                .catch((e: Error) => setError(e.message));
            }}
          >
            + save view
          </button>
        )}
        {flagCounts.size > 0 && <span className="views-sep" />}
        {[...flagCounts.entries()].map(([flag, n]) => (
          <button
            type="button"
            key={flag}
            className={`risk-chip${flagFilter === flag ? ' active' : ''}`}
            onClick={() => setFlagFilter(flagFilter === flag ? null : flag)}
          >
            {flag} <b>{n}</b>
          </button>
        ))}
      </div>

      <div className="planning-scroll">
        <BandwidthGrid
          board={board}
          issues={issues}
          columns={visibleColumns}
          groupBy={groupBy}
          onPatch={patch}
          onPatchPerson={patchPerson}
          onOpenNote={onOpenNote}
        />
        <ChangesPanel board={board} onPatch={patch} onOpenNote={onOpenNote} />
        <div className="bottom-tabs">
          <button
            type="button"
            className={`tab${bottom === 'health' ? ' active' : ''}`}
            onClick={() => setBottom('health')}
          >
            ⚠ Sprint health
          </button>
          <button
            type="button"
            className={`tab${bottom === 'flow' ? ' active' : ''}`}
            onClick={() => setBottom('flow')}
            title="Cycle time, aging work and scope churn from the Jira changelog"
          >
            ⏱ Flow
          </button>
          <button
            type="button"
            className={`tab${bottom === 'issues' ? ' active' : ''}`}
            onClick={() => setBottom('issues')}
          >
            ☰ All issues ({issues.length})
          </button>
        </div>
        {bottom === 'flow' ? (
          <FlowPanel
            sprints={board.sprints.map((s) => s.name)}
            sprint={
              healthSprint ||
              (board.sprints.find((s) => s.state === 'active')?.name ??
                board.sprints[0]?.name ??
                '')
            }
            onSprint={setHealthSprint}
            onOpenNote={onOpenNote}
            reloadKey={reloadKey}
          />
        ) : bottom === 'health' ? (
          <SprintHealth
            sprints={board.sprints.map((s) => s.name)}
            sprint={
              healthSprint ||
              (board.sprints.find((s) => s.state === 'active')?.name ??
                board.sprints[0]?.name ??
                '')
            }
            onSprint={setHealthSprint}
            onOpenNote={onOpenNote}
            reloadKey={reloadKey}
          />
        ) : (
          <SprintTable board={board} issues={issues} onPatch={patch} onOpenNote={onOpenNote} />
        )}
      </div>
    </div>
  );
}
