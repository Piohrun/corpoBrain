import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type TrackedItem,
  type TrackKind,
  type TrackSourceState,
  trackedApi,
  treeApi,
} from '../api.ts';
import { localISODate } from '../dates.ts';
import { rankBy } from '../finder/match.ts';
import { useFinderSections } from '../finder/registry.tsx';
import { type FinderSection, section } from '../finder/types.ts';
import { useVaultEvents } from '../hooks.ts';
import { WikiText } from './WikiText.tsx';

const KINDS: { kind: TrackKind; label: string; icon: string }[] = [
  { kind: 'commitment', label: 'Commitments', icon: '✓' },
  { kind: 'decision', label: 'Decisions', icon: '◆' },
  { kind: 'risk', label: 'Risks', icon: '▲' },
  { kind: 'assumption', label: 'Assumptions', icon: '≈' },
];

const STATUSES: Record<TrackKind, { value: string; label: string }[]> = {
  commitment: [
    { value: 'open', label: 'Open' },
    { value: 'done', label: 'Done' },
    { value: 'dropped', label: 'Dropped' },
  ],
  decision: [
    { value: 'active', label: 'Active' },
    { value: 'superseded', label: 'Superseded' },
    { value: 'reversed', label: 'Reversed' },
  ],
  risk: [
    { value: 'open', label: 'Open' },
    { value: 'mitigated', label: 'Mitigated' },
    { value: 'accepted', label: 'Accepted' },
  ],
  assumption: [
    { value: 'active', label: 'Active' },
    { value: 'validated', label: 'Validated' },
    { value: 'invalidated', label: 'Invalidated' },
  ],
};

const CLOSED = new Set([
  'done',
  'dropped',
  'superseded',
  'reversed',
  'mitigated',
  'accepted',
  'validated',
  'invalidated',
]);

function isClosed(item: TrackedItem): boolean {
  return CLOSED.has(item.status);
}

const SOURCE_STATE: Record<TrackSourceState, string> = {
  unchanged: 'Synced with source',
  edited: 'Edited in source',
  removed: 'Text removed',
  missing: 'Missing from source',
  unanchored: 'Trace not attached',
};

export function TrackedPage({
  onOpenNote,
  onNoteChanged,
}: {
  onOpenNote: (path: string) => void;
  onNoteChanged: (path: string) => void;
}) {
  const [items, setItems] = useState<TrackedItem[]>([]);
  const [kind, setKind] = useState<TrackKind | 'all'>('all');
  const [showClosed, setShowClosed] = useState(false);
  const [query, setQuery] = useState('');

  // ---- Ctrl+F here: tracked items → open the record or its source, or filter the list ----
  const finderSections = useMemo<FinderSection[]>(
    () => [
      section<TrackedItem>({
        id: 'tracked-items',
        title: 'Tracked items',
        order: 10,
        limit: 10,
        search: (q) =>
          rankBy(items, q, (t) => [t.title, t.owner, t.sourceTitle, t.status], 60).map(
            ({ row, score }) => ({
              id: row.path,
              label: row.title,
              detail: `${row.kind} · ${row.status}${row.owner ? ` · ${row.owner}` : ''}`,
              hint: row.due ?? row.review ?? undefined,
              icon:
                row.kind === 'commitment'
                  ? '✓'
                  : row.kind === 'decision'
                    ? '◆'
                    : row.kind === 'risk'
                      ? '▲'
                      : '≈',
              data: row,
              score,
            }),
          ),
        actions: [
          {
            id: 'open',
            label: 'open record',
            run: ([t], ctx) => {
              ctx.close();
              if (t) onOpenNote(t.data.path);
            },
          },
          {
            id: 'source',
            label: 'open the source note',
            when: (list) => list.some((t) => t.data.sourcePath),
            run: ([t], ctx) => {
              ctx.close();
              if (t?.data.sourcePath) onOpenNote(t.data.sourcePath);
            },
          },
          {
            id: 'filter',
            label: 'filter the list',
            run: (_, ctx) => {
              ctx.close();
              setQuery(ctx.query);
            },
          },
        ],
      }),
    ],
    [items, onOpenNote],
  );
  useFinderSections('tracked', finderSections);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    trackedApi
      .list()
      .then((next) => {
        setItems(next);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  const update = useCallback(
    (item: TrackedItem, set: Record<string, unknown>) => {
      setSaving(item.path);
      setError(null);
      treeApi
        .meta({ path: item.path, set })
        .then(refresh)
        .catch((e: Error) => setError(e.message))
        .finally(() => setSaving(null));
    },
    [refresh],
  );

  const attach = useCallback(
    (item: TrackedItem) => {
      setSaving(item.path);
      setError(null);
      trackedApi
        .anchor(item.path)
        .then((result) => {
          onNoteChanged(result.sourcePath);
          refresh();
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setSaving(null));
    },
    [onNoteChanged, refresh],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (kind !== 'all' && item.kind !== kind) return false;
      if (!showClosed && isClosed(item)) return false;
      if (!needle) return true;
      return [
        item.title,
        item.excerpt,
        item.currentExcerpt,
        item.owner,
        item.sourceTitle,
        item.status,
        SOURCE_STATE[item.sourceState],
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [items, kind, query, showClosed]);

  const openCount = (filterKind?: TrackKind) =>
    items.filter((item) => !isClosed(item) && (!filterKind || item.kind === filterKind)).length;

  return (
    <div className="planning tracked-page">
      <div className="planning-header tracked-header">
        <span className="title">Tracked</span>
        <button
          type="button"
          className={`risk-chip${kind === 'all' ? ' active' : ''}`}
          onClick={() => setKind('all')}
        >
          All <b>{openCount()}</b>
        </button>
        {KINDS.map((item) => (
          <button
            type="button"
            key={item.kind}
            className={`risk-chip${kind === item.kind ? ' active' : ''}`}
            onClick={() => setKind(item.kind)}
          >
            {item.icon} {item.label} <b>{openCount(item.kind)}</b>
          </button>
        ))}
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        <input
          className="plan-filter"
          value={query}
          placeholder="Filter tracked items…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="muted small track-show-closed">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(event) => setShowClosed(event.target.checked)}
          />{' '}
          show closed
        </label>
      </div>

      <div className="planning-scroll tracked-scroll">
        {visible.map((item) => {
          const date = item.kind === 'commitment' ? item.due : item.review;
          const overdue =
            !isClosed(item) && item.kind === 'commitment' && Boolean(date && date < localISODate());
          return (
            <article
              key={item.path}
              className={`tracked-card ${item.kind}${isClosed(item) ? ' closed' : ''}`}
            >
              <div className="tracked-card-main">
                <div className="tracked-card-top">
                  <span className={`tracked-kind-badge ${item.kind}`}>
                    {KINDS.find((entry) => entry.kind === item.kind)?.icon} {item.kind}
                  </span>
                  <span className={`tracked-source-state ${item.sourceState}`}>
                    {SOURCE_STATE[item.sourceState]}
                  </span>
                  <button
                    type="button"
                    className="tracked-title"
                    onClick={() => onOpenNote(item.path)}
                  >
                    {item.title}
                  </button>
                </div>
                {item.sourceState === 'unchanged' &&
                  item.excerpt &&
                  item.excerpt !== item.title && (
                    <div className="tracked-excerpt">
                      <WikiText text={item.excerpt} onOpen={onOpenNote} />
                    </div>
                  )}
                {item.sourceState !== 'unchanged' && (
                  <div className={`tracked-change-trace ${item.sourceState}`}>
                    <div className="tracked-change-head">
                      <strong>Change trace</strong>
                      {item.sourceMtime && (
                        <span>source updated {new Date(item.sourceMtime).toLocaleString()}</span>
                      )}
                    </div>
                    <div className="tracked-change-version original">
                      <span>Originally tracked</span>
                      <WikiText text={item.excerpt} onOpen={onOpenNote} />
                    </div>
                    {item.sourceState === 'edited' && item.currentExcerpt !== null && (
                      <div className="tracked-change-version current">
                        <span>Now in the note</span>
                        <WikiText text={item.currentExcerpt} onOpen={onOpenNote} />
                      </div>
                    )}
                    {item.sourceState === 'removed' && (
                      <p>The tracked passage was cleared, but its anchor is still present.</p>
                    )}
                    {item.sourceState === 'missing' && (
                      <p>
                        The original snapshot is preserved here, but its anchor and matching text no
                        longer exist in the source note.
                      </p>
                    )}
                    {item.sourceState === 'unanchored' && (
                      <div className="tracked-attach-row">
                        <p>
                          This item predates live anchors. Its original text still exists and can be
                          linked safely.
                        </p>
                        <button
                          type="button"
                          className="plan-btn"
                          disabled={saving === item.path}
                          onClick={() => attach(item)}
                        >
                          Attach change trace
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div className="tracked-source-row">
                  {item.sourcePath && (
                    <button
                      type="button"
                      className="key-link"
                      onClick={() => onOpenNote(item.sourcePath as string)}
                    >
                      {item.sourceTitle ?? item.sourcePath}
                      {(item.currentLine ?? item.sourceLine)
                        ? ` · line ${item.currentLine ?? item.sourceLine}`
                        : ''}
                    </button>
                  )}
                  {item.created && <span>tracked {item.created.slice(0, 10)}</span>}
                </div>
              </div>

              <div className="tracked-controls">
                <label>
                  Status
                  <select
                    className="cell-input track-status"
                    value={item.status}
                    disabled={saving === item.path}
                    onChange={(event) => update(item, { status: event.target.value })}
                  >
                    {STATUSES[item.kind].map((status) => (
                      <option key={status.value} value={status.value}>
                        {status.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Owner
                  <input
                    key={`${item.path}:owner:${item.owner ?? ''}`}
                    className="cell-input track-owner"
                    defaultValue={item.owner ?? ''}
                    placeholder="—"
                    disabled={saving === item.path}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value !== (item.owner ?? '')) update(item, { owner: value || null });
                    }}
                  />
                </label>
                <label className={overdue ? 'overdue' : ''}>
                  {item.kind === 'commitment' ? 'Due' : 'Review'}
                  <input
                    key={`${item.path}:date:${date ?? ''}`}
                    type="date"
                    className="cell-input track-date"
                    defaultValue={date ?? ''}
                    disabled={saving === item.path}
                    onBlur={(event) => {
                      const value = event.target.value;
                      if (value !== (date ?? '')) {
                        update(item, {
                          [item.kind === 'commitment' ? 'due' : 'review']: value || null,
                        });
                      }
                    }}
                  />
                </label>
              </div>
            </article>
          );
        })}
        {visible.length === 0 && (
          <div className="empty-state tracked-empty">
            {items.length === 0
              ? 'Select meaningful text in a note and choose “Track as…” to create the first item.'
              : 'Nothing matches these filters.'}
          </div>
        )}
      </div>
    </div>
  );
}
