import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AvailabilityEntry,
  type AvailabilityResponse,
  availabilityApi,
  type HolidayEntry,
  planApi,
} from '../api.ts';
import { localISODate, monthsAgo } from '../dates.ts';
import { useDialogs } from '../dialogs.tsx';
import { ctxTarget } from '../finder/ContextMenu.tsx';
import { rankBy } from '../finder/match.ts';
import { useFinderSections } from '../finder/registry.tsx';
import { type FinderSection, section } from '../finder/types.ts';
import { revealRow, useVirtualRows } from './virtualRows.tsx';

/** rows keep a stable client id so editing and deleting do not shuffle inputs */
type DraftEntry = AvailabilityEntry & { rowId: string };
let rowSeq = 0;
const withId = (e: AvailabilityEntry): DraftEntry => ({ ...e, rowId: `r${++rowSeq}` });

const ARCHIVE_MONTHS = 3;
const archiveCutoff = (): string => monthsAgo(ARCHIVE_MONTHS);

/**
 * Who is out, when — the team's out-of-office and support rota. The month
 * grid answers "who is around", the table below is the source of truth (the
 * same table that lives in the vault note, so it can also be edited in the
 * editor or pasted in from a spreadsheet), and the impact list shows what it
 * does to each sprint's bandwidth.
 */
export function AvailabilityPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const dlg = useDialogs();
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [holidays, setHolidays] = useState<(HolidayEntry & { rowId: string })[]>([]);
  const [holidaysDirty, setHolidaysDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // read synchronously by load(): a refresh must not wipe unsaved table edits
  const dirtyRef = useRef({ entries: false, holidays: false });
  const markDirty = (which: 'entries' | 'holidays') => {
    dirtyRef.current[which] = true;
    if (which === 'entries') setDirty(true);
    else setHolidaysDirty(true);
  };

  /**
   * Re-read from the server. Dirty tables keep their draft unless `replace`
   * says the server copy is now the truth (right after our own save).
   */
  const load = useCallback((replace: 'entries' | 'holidays' | 'all' | 'none' = 'none') => {
    availabilityApi
      .get()
      .then((d) => {
        setData(d);
        if (replace === 'entries' || replace === 'all' || !dirtyRef.current.entries) {
          setDraft(d.entries.map(withId));
          setDirty(false);
          dirtyRef.current.entries = false;
        }
        if (replace === 'holidays' || replace === 'all' || !dirtyRef.current.holidays) {
          setHolidays(d.holidays.map((h) => ({ ...h, rowId: `h${++rowSeq}` })));
          setHolidaysDirty(false);
          dirtyRef.current.holidays = false;
        }
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => load('all'), [load]);

  const edit = (idx: number, patch: Partial<AvailabilityEntry>) => {
    setDraft((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    markDirty('entries');
  };

  const persist = (rows: DraftEntry[]) => {
    setSaving(true);
    availabilityApi
      .save(rows.map(({ rowId: _rowId, ...e }) => e))
      .then(() => {
        setSaving(false);
        load('entries');
      })
      .catch((e: Error) => {
        setSaving(false);
        setError(e.message);
      });
  };
  const save = () => persist(draft);

  /** Drawn on the month grid: goes straight into the table and is saved. */
  const addEntry = (e: AvailabilityEntry) => {
    const next = [...draft, withId(e)];
    setDraft(next);
    persist(next);
  };
  const addEntryRef = useRef(addEntry);
  addEntryRef.current = addEntry;
  const addEntryStable = useCallback((e: AvailabilityEntry) => addEntryRef.current(e), []);

  // ---- Ctrl+F here: people → jump to their row or add an entry for today ----
  const finderSections = useMemo<FinderSection[]>(() => {
    const people = data?.people ?? [];
    // the month grid renders only rows near the screen: it scrolls the row in and flashes it
    const jump = (path: string) => revealRow('availability', path);
    const today = localISODate();
    return [
      section<(typeof people)[number]>({
        id: 'av-people',
        title: 'People',
        order: 10,
        limit: 8,
        search: (q) =>
          rankBy(people, q, (p) => [p.name, p.path]).map(({ row, score }) => ({
            id: row.path,
            label: row.name,
            icon: '👤',
            data: row,
            score,
          })),
        resolve: (id) => {
          const row = people.find((p) => p.path === id);
          return row ? { id: row.path, label: row.name, icon: '👤', data: row } : null;
        },
        actions: [
          {
            id: 'jump',
            label: 'jump to row',
            run: ([p], ctx) => {
              ctx.close();
              if (p) jump(p.data.path);
            },
          },
          {
            id: 'ooo',
            label: 'add time off today',
            run: ([p], ctx) => {
              ctx.close();
              if (p)
                addEntryRef.current({
                  person: p.data.name,
                  from: today,
                  to: today,
                  kind: 'ooo',
                  note: '',
                });
            },
          },
          {
            id: 'support',
            label: 'add support rota today',
            run: ([p], ctx) => {
              ctx.close();
              if (p)
                addEntryRef.current({
                  person: p.data.name,
                  from: today,
                  to: today,
                  kind: 'support',
                  note: '',
                });
            },
          },
          {
            id: 'open',
            label: 'open person',
            run: ([p], ctx) => {
              ctx.close();
              if (p) onOpenNote(p.data.path);
            },
          },
        ],
      }),
    ];
  }, [data, onOpenNote]);
  useFinderSections('availability', finderSections);

  const saveHolidays = () => {
    availabilityApi
      .saveHolidays(holidays.map(({ rowId: _r, ...h }) => h))
      .then(() => load('holidays'))
      .catch((e: Error) => setError(e.message));
  };

  const seed = async () => {
    if (
      holidaysDirty &&
      !(await dlg.confirm(
        'Seeding reloads the holiday table and discards your unsaved edits. Continue?',
      ))
    )
      return;
    availabilityApi
      .seedHolidays()
      .then(() => load('holidays'))
      .catch((e: Error) => setError(e.message));
  };

  const editHoliday = (idx: number, patch: Partial<HolidayEntry>) => {
    setHolidays((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    markDirty('holidays');
  };

  const archivable = useMemo(() => {
    const cutoff = archiveCutoff();
    return (data?.entries ?? []).filter((e) => e.to < cutoff).length;
  }, [data]);

  const archive = async () => {
    if (
      dirty &&
      !(await dlg.confirm('Archiving reloads the table and discards your unsaved edits. Continue?'))
    )
      return;
    availabilityApi
      .archive(ARCHIVE_MONTHS)
      .then((r) => {
        load('entries');
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
        <WeekStrip data={data} entries={draft} onOpenNote={onOpenNote} />
        <MonthGrid data={data} entries={draft} onAdd={addEntryStable} onOpenNote={onOpenNote} />

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
                      aria-label="person"
                      value={e.person}
                      onChange={(ev) => edit(i, { person: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      type="date"
                      aria-label="from"
                      value={e.from}
                      onChange={(ev) => edit(i, { from: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      type="date"
                      aria-label="to"
                      value={e.to}
                      onChange={(ev) => edit(i, { to: ev.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="cell-input"
                      aria-label="type"
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
                      aria-label="note"
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
                        markDirty('entries');
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
                from: localISODate(),
                to: localISODate(),
                kind: 'ooo',
                note: '',
              }),
            ]);
            markDirty('entries');
          }}
        >
          + entry
        </button>

        <h2 className="plan-h2">
          Bank holidays
          <span className="muted small">
            {' '}
            — apply to everyone with that country on their person note
          </span>
        </h2>
        {data.holidayWarnings.map((w) => (
          <p key={w} className="avail-warn">
            ⚠ {w}
          </p>
        ))}
        <div className="grid-wrap">
          <table className="issue-table avail-table">
            <thead>
              <tr>
                <th>Country</th>
                <th>From</th>
                <th>To</th>
                <th>Name</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {holidays.map((h, i) => (
                <tr key={h.rowId}>
                  <td>
                    <input
                      className="cell-input"
                      list="hol-countries"
                      aria-label="country"
                      value={h.country}
                      onChange={(ev) => editHoliday(i, { country: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      type="date"
                      aria-label="from"
                      value={h.from}
                      onChange={(ev) => editHoliday(i, { from: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input"
                      type="date"
                      aria-label="to"
                      value={h.to}
                      onChange={(ev) => editHoliday(i, { to: ev.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input wide"
                      aria-label="holiday name"
                      value={h.name}
                      onChange={(ev) => editHoliday(i, { name: ev.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="row-del"
                      title="Remove this holiday"
                      onClick={() => {
                        setHolidays((rows) => rows.filter((_, j) => j !== i));
                        markDirty('holidays');
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="hol-countries">
            {['China', 'India', 'Poland', 'UK', 'USA', 'Canada'].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
        <div className="hol-actions">
          <button
            type="button"
            className="plan-btn add-row"
            onClick={() => {
              setHolidays((rows) => [
                ...rows,
                {
                  country: '',
                  from: localISODate(),
                  to: localISODate(),
                  name: '',
                  rowId: `h${++rowSeq}`,
                },
              ]);
              markDirty('holidays');
            }}
          >
            + holiday
          </button>
          {holidaysDirty && (
            <button type="button" className="plan-btn add-row" onClick={saveHolidays}>
              save holidays
            </button>
          )}
          <button
            type="button"
            className="plan-btn add-row"
            onClick={seed}
            title="Merge the built-in 2026–27 bank holidays for China, India, Poland, UK, USA and Canada (no duplicates)"
          >
            🌍 add built-in 2026–27 set
          </button>
          <button
            type="button"
            className="plan-btn add-row"
            onClick={() => onOpenNote(data.holidaysFile)}
          >
            open holidays note
          </button>
        </div>

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
                      {r.holiday > 0 && (
                        <span className="avail-chip holiday">{r.holiday}d holiday</span>
                      )}
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
                              .then(() => load())
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
/** days shown from the neighbouring months, so a trip over month-end reads as one */
const EDGE_DAYS = 5;

type DrawKind = Exclude<AvailabilityEntry['kind'], 'holiday'>;

function MonthGrid({
  data,
  entries,
  onAdd,
  onOpenNote,
}: {
  data: AvailabilityResponse;
  /** the table as currently drafted (so a just-drawn entry shows at once) */
  entries: AvailabilityEntry[];
  onAdd: (e: AvailabilityEntry) => void;
  onOpenNote: (path: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });
  const [drawKind, setDrawKind] = useState<DrawKind>('ooo');
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ path: string; name: string; from: number; to: number } | null>(
    null,
  );
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const days = useMemo(() => {
    const out: { date: string; day: number; weekend: boolean; outside: boolean }[] = [];
    const d = new Date(Date.UTC(month.y, month.m, 1));
    d.setUTCDate(d.getUTCDate() - EDGE_DAYS);
    const end = new Date(Date.UTC(month.y, month.m + 1, 1));
    end.setUTCDate(end.getUTCDate() + EDGE_DAYS);
    while (d < end) {
      out.push({
        date: d.toISOString().slice(0, 10),
        day: d.getUTCDate(),
        weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
        outside: d.getUTCMonth() !== month.m,
      });
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }, [month]);

  // drag across a person's row → one entry from the first to the last day touched
  const dayAt = useCallback(
    (clientX: number): number => {
      const el = gridRef.current;
      if (!el) return 0;
      const x = clientX - el.getBoundingClientRect().left - NAME_W;
      return Math.max(0, Math.min(days.length - 1, Math.floor(x / CELL)));
    },
    [days.length],
  );
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const to = dayAt(e.clientX);
      setDrag((d) => (d && d.to !== to ? { ...d, to } : d));
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      const a = days[Math.min(d.from, d.to)];
      const b = days[Math.max(d.from, d.to)];
      if (!a || !b) return;
      onAdd({ person: d.name, from: a.date, to: b.date, kind: drawKind, note: '' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, dayAt, days, drawKind, onAdd]);

  // Typing in the draft table stays responsive: the 16k-cell grid follows in
  // the background rather than on every keystroke.
  const deferredEntries = useDeferredValue(entries);
  // person path → date → entry; precedence: leave > bank holiday > support
  const cover = useMemo(() => {
    const RANK = { ooo: 3, holiday: 2, support: 1 } as const;
    const norm = (s: string) => s.trim().toLowerCase();
    const basename = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/i, '');
    const m = new Map<string, Map<string, AvailabilityEntry>>();
    const put = (path: string, e: AvailabilityEntry) => {
      const per = m.get(path) ?? new Map<string, AvailabilityEntry>();
      for (const d of days) {
        if (d.date < e.from || d.date > e.to) continue;
        const had = per.get(d.date);
        if (!had || RANK[e.kind] > RANK[had.kind]) per.set(d.date, e);
      }
      m.set(path, per);
    };
    // name, path or file name → person, built once instead of a scan per entry
    const byKey = new Map<string, string>();
    for (const p of [...data.people].reverse())
      for (const k of [norm(basename(p.path)), norm(p.path), norm(p.name)]) byKey.set(k, p.path);
    for (const e of deferredEntries) {
      const path = byKey.get(norm(e.person));
      if (path) put(path, e);
    }
    for (const h of data.holidays) {
      const c = norm(h.country);
      for (const p of data.people) {
        if (!p.country || norm(p.country) !== c) continue;
        put(p.path, { person: p.path, from: h.from, to: h.to, kind: 'holiday', note: h.name });
      }
    }
    return m;
  }, [data, deferredEntries, days]);

  const label = new Date(Date.UTC(month.y, month.m, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const nav = (delta: number) =>
    setMonth(({ y, m }) => {
      const d = new Date(Date.UTC(y, m + delta, 1));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });
  const today = localISODate();
  // the same order as everywhere else: the notes-tree position, then name
  const people = useMemo(
    () =>
      [...data.people].sort(
        (a, b) =>
          (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
          a.name.localeCompare(b.name),
      ),
    [data.people],
  );
  const startDraw = useCallback(
    (path: string, name: string, idx: number) => setDrag({ path, name, from: idx, to: idx }),
    [],
  );
  // only the rows near the visible part of the page are rendered
  const personKeys = useMemo(() => people.map((p) => p.path), [people]);
  const grid = useVirtualRows({
    list: 'availability',
    keys: personKeys,
    estimate: 24,
    onRevealed: (path) => {
      const el = document.querySelector<HTMLElement>(`.av-row[data-path="${CSS.escape(path)}"]`);
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1600);
    },
  });

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
          <i className="avail-chip holiday">bank holiday</i>
          <i className="avail-chip support">support rota</i>
        </span>
        <span className="spacer" />
        <span className="av-draw" title="Drag across a person's row to add an entry of this kind">
          draw as
          <button
            type="button"
            className={`plan-btn small${drawKind === 'ooo' ? ' active' : ''}`}
            onClick={() => setDrawKind('ooo')}
          >
            out of office
          </button>
          <button
            type="button"
            className={`plan-btn small${drawKind === 'support' ? ' active' : ''}`}
            onClick={() => setDrawKind('support')}
          >
            support
          </button>
        </span>
      </div>
      <div className="grid-wrap">
        <div
          ref={gridRef}
          className={`av-grid${drag ? ' dragging' : ''}`}
          style={{ width: NAME_W + days.length * CELL }}
        >
          <div className="av-row av-head">
            <span className="av-name" />
            {days.map((d) => (
              <span
                key={d.date}
                className={`av-day${d.weekend ? ' weekend' : ''}${d.date === today ? ' today' : ''}${
                  d.outside ? ' outside' : ''
                }`}
                title={d.date}
              >
                {d.day}
              </span>
            ))}
          </div>
          <div
            ref={grid.anchorRef as React.RefObject<HTMLDivElement>}
            className="av-pad"
            style={{ height: grid.padTop }}
          />
          {people.slice(grid.start, grid.end).map((p) => (
            <AvRow
              key={p.path}
              rowRef={grid.measure(p.path)}
              person={p}
              days={days}
              cover={cover.get(p.path)}
              today={today}
              drawKind={drawKind}
              drawRange={
                drag?.path === p.path
                  ? `${Math.min(drag.from, drag.to)}:${Math.max(drag.from, drag.to)}`
                  : null
              }
              onStart={startDraw}
              onOpenNote={onOpenNote}
            />
          ))}
          <div className="av-pad" style={{ height: grid.padBottom }} />
        </div>
      </div>
    </section>
  );
}

/**
 * One person's row of the month grid. Memoized: drawing on a row, or editing
 * the table below, re-renders that row only, not all of them.
 */
const AvRow = memo(function AvRow({
  person,
  days,
  cover,
  today,
  drawKind,
  drawRange,
  onStart,
  onOpenNote,
  rowRef,
}: {
  person: { path: string; name: string };
  days: { date: string; day: number; weekend: boolean; outside: boolean }[];
  cover: Map<string, AvailabilityEntry> | undefined;
  today: string;
  drawKind: DrawKind;
  /** "from:to" while this row is being drawn on */
  drawRange: string | null;
  onStart: (path: string, name: string, idx: number) => void;
  onOpenNote: (path: string) => void;
  /** measures the row for the virtualized grid; stable per person */
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const [from, to] = drawRange ? drawRange.split(':').map(Number) : [-1, -2];
  return (
    <div
      ref={rowRef}
      className="av-row"
      data-path={person.path}
      {...ctxTarget('av-people', person.path)}
      // one handler for the row instead of one per day cell
      onPointerDown={(ev) => {
        const idx = Number((ev.target as HTMLElement).dataset.idx);
        if (ev.button !== 0 || Number.isNaN(idx)) return;
        ev.preventDefault();
        onStart(person.path, person.name, idx);
      }}
    >
      <span className="av-name">
        <button type="button" className="key-link" onClick={() => onOpenNote(person.path)}>
          {person.name}
        </button>
      </span>
      {days.map((d, idx) => {
        const e = cover?.get(d.date);
        const drawing = idx >= (from as number) && idx <= (to as number);
        return (
          <span
            key={d.date}
            data-idx={idx}
            className={`av-cell${d.weekend ? ' weekend' : ''}${d.date === today ? ' today' : ''}${
              d.outside ? ' outside' : ''
            }${e ? ` ${e.kind}` : ''}${drawing ? ` drawing ${drawKind}` : ''}`}
            title={
              e
                ? `${person.name} · ${
                    e.kind === 'ooo'
                      ? 'out of office'
                      : e.kind === 'holiday'
                        ? 'bank holiday'
                        : 'support rota'
                  } ${e.from} → ${e.to}${e.note ? ` · ${e.note}` : ''}`
                : `${person.name} · ${d.date} — drag to add ${drawKind === 'ooo' ? 'time off' : 'support rota'}`
            }
          />
        );
      })}
    </div>
  );
});

// -------------------------------------------------------------- this week

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => localISODate(d);
const weekdayShort = (iso: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

/**
 * The question the page usually answers, in one line: who is out this week
 * and who is on support, with the days. Entries come from the draft so a
 * just-drawn absence shows at once.
 */
function WeekStrip({
  data,
  entries,
  onOpenNote,
}: {
  data: AvailabilityResponse;
  entries: AvailabilityEntry[];
  onOpenNote: (path: string) => void;
}) {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const days = Array.from({ length: 5 }, (_, i) => isoDay(new Date(monday.getTime() + i * DAY_MS)));
  const first = days[0] as string;
  const last = days[4] as string;
  const norm = (x: string) => x.trim().toLowerCase();
  const basename = (p: string) => (p.split('/').pop() ?? p).replace(/\.md$/i, '');
  const personOf = (name: string) =>
    data.people.find(
      (p) =>
        norm(p.name) === norm(name) ||
        norm(p.path) === norm(name) ||
        norm(basename(p.path)) === norm(name),
    );
  type Row = { path: string; name: string; days: string[] };
  const collect = (kinds: AvailabilityEntry['kind'][]): Row[] => {
    const m = new Map<string, Row>();
    const add = (path: string, name: string, from: string, to: string) => {
      const hit = days.filter((d) => d >= from && d <= to);
      if (!hit.length) return;
      const row = m.get(path) ?? { path, name, days: [] };
      row.days = [...new Set([...row.days, ...hit])].sort();
      m.set(path, row);
    };
    for (const e of entries) {
      if (!kinds.includes(e.kind)) continue;
      const p = personOf(e.person);
      if (p) add(p.path, p.name, e.from, e.to);
    }
    if (kinds.includes('holiday')) {
      for (const h of data.holidays) {
        for (const p of data.people) {
          if (p.country && norm(p.country) === norm(h.country)) add(p.path, p.name, h.from, h.to);
        }
      }
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const out = collect(['ooo', 'holiday']);
  const support = collect(['support']);
  const span = (r: Row) =>
    r.days.length === 5
      ? 'all week'
      : r.days.length === 1
        ? weekdayShort(r.days[0] as string)
        : `${weekdayShort(r.days[0] as string)}–${weekdayShort(r.days[r.days.length - 1] as string)}`;
  const list = (rows: Row[]) =>
    rows.map((r, i) => (
      <span key={r.path}>
        {i > 0 && ', '}
        <button type="button" className="key-link" onClick={() => onOpenNote(r.path)}>
          {r.name}
        </button>
        <span className="muted"> {span(r)}</span>
      </span>
    ));
  return (
    <div className="week-strip">
      <b>
        This week{' '}
        <span className="muted">
          {new Date(`${first}T00:00:00`).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
          –
          {new Date(`${last}T00:00:00`).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
          })}
        </span>
      </b>
      <span className="week-part">
        <i className="avail-chip ooo">out</i>{' '}
        {out.length ? list(out) : <span className="muted">nobody</span>}
      </span>
      <span className="week-part">
        <i className="avail-chip support">support</i>{' '}
        {support.length ? list(support) : <span className="muted">nobody</span>}
      </span>
    </div>
  );
}
