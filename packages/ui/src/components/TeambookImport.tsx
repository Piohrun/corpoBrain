import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type TeambookChange,
  type TeambookChangeStatus,
  type TeambookConfig,
  type TeambookImportRecord,
  type TeambookStatus,
  type TeambookStoredPlan,
  teambookApi,
} from '../api.ts';
import { useDialogs } from '../dialogs.tsx';

const STATUS_LABEL: Record<TeambookChangeStatus, string> = {
  new: 'new note',
  link: 'link',
  fill: 'fill empty',
  update: 'update',
  add: 'add',
  conflict: 'conflict',
  dismissed: 'kept yours',
  left: 'left?',
  blocked: 'blocked',
};
const NEEDS_DECISION = new Set<TeambookChangeStatus>(['conflict', 'left', 'blocked']);

const unlink = (s: string) => s.replace(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/, '$1');
function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map((v) => show(v)).join(', ');
  if (typeof value === 'object')
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${show(v)}`)
      .join(' · ');
  return unlink(String(value));
}

type Filter = 'all' | 'decide' | 'selected';

/** Settings → Teambook import: preview, review, apply, undo. */
export function TeambookImport() {
  const dialogs = useDialogs();
  const [cfg, setCfg] = useState<TeambookConfig | null>(null);
  const [status, setStatus] = useState<TeambookStatus | null>(null);
  const [stored, setStored] = useState<TeambookStoredPlan | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [dismiss, setDismiss] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [imports, setImports] = useState<TeambookImportRecord[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPlan = useCallback(() => {
    teambookApi
      .plan()
      .then((p) => {
        setStored(p);
        setChosen(new Set(p?.plan.changes.filter((c) => c.selected).map((c) => c.id) ?? []));
        setDismiss(new Set());
      })
      .catch(() => {});
  }, []);
  const loadImports = useCallback(() => {
    teambookApi
      .imports()
      .then(setImports)
      .catch(() => {});
  }, []);
  const refreshStatus = useCallback(() => {
    teambookApi
      .status()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    teambookApi
      .config()
      .then(setCfg)
      .catch(() => {});
    refreshStatus();
    loadPlan();
    loadImports();
  }, [refreshStatus, loadPlan, loadImports]);
  // Poll while a preview runs; load its plan when it finishes.
  useEffect(() => {
    if (!status?.syncing) return;
    const timer = setInterval(() => {
      teambookApi
        .status()
        .then((s) => {
          setStatus(s);
          if (!s.syncing) loadPlan();
        })
        .catch(() => {});
    }, 800);
    return () => clearInterval(timer);
  }, [status?.syncing, loadPlan]);

  const save = (patch: Partial<TeambookConfig> & { token?: string }) =>
    teambookApi
      .saveConfig(patch)
      .then((next) => {
        setCfg(next);
        setMsg(null);
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));

  const changes = stored?.plan.changes ?? [];
  const groups = useMemo(() => {
    const visible = changes.filter((c) =>
      filter === 'decide'
        ? NEEDS_DECISION.has(c.status)
        : filter === 'selected'
          ? chosen.has(c.id)
          : true,
    );
    const byPath = new Map<string, TeambookChange[]>();
    for (const c of visible) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c]);
    return [...byPath.entries()];
  }, [changes, filter, chosen]);
  const counts = useMemo(() => {
    const out: Partial<Record<TeambookChangeStatus, number>> = {};
    for (const c of changes) out[c.status] = (out[c.status] ?? 0) + 1;
    return out;
  }, [changes]);
  const ambiguous = stored?.plan.matches.filter((m) => m.by === 'ambiguous') ?? [];

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  const startPreview = (source: 'api' | 'fixture') => {
    setMsg(null);
    teambookApi
      .preview(source)
      .then(() => teambookApi.status())
      .then((s) => {
        setStatus(s);
        if (!s.syncing) loadPlan(); // a fixture preview can finish before the first poll
      })
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  };

  const apply = async () => {
    if (!stored) return;
    const n = chosen.size;
    const ok = await dialogs.confirm({
      title: 'Apply Teambook import',
      message: `Write ${n} selected change${n === 1 ? '' : 's'} to your notes? The vault is committed to git first when it is a repository, and the import can be undone from this page.`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await teambookApi.apply(stored.id, [...chosen], [...dismiss]);
      setMsg({
        ok: true,
        text: `${r.written.length} note(s) written${r.skipped.length ? `; ${r.skipped.length} change(s) skipped` : ''}`,
      });
      if (r.skipped.length)
        dialogs.toast({
          kind: 'info',
          message: r.skipped.map((s) => `${s.id}: ${s.reason}`).join('\n'),
          ttl: 15000,
        });
      setStored(null);
      loadImports();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const undo = async (record: TeambookImportRecord) => {
    const ok = await dialogs.confirm({
      title: 'Undo import',
      message: `Put back the ${record.files.length} note(s) this import changed? Notes edited since are left as they are; notes it created go to .trash.`,
      confirmLabel: 'Undo import',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await teambookApi.undo(record.id);
      setMsg({
        ok: true,
        text: `restored ${r.restored.length}${r.kept.length ? `; kept ${r.kept.length} edited since (${r.kept.map((k) => k.path).join(', ')})` : ''}`,
      });
      loadImports();
      loadPlan();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };

  if (!cfg) return null;
  const run = status?.lastRun;
  return (
    <section>
      <h2 className="plan-h2">Teambook import</h2>
      <div className="settings-card">
        <p className="muted small">
          Proposes PODs, people and memberships from Teambook as reviewable changes. Your notes are
          never changed without Apply; values you edited by hand are conflicts that stay yours
          unless you tick them. Nothing is deleted, cleared or renamed.
        </p>
        {!cfg.adapterReady && (
          <p className="plan-error wrap small">
            The Teambook adapter is not completed yet (packages/core/src/teambook/parse.ts). A
            preview from a fixture file works meanwhile.
          </p>
        )}
        <div className="settings-grid outlook-grid">
          <label htmlFor="tb-url">Teambook API URL</label>
          <input
            id="tb-url"
            key={cfg.baseUrl}
            defaultValue={cfg.baseUrl}
            placeholder="https://teambook…/api"
            onBlur={(e) =>
              e.target.value.trim() !== cfg.baseUrl && void save({ baseUrl: e.target.value })
            }
          />
          <label htmlFor="tb-root">root POD id</label>
          <input
            id="tb-root"
            key={cfg.rootPodId}
            defaultValue={cfg.rootPodId}
            placeholder="only this POD and below (recommended)"
            onBlur={(e) =>
              e.target.value.trim() !== cfg.rootPodId && void save({ rootPodId: e.target.value })
            }
          />
          <label htmlFor="tb-token">token</label>
          <input
            id="tb-token"
            type="password"
            autoComplete="off"
            placeholder={cfg.tokenSet ? 'saved — type to replace' : 'not set'}
            onBlur={(e) => {
              if (e.target.value.trim())
                void save({ token: e.target.value }).then(() => {
                  e.target.value = '';
                });
            }}
          />
          <label htmlFor="tb-create">create missing notes</label>
          <select
            id="tb-create"
            value={`${cfg.createUnits ? 'u' : ''}${cfg.createPeople ? 'p' : ''}`}
            onChange={(e) =>
              void save({
                createUnits: e.target.value.includes('u'),
                createPeople: e.target.value.includes('p'),
              })
            }
          >
            <option value="up">PODs and people</option>
            <option value="u">PODs only</option>
            <option value="p">people only</option>
            <option value="">none (update existing notes only)</option>
          </select>
        </div>
      </div>

      <div className="outlook-actions">
        {status?.syncing && status.runId ? (
          <button
            type="button"
            className="plan-btn"
            disabled={status.cancelling}
            onClick={() =>
              status.runId &&
              teambookApi
                .cancel(status.runId)
                .then(refreshStatus)
                .catch(() => {})
            }
          >
            {status.cancelling ? 'Cancelling…' : 'Cancel preview'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="plan-btn"
              disabled={!cfg.adapterReady || !cfg.baseUrl || !cfg.tokenSet}
              title={
                !cfg.adapterReady
                  ? 'the adapter is not completed yet'
                  : 'fetch and plan; writes nothing'
              }
              onClick={() => startPreview('api')}
            >
              Preview from Teambook
            </button>
            {cfg.fixtureFound && (
              <button
                type="button"
                className="plan-btn"
                title=".corpobrain/teambook-cache/fixture.json"
                onClick={() => startPreview('fixture')}
              >
                Preview from fixture
              </button>
            )}
          </>
        )}
        {msg && <span className={`probe-result ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</span>}
      </div>
      {status?.syncing && status.progress && (
        <p className="muted small">
          {status.progress.phase}{' '}
          {status.progress.total ? `${status.progress.current}/${status.progress.total}` : '…'}
        </p>
      )}
      {!status?.syncing && run?.outcome === 'failed' && run.error && (
        <p className="plan-error wrap">last preview failed: {run.error}</p>
      )}

      {stored && (
        <div className="outlook-preview tb-review">
          <h3 className="outlook-h3">
            Review · {stored.source === 'fixture' ? 'fixture' : 'Teambook'} data from{' '}
            {stored.plan.snapshotAt.slice(0, 16).replace('T', ' ')}
          </h3>
          <div className="tb-counts">
            {(Object.keys(STATUS_LABEL) as TeambookChangeStatus[])
              .filter((s) => counts[s])
              .map((s) => (
                <span key={s} className={`tb-chip tb-${s}`}>
                  {STATUS_LABEL[s]} {counts[s]}
                </span>
              ))}
            {!changes.length && (
              <span className="muted small">
                Nothing to change: your notes agree with Teambook.
              </span>
            )}
          </div>
          {[
            ...stored.plan.warnings,
            ...ambiguous.map(
              (m) => `${m.name}: ${m.detail} — not imported until only one note matches`,
            ),
          ].map((w) => (
            <p key={w} className="plan-error wrap small">
              {w}
            </p>
          ))}
          {changes.length > 0 && (
            <div className="outlook-actions">
              <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                <option value="all">all changes</option>
                <option value="decide">needs a decision</option>
                <option value="selected">selected</option>
              </select>
              <button
                type="button"
                className="props-toggle"
                onClick={() =>
                  setChosen(new Set(changes.filter((c) => c.selected).map((c) => c.id)))
                }
              >
                recommended
              </button>
              <button type="button" className="props-toggle" onClick={() => setChosen(new Set())}>
                none
              </button>
              <span className="spacer" />
              <button
                type="button"
                className="plan-btn"
                disabled={busy || (!chosen.size && !dismiss.size)}
                onClick={() => void apply()}
              >
                {busy ? 'Applying…' : `Apply ${chosen.size} change${chosen.size === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          {groups.map(([path, list]) => (
            <div key={path} className="tb-group">
              <div className="tb-group-head">
                <strong>{list[0]?.title}</strong> <span className="muted small">{path}</span>
              </div>
              <table className="issue-table">
                <tbody>
                  {list.map((c) => {
                    const missing = chosen.has(c.id)
                      ? c.requires.filter((r) => !chosen.has(r))
                      : [];
                    return (
                      <tr key={c.id} className={c.status === 'blocked' ? 'muted' : undefined}>
                        <td className="tb-check">
                          <input
                            type="checkbox"
                            aria-label={`apply ${c.id}`}
                            disabled={c.status === 'blocked'}
                            checked={chosen.has(c.id)}
                            onChange={(e) => setChosen((s) => toggle(s, c.id, e.target.checked))}
                          />
                        </td>
                        <td>
                          <span className={`tb-chip tb-${c.status}`}>{STATUS_LABEL[c.status]}</span>
                        </td>
                        <td>{c.field ?? (c.status === 'new' ? 'note' : '')}</td>
                        <td className="tb-values">
                          {c.status === 'new' ? (
                            show(c.next)
                          ) : (
                            <>
                              <span className="tb-old">{show(c.current)}</span> →{' '}
                              <span className="tb-new">{show(c.next)}</span>
                            </>
                          )}
                        </td>
                        <td className="muted small">
                          {c.reason}
                          {missing.length > 0 && (
                            <div className="plan-error wrap">needs {missing.join(', ')}</div>
                          )}
                          {c.status === 'conflict' && !chosen.has(c.id) && (
                            <label className="outlook-check">
                              <input
                                type="checkbox"
                                checked={dismiss.has(c.id)}
                                onChange={(e) =>
                                  setDismiss((s) => toggle(s, c.id, e.target.checked))
                                }
                              />
                              keep mine, stop asking
                            </label>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {imports.length > 0 && (
        <div className="tb-imports">
          <h3 className="outlook-h3">Past imports</h3>
          {imports.slice(0, 5).map((r) => (
            <div key={r.id} className="muted small tb-import">
              {r.at.slice(0, 16).replace('T', ' ')} · {r.applied.length} changes · {r.files.length}{' '}
              notes
              {r.undoneAt ? (
                ' · undone'
              ) : (
                <button type="button" className="props-toggle" onClick={() => void undo(r)}>
                  undo
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
