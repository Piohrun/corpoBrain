import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AvailabilityEntry,
  type AvailabilityResponse,
  availabilityApi,
  planApi,
} from '../api.ts';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** rows keep a stable client id so editing and deleting do not shuffle inputs */
type DraftEntry = AvailabilityEntry & { rowId: string };
let rowSeq = 0;
const withId = (e: AvailabilityEntry): DraftEntry => ({ ...e, rowId: `r${++rowSeq}` });

const ARCHIVE_MONTHS = 3;
const archiveCutoff = (): string => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - ARCHIVE_MONTHS);
  return d.toISOString().slice(0, 10);
};

/**
 * Who is out, when — the team's out-of-office and support rota. The month
 * grid answers "who is around", the table below is the source of truth (the
 * same table that lives in the vault note, so it can also be edited in the
 * editor or pasted in from a spreadsheet), and the impact list shows what it
 * does to each sprint's bandwidth.
 */
export function AvailabilityPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    availabilityApi
      .get()
      .then((d) => {
        setData(d);
        setDraft(d.entries.map(withId));
        setDirty(false);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const edit = (idx: number, patch: Partial<AvailabilityEntry>) => {
    setDraft((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const save = () => {
    setSaving(true);
    availabilityApi
      .save(draft.map(({ rowId: _rowId, ...e }) => e))
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((e: Error) => {
        setSaving(false);
        setError(e.message);
      });
  };

  const archivable = useMemo(() => {
    const cutoff = archiveCutoff();
    return (data?.entries ?? []).filter((e) => e.to < cutoff).length;
  }, [data]);

  const archive = () => {
    availabilityApi
      .archive(ARCHIVE_MONTHS)
      .then((r) => {
        load();
        if (r.files.length) setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };

  if (error && !data) {
    return (
      <div className="planning">
        <div className="empty-state">Availability: {error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="planning">
        <div className="empty-state">Loading availability…</div>
      </div>
    );
  }

  const people = data.people;
  const impact = data.rows;

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Availability</span>
        <span className="health-stat">
          {draft.length} entr{draft.length === 1 ? 'y' : 'ies'} · support weeks count as{' '}
          {Math.round((1 - data.supportFactor) * 100)}% away
        </span>
        <span className="spacer" />
        {dirty && (
          <button type="button" className="plan-btn" onClick={save} disabled={saving}>
            {saving ? 'saving…' : 'save table'}
          </button>
        )}
        {archivable > 0 && (
          <button
            type="button"
            className="plan-btn"
            onClick={archive}
            title={`Move entries that ended more than ${ARCHIVE_MONTHS} months ago into per-year archive notes`}
          >
            🗄 archive {archivable} old
          </button>
        )}
        <button type="button" className="plan-btn" onClick={() => onOpenNote(data.file)}>
          open note
        </button>
      </div>

      {error && <p className="plan-error">{error}</p>}
      {data.warnings.map((w) => (
        <p key={w} className="avail-warn">
          ⚠ {w}
        </p>
      ))}

      <div className="planning-scroll">
        <MonthGrid data={data} onOpenNote={onOpenNote} />

        <h2 className="plan-h2">Entries</h2>
        <div className="grid-wrap">
          <table className="issue-table avail-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>From</th>
                <th>To</th>
                <th>Type</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((e, i) => (
                <tr key={e.rowId}>
                  <td>
                    <input
                      className="cell-input"
                      list="avail-people"
                      value={e.person}
                      onChange={(ev) => edit(i, { person: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      type="date"
                      value={e.from}
                      onChange={(ev) => edit(i, { from: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      type="date"
                      value={e.to}
                      onChange={(ev) => edit(i, { to: ev.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      value={e.kind}
                      onChange={(ev) =>
                        edit(i, { kind: ev.target.value as AvailabilityEntry['kind'] })
                      }
                    >
                      <option value="ooo">out of office</option>
                      <option value="support">support rota</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="cell-input wide"
                      value={e.note}
                      onChange={(ev) => edit(i, { note: ev.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-del"
                      title="Remove this entry"
                      onClick={() => {
                        setDraft((rows) => rows.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="avail-people">
            {people.map((p) => (
              <option key={p.path} value={p.name} />
            ))}
          </datalist>
        </div>

        <button
          type="button"
          className="plan-btn add-row"
          onClick={() => {
            setDraft((rows) => [
              ...rows,
              withId({
                person: people[0]?.name ?? '',
                from: todayISO(),
                to: todayISO(),
                kind: 'ooo',
                note: '',
              }),
            ]);
            setDirty(true);
          }}
        >
          + entry
        </button>

        <h2 className="plan-h2">What this does to bandwidth</h2>
        {impact.length === 0 ? (
          <p className="health-empty">
            Nothing in the table overlaps the sprints on the board yet.
          </p>
        ) : (
          <div className="grid-wrap">
            <table className="issue-table">
              <thead>
                <tr>
                  <th>Sprint</th>
                  <th>Person</th>
                  <th>Away</th>
                  <th>Available</th>
                  <th>Bandwidth</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {impact.map((r) => (
                  <tr key={`${r.sprint}:${r.person}`}>
                    <td>{r.sprint}</td>
                    <td>
                      <button
                        type="button"
                        className="key-link"
                        onClick={() => r.path && onOpenNote(r.path)}
                      >
                        {r.name}
                      </button>
                    </td>
                    <td>
                      {r.ooo > 0 && <span className="avail-chip ooo">{r.ooo}d out</span>}
                      {r.support > 0 && (
                        <span className="avail-chip support">{r.support}d support</span>
                      )}
                    </td>
                    <td>
                      {r.available} of {r.total} days
                    </td>
                    <td>
                      {r.capacity === null ? (
                        <span className="muted">no bandwidth set</span>
                      ) : (
                        <>
                          <span className="load-committed">{r.capacity}</span> → <b>{r.adjusted}</b>{' '}
                          {data.unit}
                          {r.overridden && (
                            <span className="muted small"> (override in force)</span>
                          )}
                        </>
                      )}
                    </td>
                    <td>
                      {r.capacity !== null && !r.overridden && r.adjusted !== null && (
                        <button
                          type="button"
                          className="plan-btn small"
                          title="Write this into the person's per-sprint bandwidth override"
                          onClick={() =>
                            planApi
                              .patchPerson({
                                path: r.person,
                                overrides: { [r.sprint]: r.adjusted as number },
                              })
                              .then(load)
                              .catch((e: Error) => setError(e.message))
                          }
                        >
                          pin it
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- month grid

const CELL = 26;
const NAME_W = 150;

function MonthGrid({
  data,
  onOpenNote,
}: {
  data: AvailabilityResponse;
  onOpenNote: (path: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });

  const days = useMemo(() => {
    const out: { date: string; day: number; weekend: boolean }[] = [];
    const d = new Date(Date.UTC(month.y, month.m, 1));
    while (d.getUTCMonth() === month.m) {
      out.push({
        date: d.toISOString().slice(0, 10),
        day: d.getUTCDate(),
        weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
      });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }, [month]);

  // person path → date → entry (ooo wins over support)
  const cover = useMemo(() => {
    const norm = (s: string) => s.trim().toLowerCase();
    const basename = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/i, '');
    const m = new Map<string, Map<string, AvailabilityEntry>>();
    for (const e of data.entries) {
      const n = norm(e.person);
      const person = data.people.find(
        (p) => norm(p.name) === n || norm(p.path) === n || norm(basename(p.path)) === n,
      );
      if (!person) continue;
      const per = m.get(person.path) ?? new Map<string, AvailabilityEntry>();
      for (const d of days) {
        if (d.date < e.from || d.date > e.to) continue;
        const had = per.get(d.date);
        if (!had || (had.kind === 'support' && e.kind === 'ooo')) per.set(d.date, e);
      }
      m.set(person.path, per);
    }
    return m;
  }, [data, days]);

  const label = new Date(Date.UTC(month.y, month.m, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const nav = (delta: number) =>
    setMonth(({ y, m }) => {
      const d = new Date(Date.UTC(y, m + delta, 1));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });
  const today = todayISO();
  // the same order as everywhere else: the notes-tree position, then name
  const people = [...data.people].sort(
    (a, b) =>
      (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );

  return (
    <section className="av-cal">
      <div className="health-head">
        <button type="button" className="plan-btn" onClick={() => nav(-1)} title="Previous month">
          ‹
        </button>
        <span className="av-cal-label">{label}</span>
        <button type="button" className="plan-btn" onClick={() => nav(1)} title="Next month">
          ›
        </button>
        <span className="health-stat">
          <i className="avail-chip ooo">out of office</i>
          <i className="avail-chip support">support rota</i>
        </span>
      </div>
      <div className="grid-wrap">
        <div className="av-grid" style={{ width: NAME_W + days.length * CELL }}>
          <div className="av-row av-head">
            <span className="av-name" />
            {days.map((d) => (
              <span
                key={d.date}
                className={`av-day${d.weekend ? ' weekend' : ''}${d.date === today ? ' today' : ''}`}
              >
                {d.day}
              </span>
            ))}
          </div>
          {people.map((p) => (
            <div className="av-row" key={p.path}>
              <span className="av-name">
                <button type="button" className="key-link" onClick={() => onOpenNote(p.path)}>
                  {p.name}
                </button>
              </span>
              {days.map((d) => {
                const e = cover.get(p.path)?.get(d.date);
                return (
                  <span
                    key={d.date}
                    className={`av-cell${d.weekend ? ' weekend' : ''}${d.date === today ? ' today' : ''}${
                      e ? ` ${e.kind}` : ''
                    }`}
                    title={
                      e
                        ? `${p.name} · ${e.kind === 'ooo' ? 'out of office' : 'support rota'} ${e.from} → ${e.to}${e.note ? ` · ${e.note}` : ''}`
                        : undefined
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
