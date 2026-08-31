import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type JiraConfig,
  type JiraIssueRow,
  type JiraProfileCfg,
  jiraApi,
  type SprintRow,
} from '../api.ts';
import { statusColor } from '../colors.ts';
import { useJiraSync, useVaultEvents } from '../hooks.ts';
import { lastSyncSummary, SyncProgressBar } from './SyncProgressBar.tsx';
import { WritebackSection } from './WritebackSection.tsx';

export function JiraPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [config, setConfig] = useState<JiraConfig | null>(null);
  const [issues, setIssues] = useState<JiraIssueRow[]>([]);
  const [sprints, setSprints] = useState<SprintRow[]>([]);
  const [error, _setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    jiraApi
      .config()
      .then((c) => {
        setConfig(c);
        setConfigError(null);
      })
      .catch((e: Error) => setConfigError(e.message));
    jiraApi
      .issues()
      .then(setIssues)
      .catch(() => {});
    jiraApi
      .sprints()
      .then(setSprints)
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  const { syncing, status: syncStatus, start: sync, error: syncError } = useJiraSync(refresh);

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Jira</span>
        {config && (
          <span className="muted small">
            {config.baseUrl || 'not configured'}
            {config.tokenSet ? ' · token set' : ' · no token'}
          </span>
        )}
        <span className="spacer" />
        {(error || syncError || syncStatus?.lastSyncError) && (
          <span className="plan-error">{error ?? syncError ?? syncStatus?.lastSyncError}</span>
        )}
        {!syncing && lastSyncSummary(syncStatus) && (
          <span className="muted small">{lastSyncSummary(syncStatus)}</span>
        )}
        <button
          type="button"
          className="risk-chip"
          disabled={syncing}
          title="Ignore the incremental watermark: re-fetch and re-map every issue matching the profile JQL. Use after mapping/logic changes or when things look stale."
          onClick={() => sync(true)}
        >
          Full re-sync
        </button>
        <button type="button" className="plan-btn" onClick={() => sync()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      <SyncProgressBar status={syncStatus} />
      {(syncStatus?.lastReports ?? []).flatMap((r) => r.warnings ?? []).length > 0 && (
        <div className="sync-warnings">
          {(syncStatus?.lastReports ?? [])
            .flatMap((r) => r.warnings ?? [])
            .map((w) => (
              <div key={w}>⚠ {w}</div>
            ))}
        </div>
      )}
      <div className="planning-scroll">
        {configError && (
          <section>
            <h2 className="plan-h2">Connection settings</h2>
            <div className="plan-error">
              Could not load Jira settings: {configError} — is the server build current? (git pull +
              npm run build:work, then restart)
            </div>
          </section>
        )}
        {config && <SettingsCard config={config} onSaved={refresh} />}
        <SprintsSection sprints={sprints} onOpenNote={onOpenNote} onChanged={refresh} />
        {config && <WritebackSection config={config} onChanged={refresh} />}
        <IssuesSection issues={issues} onOpenNote={onOpenNote} />
      </div>
    </div>
  );
}

// --------------------------------------------------------------- settings

function SettingsCard({ config, onSaved }: { config: JiraConfig; onSaved: () => void }) {
  const [open, setOpen] = useState(!config.baseUrl);
  const [draft, setDraft] = useState<JiraConfig>(config);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [probe, setProbe] = useState<string | null>(null);
  const [probeOk, setProbeOk] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const save = () => {
    setSaving(true);
    setProbe(null);
    jiraApi
      .saveConfig({
        baseUrl: draft.baseUrl,
        proxyUrl: draft.proxyUrl,
        deployment: draft.deployment,
        auth: draft.auth,
        projectKeys: draft.projectKeys,
        estimateField: draft.estimateField,
        estimateUnit: draft.estimateUnit,
        writeback: draft.writeback,
        profiles: draft.profiles,
        ...(token ? { token } : {}),
        ...(email ? { email } : {}),
      })
      .then(() => {
        setToken('');
        onSaved();
      })
      .catch((e: Error) => {
        setProbe(e.message);
        setProbeOk(false);
      })
      .finally(() => setSaving(false));
  };

  const testConnection = () => {
    setProbe('testing…');
    jiraApi
      .probe()
      .then((r) => {
        setProbe(`connected: ${r.deployment} (v${r.version})`);
        setProbeOk(true);
      })
      .catch((e: Error) => {
        setProbe(e.message);
        setProbeOk(false);
      });
  };

  const setProfile = (i: number, patch: Partial<JiraProfileCfg>) =>
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    }));

  return (
    <section>
      <h2 className="plan-h2">
        <button type="button" className="group-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Connection settings
        </button>
      </h2>
      {open && (
        <div className="settings-card">
          <div className="settings-grid">
            <label htmlFor="j-url">Jira URL</label>
            <input
              id="j-url"
              placeholder="https://jira.yourcompany.com"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
            <label htmlFor="j-proxy">proxy (optional)</label>
            <input
              id="j-proxy"
              placeholder="http://proxy.yourco.com:8080 — leave empty for direct / env vars"
              value={draft.proxyUrl}
              onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })}
            />
            <label htmlFor="j-auth">auth</label>
            <select
              id="j-auth"
              value={draft.auth}
              onChange={(e) => setDraft({ ...draft, auth: e.target.value as JiraConfig['auth'] })}
            >
              <option value="bearer">Bearer token (Data Center PAT)</option>
              <option value="basic">Basic: email + API token (Cloud)</option>
            </select>
            {draft.auth === 'basic' && (
              <>
                <label htmlFor="j-email">email</label>
                <input
                  id="j-email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </>
            )}
            <label htmlFor="j-token">token</label>
            <input
              id="j-token"
              type="password"
              placeholder={config.tokenSet ? '(unchanged)' : 'paste your token'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <label htmlFor="j-keys">project keys</label>
            <input
              id="j-keys"
              placeholder="EXEC, OPS"
              value={draft.projectKeys.join(', ')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  projectKeys: e.target.value
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean),
                })
              }
            />
            <label htmlFor="j-est">estimate field</label>
            <input
              id="j-est"
              placeholder="customfield_10016"
              value={draft.estimateField}
              onChange={(e) => setDraft({ ...draft, estimateField: e.target.value })}
            />
            <label htmlFor="j-unit">estimate unit</label>
            <select
              id="j-unit"
              value={draft.estimateUnit}
              onChange={(e) =>
                setDraft({ ...draft, estimateUnit: e.target.value as JiraConfig['estimateUnit'] })
              }
            >
              <option value="points">story points</option>
              <option value="days">days</option>
              <option value="hours">hours</option>
              <option value="seconds">seconds (time estimate)</option>
            </select>
            <label htmlFor="j-writeback">write-back</label>
            <select
              id="j-writeback"
              value={draft.writeback}
              onChange={(e) =>
                setDraft({ ...draft, writeback: e.target.value as JiraConfig['writeback'] })
              }
            >
              <option value="off">off — never write to Jira (default)</option>
              <option value="dry-run">dry-run — simulate and journal only</option>
              <option value="on">ON — apply reviewed batches to Jira</option>
            </select>
          </div>

          <h3 className="plan-h2">Sync profiles</h3>
          {draft.profiles.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; names are editable and may repeat
            <div key={`profile-${i}`} className="profile-row">
              <input
                style={{ width: 90 }}
                placeholder="name"
                defaultValue={p.name}
                onBlur={(e) => setProfile(i, { name: e.target.value })}
              />
              <input
                style={{ flex: 1, minWidth: 200 }}
                placeholder="JQL, e.g. project = EXEC AND updated >= -90d"
                defaultValue={p.jql}
                onBlur={(e) => setProfile(i, { jql: e.target.value })}
              />
              <input
                style={{ width: 70 }}
                placeholder="boards"
                title="Agile board ids, comma separated"
                defaultValue={p.boards.join(',')}
                onBlur={(e) =>
                  setProfile(i, {
                    boards: e.target.value
                      .split(',')
                      .map((x) => Number(x.trim()))
                      .filter((x) => Number.isInteger(x) && x > 0),
                  })
                }
              />
              <input
                style={{ width: 55 }}
                type="number"
                title="Sync every N minutes (0 = manual only)"
                defaultValue={p.intervalMinutes}
                onBlur={(e) => setProfile(i, { intervalMinutes: Number(e.target.value) || 0 })}
              />
              <button
                type="button"
                className="risk-chip clear"
                onClick={() =>
                  setDraft((d) => ({ ...d, profiles: d.profiles.filter((_, idx) => idx !== i) }))
                }
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="risk-chip"
            onClick={() => {
              setProbe('looking up boards…');
              setProbeOk(false);
              jiraApi
                .boards(draft.projectKeys[0])
                .then((boards) => {
                  setProbeOk(true);
                  setProbe(
                    boards.length
                      ? `boards: ${boards.map((b) => `${b.id} = ${b.name} (${b.type})`).join(' · ')} — put the Scrum board id in the boards column`
                      : 'no boards visible for this project/token',
                  );
                })
                .catch((e: Error) => setProbe(e.message));
            }}
          >
            🔍 find board ids
          </button>
          <button
            type="button"
            className="risk-chip"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                profiles: [
                  ...d.profiles,
                  {
                    name: `profile-${d.profiles.length + 1}`,
                    jql: '',
                    folder: 'jira',
                    intervalMinutes: 0,
                    boards: [],
                    futureSprints: 3,
                  },
                ],
              }))
            }
          >
            + add profile
          </button>

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center' }}>
            <button type="button" className="plan-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
            <button
              type="button"
              className="risk-chip"
              style={{ marginLeft: 8 }}
              onClick={testConnection}
            >
              Test connection
            </button>
            {probe && <span className={`probe-result ${probeOk ? 'ok' : 'err'}`}>{probe}</span>}
          </div>
          <p className="muted small">
            The token is stored in <code>.corpobrain/secrets.json</code> (gitignored), never in
            config. You can also set <code>CORPOBRAIN_JIRA_TOKEN</code> in the environment instead.
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- sprints

function SprintsSection({
  sprints,
  onOpenNote,
  onChanged,
}: {
  sprints: SprintRow[];
  onOpenNote: (path: string) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const create = () => {
    if (!name.trim()) return;
    setErr(null);
    jiraApi
      .createSprint({
        name: name.trim(),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      })
      .then(() => {
        setName('');
        setStart('');
        setEnd('');
        onChanged();
      })
      .catch((e: Error) => setErr(e.message));
  };

  return (
    <section>
      <h2 className="plan-h2">Sprints</h2>
      <div className="sprint-cards">
        {sprints.map((s) => (
          <div key={s.id} className={`sprint-card${s.source === 'local' ? ' local' : ''}`}>
            <div className="sprint-name">
              {s.path ? (
                <button
                  type="button"
                  className="key-link"
                  onClick={() => onOpenNote(s.path as string)}
                >
                  {s.name}
                </button>
              ) : (
                s.name
              )}
              <span className="sprint-badge">{s.source === 'local' ? 'local only' : 'jira'}</span>
            </div>
            <div className="muted small">
              {s.state}
              {s.start && ` · ${s.start.slice(0, 10)}`}
              {s.end && ` → ${s.end.slice(0, 10)}`}
            </div>
            {s.goal && <div className="muted small">{s.goal}</div>}
          </div>
        ))}
        {sprints.length === 0 && (
          <span className="muted">No sprints yet — sync Jira or create one.</span>
        )}
      </div>
      <div className="sprint-create">
        <input
          placeholder="New local sprint name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button type="button" className="plan-btn" onClick={create}>
          + Create local sprint
        </button>
        {err && <span className="plan-error">{err}</span>}
      </div>
      <p className="muted small">
        Local sprints (dashed) exist only in this app — plan into them freely; Jira never sees them.
        They become columns on the Planning board.
      </p>
    </section>
  );
}

// ----------------------------------------------------------------- issues

function IssuesSection({
  issues,
  onOpenNote,
}: {
  issues: JiraIssueRow[];
  onOpenNote: (path: string) => void;
}) {
  const [text, setText] = useState('');
  const [epic, setEpic] = useState('');
  const [label, setLabel] = useState('');
  const [cat, setCat] = useState('');
  const [groupByEpic, setGroupByEpic] = useState(false);

  const epics = useMemo(
    () => [...new Set(issues.map((i) => i.epic).filter((e): e is string => !!e))].sort(),
    [issues],
  );
  const labels = useMemo(() => [...new Set(issues.flatMap(labelsOf))].sort(), [issues]);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return issues
      .filter((i) => !cat || i.status_category === cat)
      .filter((i) => !epic || i.epic === epic)
      .filter((i) => !label || labelsOf(i).includes(label))
      .filter(
        (i) =>
          !q ||
          i.key.toLowerCase().includes(q) ||
          (i.summary ?? '').toLowerCase().includes(q) ||
          (i.assignee ?? '').toLowerCase().includes(q),
      );
  }, [issues, text, epic, label, cat]);

  const groups = useMemo(() => {
    if (!groupByEpic) return [['', filtered]] as [string, JiraIssueRow[]][];
    const m = new Map<string, JiraIssueRow[]>();
    for (const i of filtered) {
      const k = i.epic ?? '(no epic)';
      const arr = m.get(k) ?? [];
      arr.push(i);
      m.set(k, arr);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered, groupByEpic]);

  const row = (i: JiraIssueRow) => (
    <tr key={i.key}>
      <td>
        <button type="button" className="key-link" onClick={() => onOpenNote(i.path)}>
          {i.key}
        </button>
      </td>
      <td className="summary-cell" title={i.summary ?? ''}>
        {i.summary}
      </td>
      <td className="muted">
        <span
          className="status-dot"
          style={{ background: statusColor(i.status, i.status_category) }}
        />
        {i.status}
      </td>
      <td className="muted">{i.assignee ?? '—'}</td>
      <td className="muted">{i.sprint ?? '—'}</td>
      {!groupByEpic && <td className="muted">{i.epic ?? '—'}</td>}
      <td>
        {labelsOf(i).map((l) => (
          <span key={l} className="label-chip">
            {l}
          </span>
        ))}
      </td>
      <td className="muted">{i.estimate ?? '—'}</td>
      <td className="muted">{i.updated?.slice(0, 10)}</td>
    </tr>
  );

  return (
    <section>
      <h2 className="plan-h2">Issues ({filtered.length})</h2>
      <div className="views-bar" style={{ borderBottom: 'none', paddingLeft: 0 }}>
        <input
          className="plan-filter"
          placeholder="Filter…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select className="cell-input" value={epic} onChange={(e) => setEpic(e.target.value)}>
          <option value="">all epics</option>
          {epics.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
        <select className="cell-input" value={label} onChange={(e) => setLabel(e.target.value)}>
          <option value="">all labels</option>
          {labels.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
        <select className="cell-input" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">any status</option>
          <option value="new">to do</option>
          <option value="indeterminate">in progress</option>
          <option value="done">done</option>
        </select>
        <label className="muted small">
          <input
            type="checkbox"
            checked={groupByEpic}
            onChange={(e) => setGroupByEpic(e.target.checked)}
          />{' '}
          group by epic
        </label>
      </div>
      <div className="grid-wrap">
        <table className="issue-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Summary</th>
              <th>Status</th>
              <th>Assignee</th>
              <th>Sprint</th>
              {!groupByEpic && <th>Epic</th>}
              <th>Labels</th>
              <th>Est.</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(([g, items]) => (
              <FragmentRows
                key={g || '(all)'}
                group={groupByEpic ? g : null}
                items={items}
                row={row}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FragmentRows({
  group,
  items,
  row,
}: {
  group: string | null;
  items: JiraIssueRow[];
  row: (i: JiraIssueRow) => React.ReactNode;
}) {
  return (
    <>
      {group !== null && (
        <tr className="epic-group-header">
          <td colSpan={8}>
            {group} <span className="muted">({items.length})</span>
          </td>
        </tr>
      )}
      {items.map(row)}
    </>
  );
}

function labelsOf(i: JiraIssueRow): string[] {
  try {
    const v = JSON.parse(i.labels_json ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
