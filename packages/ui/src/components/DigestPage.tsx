import { useCallback, useEffect, useMemo, useState } from 'react';
import { type ChangeEvent, type DigestResponse, digestApi } from '../api.ts';
import { useJiraSync } from '../hooks.ts';

const RANGES: { id: string; label: string }[] = [
  { id: 'last', label: 'Last refresh' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'Everything' },
];

const KIND_LABEL: Record<string, string> = {
  created: 'added',
  done: 'done',
  reopened: 'reopened',
  status: 'status',
  assignee: 'reassigned',
  sprint: 'moved sprint',
  estimate: 're-estimated',
  summary: 'renamed',
  priority: 'priority',
  epic: 'epic',
};

type GroupBy = 'person' | 'kind' | 'issue' | 'time';

function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** What moved in Jira since the last refresh — the "catch me up" view. */
export function DigestPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [range, setRange] = useState('last');
  const [groupBy, setGroupBy] = useState<GroupBy>('person');
  const [data, setData] = useState<DigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    digestApi
      .get(range)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [range]);
  useEffect(load, [load]);
  const { syncing, start } = useJiraSync(load);

  const groups = useMemo(() => {
    if (!data) return [] as { title: string; path: string | null; events: ChangeEvent[] }[];
    if (groupBy === 'time') return [{ title: '', path: null, events: data.events }];
    const map = new Map<string, { title: string; path: string | null; events: ChangeEvent[] }>();
    for (const e of data.events) {
      const key =
        groupBy === 'person'
          ? (e.assigneeName ?? 'Unassigned')
          : groupBy === 'kind'
            ? (KIND_LABEL[e.kind] ?? e.kind)
            : e.key;
      const path =
        groupBy === 'person'
          ? e.assignee
            ? (data.people[e.assignee]?.path ?? null)
            : null
          : groupBy === 'issue'
            ? (data.paths[e.key] ?? null)
            : null;
      const g = map.get(key) ?? { title: key, path, events: [] };
      g.events.push(e);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => b.events.length - a.events.length);
  }, [data, groupBy]);

  const lastSync =
    data?.lastSync
      .map((s) => s.at)
      .sort()
      .pop() ?? null;

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">What changed</span>
        <div className="digest-ranges">
          {RANGES.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`tab${range === r.id ? ' active' : ''}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="plan-label">
          group by
          <select
            className="cell-input"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          >
            <option value="person">person</option>
            <option value="kind">change</option>
            <option value="issue">issue</option>
            <option value="time">time</option>
          </select>
        </label>
        <button type="button" className="plan-btn" onClick={() => start(false)} disabled={syncing}>
          {syncing ? 'syncing…' : '↻ sync now'}
        </button>
      </div>

      <div className="digest-sub">
        {lastSync && <span className="health-stat">last refresh {when(lastSync)}</span>}
        {data && (
          <span className="health-stat">
            {data.events.length} change{data.events.length === 1 ? '' : 's'}
          </span>
        )}
        {data &&
          Object.entries(data.counts)
            .sort((a, b) => b[1] - a[1])
            .map(([kind, n]) => (
              <span key={kind} className={`digest-chip k-${kind}`}>
                {KIND_LABEL[kind] ?? kind} <b>{n}</b>
              </span>
            ))}
        {error && <span className="plan-error">{error}</span>}
      </div>

      <div className="planning-scroll">
        {data && data.events.length === 0 ? (
          <p className="health-empty">
            {data.lastSync.length === 0
              ? 'Nothing yet — the digest starts recording from the sync after this one.'
              : 'Nothing changed in Jira in this window.'}
          </p>
        ) : (
          groups.map((g) => (
            <section className="digest-group" key={g.title || 'all'}>
              {g.title && (
                <h2 className="plan-h2">
                  <button
                    type="button"
                    className="key-link"
                    onClick={() => g.path && onOpenNote(g.path)}
                    disabled={!g.path}
                  >
                    {g.title}
                  </button>
                  <span className="health-badge">{g.events.length}</span>
                </h2>
              )}
              <ul className="digest-list">
                {g.events.map((e) => (
                  <li key={`${e.at}:${e.key}:${e.kind}`} className={`digest-row k-${e.kind}`}>
                    <button
                      type="button"
                      className="key-link"
                      onClick={() => {
                        const path = data?.paths[e.key];
                        if (path) onOpenNote(path);
                      }}
                      disabled={!data?.paths[e.key]}
                    >
                      {e.key}
                    </button>
                    <span className="digest-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
                    {(e.from || e.to) && (
                      <span className="digest-move">
                        <span className="from">{e.from ?? '—'}</span>
                        <span className="arrow">→</span>
                        <span className="to">{e.to ?? '—'}</span>
                      </span>
                    )}
                    <span className="digest-summary">{e.summary}</span>
                    {groupBy !== 'person' && e.assigneeName && (
                      <span className="digest-who">{e.assigneeName}</span>
                    )}
                    <span className="digest-when">{when(e.at)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
