import { useCallback, useEffect, useState } from 'react';
import { type BoardPerson, type GitStatus, gitApi, planApi } from '../api.ts';
import { nameColorHex } from '../colors.ts';

type Theme = 'system' | 'light' | 'dark';
const STATUS_COLORS: { key: string; label: string; fallback: string }[] = [
  { key: 'st-todo', label: 'to do / backlog', fallback: '#8a8a84' },
  { key: 'st-progress', label: 'in progress', fallback: '#3f83f8' },
  { key: 'st-ready', label: 'ready / review / release', fallback: '#9061f9' },
  { key: 'st-done', label: 'done', fallback: '#31a05f' },
];

const ACCENTS = [
  { id: '', label: 'indigo', color: '#5b6ee1' },
  { id: 'teal', label: 'teal', color: '#0e9488' },
  { id: 'amber', label: 'amber', color: '#b45309' },
  { id: 'rose', label: 'rose', color: '#be3455' },
  { id: 'violet', label: 'violet', color: '#7c5cd6' },
];

function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(() => (lsGet('cb.theme') as Theme) || 'system');
  const [accent, setAccent] = useState(() => lsGet('cb.accent'));
  const [git, setGit] = useState<GitStatus | null>(null);
  const [hubs, setHubs] = useState<BoardPerson[]>([]);

  const [planCfg, setPlanCfg] = useState<{
    unit: string;
    defaultCapacity: number | null;
    health: { bigIssue: number; staleDays: number; underloadPct: number };
  } | null>(null);
  const refreshHubs = useCallback(() => {
    planApi
      .board()
      .then((b) => {
        setHubs(b.people.filter((p) => p.name === p.region || p.name === p.team));
        setPlanCfg({ unit: b.unit, defaultCapacity: b.defaultCapacity, health: b.health });
      })
      .catch(() => {});
  }, []);
  useEffect(refreshHubs, [refreshHubs]);
  const [statusColors, setStatusColors] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('cb.colors') ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  });

  const applyStatusColor = (key: string, value: string | null) => {
    // side effects outside the updater: StrictMode runs updaters twice
    const next = { ...statusColors };
    if (value) next[key] = value;
    else delete next[key];
    setStatusColors(next);
    try {
      localStorage.setItem('cb.colors', JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    if (value) document.documentElement.style.setProperty(`--${key}`, value);
    else document.documentElement.style.removeProperty(`--${key}`);
  };
  const [gitMsg, setGitMsg] = useState<string | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);

  const applyTheme = (t: Theme) => {
    setTheme(t);
    try {
      if (t === 'system') {
        localStorage.removeItem('cb.theme');
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem('cb.theme', t);
        document.documentElement.dataset.theme = t;
      }
    } catch {
      /* storage unavailable */
    }
  };

  const applyAccent = (a: string) => {
    setAccent(a);
    try {
      if (a) {
        localStorage.setItem('cb.accent', a);
        document.documentElement.dataset.accent = a;
      } else {
        localStorage.removeItem('cb.accent');
        delete document.documentElement.dataset.accent;
      }
    } catch {
      /* storage unavailable */
    }
  };

  const refreshGit = useCallback(() => {
    gitApi
      .status()
      .then(setGit)
      .catch(() => {});
  }, []);
  useEffect(refreshGit, [refreshGit]);

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Settings</span>
        <span className="muted small">appearance is per browser; the vault is untouched</span>
      </div>
      <div className="planning-scroll">
        <section>
          <h2 className="plan-h2">Appearance</h2>
          <div className="settings-card">
            <div className="settings-grid">
              <label htmlFor="s-theme">theme</label>
              <select
                id="s-theme"
                value={theme}
                onChange={(e) => applyTheme(e.target.value as Theme)}
              >
                <option value="system">follow system</option>
                <option value="light">light</option>
                <option value="dark">dark</option>
              </select>
              <label htmlFor="s-accent">accent</label>
              <div className="swatch-row" id="s-accent">
                {ACCENTS.map((a) => (
                  <button
                    type="button"
                    key={a.id || 'default'}
                    className={`swatch${accent === a.id ? ' active' : ''}`}
                    style={{ background: a.color }}
                    title={a.label}
                    onClick={() => applyAccent(a.id)}
                  />
                ))}
              </div>
              <label htmlFor="s-status-0">status colors</label>
              <div>
                {STATUS_COLORS.map((c, idx) => (
                  <div key={c.key} className="status-color-row">
                    <ColorPicker
                      id={idx === 0 ? 's-status-0' : undefined}
                      label={`${c.label} color`}
                      value={statusColors[c.key] ?? c.fallback}
                      onCommit={(v) => applyStatusColor(c.key, v)}
                    />
                    <span className="muted small">{c.label}</span>
                    {statusColors[c.key] && (
                      <button
                        type="button"
                        className="tag-clear"
                        title="Reset to default"
                        onClick={() => applyStatusColor(c.key, null)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {planCfg && (
          <section>
            <h2 className="plan-h2">Planning</h2>
            <div className="settings-card">
              <div className="settings-grid">
                <label htmlFor="s-defcap">default capacity</label>
                <input
                  id="s-defcap"
                  type="number"
                  step="0.5"
                  placeholder="— (none: assign per person)"
                  defaultValue={planCfg.defaultCapacity ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value);
                    if (v === planCfg.defaultCapacity) return;
                    planApi
                      .saveCapacityConfig({ defaultCapacity: v })
                      .then(refreshHubs)
                      .catch(() => {});
                  }}
                />
                <label htmlFor="s-unit">capacity unit</label>
                <select
                  id="s-unit"
                  value={planCfg.unit}
                  onChange={(e) => {
                    planApi
                      .saveCapacityConfig({ unit: e.target.value })
                      .then(refreshHubs)
                      .catch(() => {});
                  }}
                >
                  <option value="days">person-days</option>
                  <option value="points">story points</option>
                  <option value="hours">hours</option>
                </select>
              </div>
              <p className="muted small">
                People without an explicit capacity inherit the default on the planning board;
                per-person values (Organize panel or the grid) always win.
              </p>
              <div className="settings-grid">
                <label htmlFor="s-bigissue">split issues at or above</label>
                <input
                  id="s-bigissue"
                  type="number"
                  step="1"
                  min="1"
                  defaultValue={planCfg.health.bigIssue}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!(v > 0) || v === planCfg.health.bigIssue) return;
                    planApi.saveCapacityConfig({ health: { bigIssue: v } }).catch(() => {});
                  }}
                />
                <label htmlFor="s-staledays">stalled after (days)</label>
                <input
                  id="s-staledays"
                  type="number"
                  step="1"
                  min="1"
                  defaultValue={planCfg.health.staleDays}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!(v > 0) || v === planCfg.health.staleDays) return;
                    planApi.saveCapacityConfig({ health: { staleDays: v } }).catch(() => {});
                  }}
                />
                <label htmlFor="s-underload">spare bandwidth below (%)</label>
                <input
                  id="s-underload"
                  type="number"
                  step="5"
                  min="1"
                  max="100"
                  defaultValue={Math.round(planCfg.health.underloadPct * 100)}
                  onBlur={(e) => {
                    const v = Number(e.target.value) / 100;
                    if (!(v > 0) || v === planCfg.health.underloadPct) return;
                    planApi.saveCapacityConfig({ health: { underloadPct: v } }).catch(() => {});
                  }}
                />
              </div>
              <p className="muted small">
                Thresholds for Planning → Sprint health: issues at or above the first number are
                flagged for splitting, in-progress issues untouched for that many days count as
                stalled, and people below that share of their bandwidth are listed as having room.
              </p>
            </div>
          </section>
        )}

        {hubs.length > 0 && (
          <section>
            <h2 className="plan-h2">Region &amp; team colors</h2>
            <div className="settings-card">
              <p className="muted small">
                Stored on the hub note (shared via the vault, unlike the per-browser theme). Unset
                hubs use an automatic color derived from the name.
              </p>
              {hubError && <p className="plan-error">{hubError}</p>}
              {hubs.map((h) => (
                <div key={h.path} className="status-color-row">
                  <ColorPicker
                    label={`${h.name} color`}
                    value={h.color ?? nameColorHex(h.name)}
                    onCommit={(v) => {
                      planApi
                        .patchPerson({ path: h.path, color: v })
                        .then(refreshHubs)
                        .catch((e: Error) => setHubError(e.message));
                    }}
                  />
                  <span className="muted small">
                    {h.name} {h.name === h.region ? '(region)' : '(team)'}
                  </span>
                  {h.color && (
                    <button
                      type="button"
                      className="tag-clear"
                      title="Back to automatic color"
                      onClick={() => {
                        planApi
                          .patchPerson({ path: h.path, color: null })
                          .then(refreshHubs)
                          .catch((e: Error) => setHubError(e.message));
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="plan-h2">Vault history (git)</h2>
          <div className="settings-card git-card">
            {!git ? (
              <span className="muted">loading…</span>
            ) : !git.available ? (
              <p className="plan-error">git is not installed or not on PATH — history disabled.</p>
            ) : (
              <>
                <p className="muted small">
                  {git.isRepo
                    ? `repo OK · auto-commit ${git.autoCommit ? `every ${git.intervalMinutes}m` : 'off'} · ${git.dirtyFiles} uncommitted file(s)`
                    : 'the vault is not a git repository yet'}
                </p>
                {git.head && (
                  <p className="muted small">
                    last commit: <code>{git.head.hash}</code> · {git.head.date.slice(0, 16)} ·{' '}
                    {git.head.message}
                  </p>
                )}
                {git.lastError && <p className="plan-error">last git error: {git.lastError}</p>}
                <button
                  type="button"
                  className="plan-btn"
                  onClick={() => {
                    setGitMsg('committing…');
                    gitApi
                      .commit()
                      .then((r) => {
                        setGitMsg(r.hash ? `committed ${r.hash}` : 'nothing to commit');
                        refreshGit();
                      })
                      .catch((e: Error) => {
                        setGitMsg(e.message);
                        refreshGit();
                      });
                  }}
                >
                  {git.isRepo ? 'Commit now' : 'Initialize repo + commit'}
                </button>
                {gitMsg && <span className="probe-result ok"> {gitMsg}</span>}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * A colour input that commits once the picker closes. Browsers fire
 * `input`/`change` on every tick while dragging in the picker, which for the
 * hub colours meant one vault write per tick.
 */
function ColorPicker({
  id,
  label,
  value,
  onCommit,
}: {
  id?: string | undefined;
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [live, setLive] = useState(value);
  // follow the outside value when it changes (reset, another browser)
  useEffect(() => setLive(value), [value]);
  const commit = () => {
    if (live !== value) onCommit(live);
  };
  return (
    <input
      id={id}
      type="color"
      aria-label={label}
      value={live}
      onChange={(e) => setLive(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
