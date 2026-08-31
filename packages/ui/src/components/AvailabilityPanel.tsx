import { useCallback, useEffect, useState } from 'react';
import {
  type AvailabilityEntry,
  type AvailabilityResponse,
  availabilityApi,
  planApi,
} from '../api.ts';

const today = (): string => new Date().toISOString().slice(0, 10);

/** rows keep a stable client id so editing and deleting do not shuffle inputs */
type DraftEntry = AvailabilityEntry & { rowId: string };
let rowSeq = 0;
const withId = (e: AvailabilityEntry): DraftEntry => ({ ...e, rowId: `r${++rowSeq}` });

/**
 * The OOO / support-rota table. It is the same table that lives in the vault
 * note, so it can be edited here, in the editor, or pasted in from a
 * spreadsheet — and a calendar sync can fill it later without changing
 * anything downstream.
 */
export function AvailabilityPanel({
  onOpenNote,
  onChanged,
}: {
  onOpenNote: (path: string) => void;
  onChanged: () => void;
}) {
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
        onChanged();
      })
      .catch((e: Error) => {
        setSaving(false);
        setError(e.message);
      });
  };

  if (error && !data) return <section className="plan-error">Availability: {error}</section>;
  if (!data) return <section className="health-empty">Loading availability…</section>;

  const people = data.people;
  const impact = data.rows;

  return (
    <section className="avail">
      <div className="health-head">
        <span className="health-count">
          {draft.length} entr{draft.length === 1 ? 'y' : 'ies'}
        </span>
        <span className="health-stat">
          feeding {data.sprints.length} sprint{data.sprints.length === 1 ? '' : 's'} · support weeks
          count as {Math.round((1 - data.supportFactor) * 100)}% away
        </span>
        <span className="spacer" />
        {dirty && (
          <button type="button" className="plan-btn" onClick={save} disabled={saving}>
            {saving ? 'saving…' : 'save table'}
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
              from: today(),
              to: today(),
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
        <p className="health-empty">Nothing in the table overlaps the sprints on the board yet.</p>
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
                        {r.overridden && <span className="muted small"> (override in force)</span>}
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
                            .then(() => {
                              load();
                              onChanged();
                            })
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
    </section>
  );
}
