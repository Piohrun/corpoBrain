import { useCallback, useEffect, useState } from 'react';
import { type PersonOverview, personApi } from '../api.ts';
import { statusColor } from '../colors.ts';
import { useVaultEvents } from '../hooks.ts';
import { lsGet, lsSet } from '../storage.ts';

export function PersonPanel({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const [data, setData] = useState<PersonOverview | null>(null);
  const [open, setOpen] = useState(() => lsGet('cb.personPanel') !== 'closed');

  // not every person note has an overview (hubs, brand-new notes): a failed
  // load simply hides the panel, but a stale response for a previous path
  // must never be shown for this one
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      personApi
        .overview(path)
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {
          if (!cancelled) setData(null);
        });
    load();
    return () => {
      cancelled = true;
    };
  }, [path]);
  const refresh = useCallback(() => {
    personApi
      .overview(path)
      .then(setData)
      .catch(() => setData(null));
  }, [path]);
  useVaultEvents(refresh);

  if (!data) return null;
  const { person, columns, issues, mentions, tasks, unit } = data;
  // hubs (region/team notes) have no assignable work — skip the panel
  if (person.name === person.region || person.name === person.team) return null;

  const toggle = () => {
    lsSet('cb.personPanel', open ? 'closed' : 'open');
    setOpen(!open);
  };

  const capOf = (col: string) =>
    col === 'Backlog' ? null : (person.overrides[col] ?? person.capacity);
  const loadOf = (col: string) => {
    const manual = person.loadOverrides[col];
    if (manual !== undefined) return manual;
    return (
      Math.round(
        issues
          .filter((i) => i.effectiveSprint === col && i.statusCategory !== 'done')
          .reduce((a, i) => a + (i.effectiveEffort ?? 0), 0) * 100,
      ) / 100
    );
  };

  return (
    <div className="person-panel">
      <button type="button" className="group-toggle" onClick={toggle}>
        {open ? '▾' : '▸'} Overview{' '}
        <span className="muted small">
          {[person.region, person.team].filter(Boolean).join(' · ') || 'person'}
        </span>
      </button>
      {open && (
        <div className="person-panel-body">
          <div className="person-cols">
            {columns.map((col) => {
              const cap = capOf(col);
              const load = loadOf(col);
              const colIssues = issues.filter(
                (i) => i.effectiveSprint === col && i.statusCategory !== 'done',
              );
              if (col === 'Backlog' && colIssues.length === 0) return null;
              return (
                <div key={col} className="person-col">
                  <div className="muted small">
                    {col} — <b className={cap !== null && load > cap ? 'over-flag' : ''}>{load}</b>
                    {cap !== null && (
                      <span className="muted">
                        {' '}
                        / {cap} {unit}
                      </span>
                    )}
                  </div>
                  <div className="chips">
                    {colIssues.map((i) => (
                      <button
                        type="button"
                        key={i.key}
                        className={`chip${i.riskFlags.length ? ' risky' : ''}`}
                        title={i.summary ?? ''}
                        onClick={() => onOpen(i.path)}
                      >
                        <span
                          className="status-dot"
                          style={{ background: statusColor(i.status, i.statusCategory) }}
                        />
                        {i.key}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {tasks.length > 0 && (
            <div className="person-section">
              <span className="muted small">open items</span>
              {tasks.map((t) => (
                <button
                  type="button"
                  key={`${t.path}:${t.line}`}
                  className="backlink"
                  onClick={() => onOpen(t.path)}
                >
                  ☐ {t.text}
                  {t.due && <span className="due-chip"> {t.due}</span>}
                </button>
              ))}
            </div>
          )}

          {mentions.length > 0 && (
            <div className="person-section">
              <span className="muted small">mentioned in</span>
              {mentions.slice(0, 8).map((m) => (
                <button
                  type="button"
                  key={m.srcPath}
                  className="backlink"
                  onClick={() => onOpen(m.srcPath)}
                >
                  <span className="mention-date">
                    {new Date(m.mtime).toISOString().slice(0, 10)}
                  </span>{' '}
                  {m.srcTitle}
                  {m.snippet && <div className="muted">{m.snippet}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
