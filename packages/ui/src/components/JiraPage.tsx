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
        {(syncError || syncStatus?.lastSyncError) && (
          <span className="plan-error">{syncError ?? syncStatus?.lastSyncError}</span>
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

/** a profile row with a stable client id and its boards as typed (not yet parsed) */
type DraftProfile = JiraProfileCfg & { rowId: string; boardsText: string };
let profileSeq = 0;
const toDraftProfile = (p: JiraProfileCfg): DraftProfile => ({
  ...p,
  rowId: `p${++profileSeq}`,
  boardsText: p.boards.join(','),
});
const parseBoards = (text: string): number[] =>
  text
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);

function SettingsCard({ config, onSaved }: { config: JiraConfig; onSaved: () => void }) {
  const [open, setOpen] = useState(!config.baseUrl);
  const [draft, setDraft] = useState<JiraConfig>(config);
  const [profiles, setProfiles] = useState<DraftProfile[]>(() =>
    config.profiles.map(toDraftProfile),
  );
  /** unsaved edits: a background refresh must not wipe them */
  const [dirty, setDirty] = useState(false);
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [probe, setProbe] = useState<string | null>(null);
  const [probeOk, setProbeOk] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dirty) return;
    setDraft(config);
    setProfiles(config.profiles.map(toDraftProfile));
  }, [config, dirty]);

  const edit = (patch: Partial<JiraConfig>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

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
        profiles: profiles.map(({ rowId: _id, boardsText, ...p }) => ({
          ...p,
          boards: parseBoards(boardsText),
        })),
        ...(token ? { token } : {}),
        ...(email ? { email } : {}),
      })
      .then(() => {
        setToken('');
        setDirty(false);
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

  const [devProbe, setDevProbe] = useState<{ text: string; ok: boolean } | null>(null);
  const testDevIntegration = () => {
    setDevProbe({ text: 'probing…', ok: true });
    jiraApi
      .devProbe()
      .then((r) => {
        if (r.ok) {
          const c = r.counts;
          setDevProbe({
            ok: true,
            text: `development panel available${r.instances.length ? ` (${r.instances.join(', ')})` : ''}: ${r.key} has ${c.pullrequest} PR${c.pullrequest === 1 ? '' : 's'}, ${c.branch} branch${c.branch === 1 ? '' : 'es'}, ${c.repository} repo${c.repository === 1 ? '' : 's'} — commit and PR history can be pulled through Jira`,
          });
        } else setDevProbe({ ok: false, text: r.reason });
      })
      .catch((e: Error) => setDevProbe({ ok: false, text: e.message }));
  };

  const setProfile = (rowId: string, patch: Partial<DraftProfile>) => {
    setProfiles((rows) => rows.map((p) => (p.rowId === rowId ? { ...p, ...patch } : p)));
    setDirty(true);
  };

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
              onChange={(e) => edit({ baseUrl: e.target.value })}
            />
            <label htmlFor="j-proxy">proxy (optional)</label>
            <input
              id="j-proxy"
              placeholder="http://proxy.yourco.com:8080 — leave empty for direct / env vars"
              value={draft.proxyUrl}
              onChange={(e) => edit({ proxyUrl: e.target.value })}
            />
            <label htmlFor="j-auth">auth</label>
            <select
              id="j-auth"
              value={draft.auth}
              onChange={(e) => edit({ auth: e.target.value as JiraConfig['auth'] })}
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
                edit({
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
              onChange={(e) => edit({ estimateField: e.target.value })}
            />
            <label htmlFor="j-unit">estimate unit</label>
            <select
              id="j-unit"
              value={draft.estimateUnit}
              onChange={(e) => edit({ estimateUnit: e.target.value as JiraConfig['estimateUnit'] })}
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
              onChange={(e) => edit({ writeback: e.target.value as JiraConfig['writeback'] })}
            >
              <option value="off">off — never write to Jira (default)</option>
              <option value="dry-run">dry-run — simulate and journal only</option>
              <option value="on">ON — apply reviewed batches to Jira</option>
            </select>
          </div>

          <h3 className="plan-h2">Sync profiles</h3>
          {profiles.map((p) => (
            <div key={p.rowId} className="profile-row">
              <input
                style={{ width: 90 }}
                placeholder="name"
                aria-label="profile name"
                value={p.name}
                onChange={(e) => setProfile(p.rowId, { name: e.target.value })}
              />
              <input
                style={{ flex: 1, minWidth: 200 }}
                placeholder="JQL, e.g. project = EXEC AND updated >= -90d"
                aria-label="profile JQL"
                value={p.jql}
                onChange={(e) => setProfile(p.rowId, { jql: e.target.value })}
              />
              <input
                style={{ width: 70 }}
                placeholder="boards"
                aria-label="agile board ids"
                title="Agile board ids, comma separated"
                value={p.boardsText}
                onChange={(e) => setProfile(p.rowId, { boardsText: e.target.value })}
              />
              <input
                style={{ width: 55 }}
                type="number"
                aria-label="sync interval in minutes"
                title="Sync every N minutes (0 = manual only)"
                value={p.intervalMinutes}
                onChange={(e) =>
                  setProfile(p.rowId, { intervalMinutes: Number(e.target.value) || 0 })
                }
              />
              <button
                type="button"
                className="risk-chip clear"
                title="Remove this profile"
                onClick={() => {
                  setProfiles((rows) => rows.filter((r) => r.rowId !== p.rowId));
                  setDirty(true);
                }}
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
            onClick={() => {
              setProfiles((rows) => [
                ...rows,
                toDraftProfile({
                  name: `profile-${rows.length + 1}`,
                  jql: '',
                  folder: 'jira',
                  intervalMinutes: 0,
                  boards: [],
                  futureSprints: 3,
                }),
              ]);
              setDirty(true);
            }}
          >
            + add profile
          </button>

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center' }}>
            <button type="button" className="plan-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : dirty ? 'Save settings *' : 'Save settings'}
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
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              className="risk-chip"
              onClick={testDevIntegration}
              title="Check whether this Jira exposes branches, commits and pull requests per issue (GitHub / Bitbucket integration)"
            >
              Test dev integration
            </button>
            {devProbe && (
              <span className={`probe-result ${devProbe.ok ? 'ok' : 'err'}`}>{devProbe.text}</span>
            )}
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
          aria-label="New local sprint name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <input
          type="date"
          aria-label="sprint start"
          value={start}
          onChange={(e) => setStart(e.target.value)}
        />
        <input
          type="date"
          aria-label="sprint end"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
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
          aria-label="Filter issues"
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
