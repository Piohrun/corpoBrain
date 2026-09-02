import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type TaskItem } from '../api.ts';
import { localISODate } from '../dates.ts';
import { useVaultEvents } from '../hooks.ts';
import { lsGet, lsSet } from '../storage.ts';
import { WikiText } from './WikiText.tsx';

type Kind = 'task' | 'jira';

/** Group a column's items the same way, so both sides read alike. */
/** one group per source note, alphabetical, open tasks first inside each */
function groupByNote(items: TaskItem[]): [string, TaskItem[]][] {
  const m = new Map<string, TaskItem[]>();
  for (const t of items) m.set(t.title, [...(m.get(t.title) ?? []), t]);
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([title, list]) => [title, [...list].sort((a, b) => a.done - b.done || a.line - b.line)]);
}

/** ↑/↓ between task rows; x toggles the focused one — no mouse needed */
function onTaskKeys(e: React.KeyboardEvent<HTMLElement>, toggleFocused: (el: HTMLElement) => void) {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const boxes = [
      ...e.currentTarget.querySelectorAll<HTMLElement>('.task-row input[type=checkbox]'),
    ];
    const at = boxes.indexOf(target);
    if (at < 0) return;
    e.preventDefault();
    boxes[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  } else if (e.key === 'x' && target.closest('.task-row')) {
    e.preventDefault();
    toggleFocused(target);
  }
}

function groupTasks(items: TaskItem[]): [string, TaskItem[]][] {
  const overdue: TaskItem[] = [];
  const today: TaskItem[] = [];
  const upcoming: TaskItem[] = [];
  const someday: TaskItem[] = [];
  const done: TaskItem[] = [];
  const now = localISODate();
  for (const t of items) {
    if (t.done) done.push(t);
    else if (!t.due) someday.push(t);
    else if (t.due < now) overdue.push(t);
    else if (t.due === now) today.push(t);
    else upcoming.push(t);
  }
  return (
    [
      ['Overdue', overdue],
      ['Today', today],
      ['Upcoming', upcoming],
      ['No date', someday],
      ['Done', done],
    ] as [string, TaskItem[]][]
  ).filter(([, list]) => list.length > 0);
}

export function TasksPage({
  onOpenNote,
  onNoteChanged,
}: {
  onOpenNote: (path: string) => void;
  onNoteChanged: (path: string) => void;
}) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [groupMode, setGroupMode] = useState<'due' | 'note'>(() =>
    lsGet('cb.tasks.group', 'due') === 'note' ? 'note' : 'due',
  );
  useEffect(() => lsSet('cb.tasks.group', groupMode), [groupMode]);
  const todayPath = useRef<string | null>(null);
  useEffect(() => {
    api
      .daily()
      .then((d) => {
        todayPath.current = d.path;
      })
      .catch(() => {});
  }, []);
  const [newText, setNewText] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newKind, setNewKind] = useState<Kind>('task');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .tasks()
      .then(setTasks)
      .catch(() => {});
  }, []);

  const addTask = useCallback(() => {
    const text = newText.trim();
    if (!text) return;
    const box = newKind === 'jira' ? 'j[ ]' : '[ ]';
    const line = `- ${box} ${text}${newDue ? ` 📅 ${newDue}` : ''}`;
    api
      .daily()
      .then((d) => api.note(d.path))
      .then(async (note) => {
        const sep = note.content.endsWith('\n') ? '' : '\n';
        await api.save(note.path, `${note.content}${sep}${line}\n`);
        return note.path;
      })
      .then((path) => {
        onNoteChanged(path);
        setNewText('');
        setNewDue('');
        setError(null);
        refresh();
      })
      .catch((e: Error) => setError(e.message));
  }, [newText, newDue, newKind, onNoteChanged, refresh]);

  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  const toggle = useCallback(
    (t: TaskItem) => {
      api
        .toggleTask(t.path, t.line)
        .then(() => {
          onNoteChanged(t.path);
          setError(null);
          refresh();
        })
        .catch((e: Error) => {
          // 409: the note moved under us — refetch so the box reflects the file
          setError(e.message);
          refresh();
        });
    },
    [onNoteChanged, refresh],
  );

  /** copy an open task into today's daily note and tick the original */
  const pullToToday = useCallback(
    (t: TaskItem) => {
      api
        .daily()
        .then((d) => api.note(d.path))
        .then(async (note) => {
          const sep = note.content.endsWith('\n') ? '' : '\n';
          const line = `- ${t.kind === 'jira' ? 'j[ ]' : '[ ]'} ${t.text}${t.due ? ` 📅 ${t.due}` : ''} (from [[${t.title}]])`;
          await api.save(note.path, `${note.content}${sep}${line}\n`);
          await api.toggleTask(t.path, t.line);
          onNoteChanged(note.path);
          onNoteChanged(t.path);
        })
        .then(() => {
          setError(null);
          refresh();
        })
        .catch((e: Error) => setError(e.message));
    },
    [onNoteChanged, refresh],
  );

  const columns = useMemo(() => {
    const visible = tasks.filter((t) => showDone || !t.done);
    const group = groupMode === 'note' ? groupByNote : groupTasks;
    return {
      task: group(visible.filter((t) => t.kind !== 'jira')),
      jira: group(visible.filter((t) => t.kind === 'jira')),
    };
  }, [tasks, showDone, groupMode]);
  const byKey = useMemo(() => new Map(tasks.map((t) => [`${t.path}:${t.line}`, t])), [tasks]);

  const openCount = (kind: Kind) =>
    tasks.filter((t) => !t.done && (kind === 'jira' ? t.kind === 'jira' : t.kind !== 'jira'))
      .length;

  const column = (kind: Kind, title: string, hint: string) => {
    const groups = columns[kind];
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: keyboard handling for the rows' own checkboxes
      <section
        className={`task-col${kind === 'jira' ? ' jira' : ''}`}
        onKeyDown={(e) =>
          onTaskKeys(e, (el) => {
            const key = el.closest<HTMLElement>('.task-row')?.dataset.task;
            const t = key ? byKey.get(key) : undefined;
            if (t) toggle(t);
          })
        }
      >
        <h2 className="plan-h2 task-col-head">
          {title}
          <span className="health-badge">{openCount(kind)}</span>
        </h2>
        {groups.length === 0 ? (
          <p className="health-empty">{hint}</p>
        ) : (
          groups.map(([label, items]) => (
            <div key={label}>
              <h3 className={`task-group${label === 'Overdue' ? ' overdue' : ''}`}>{label}</h3>
              {items.map((t) => (
                <div
                  key={`${t.path}:${t.line}`}
                  className="task-row"
                  data-task={`${t.path}:${t.line}`}
                >
                  <input
                    type="checkbox"
                    className={kind === 'jira' ? 'jira-box' : ''}
                    aria-label={`done: ${t.text}`}
                    checked={t.done === 1}
                    onChange={() => toggle(t)}
                  />
                  <WikiText
                    text={t.text}
                    className={t.done ? 'muted done-task' : ''}
                    onOpen={onOpenNote}
                  />
                  {t.due && (
                    <button
                      type="button"
                      className="due-chip clickable"
                      title={`Open daily note ${t.due}`}
                      onClick={() => {
                        api
                          .daily(t.due as string)
                          .then((r) => onOpenNote(r.path))
                          .catch(() => {});
                      }}
                    >
                      {t.due}
                    </button>
                  )}
                  {!t.done && t.path !== todayPath.current && (
                    <button
                      type="button"
                      className="task-pull"
                      title="Copy into today’s daily note and tick it off here"
                      onClick={() => pullToToday(t)}
                    >
                      → today
                    </button>
                  )}
                  <button
                    type="button"
                    className="key-link small"
                    onClick={() => onOpenNote(t.path)}
                  >
                    {t.title}
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </section>
    );
  };

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Tasks</span>
        <span className="muted">
          {openCount('task')} open · {openCount('jira')} jiras
        </span>
        <div className="digest-ranges" title="What the quick-add box creates">
          <button
            type="button"
            className={`tab${newKind === 'task' ? ' active' : ''}`}
            onClick={() => setNewKind('task')}
          >
            task
          </button>
          <button
            type="button"
            className={`tab${newKind === 'jira' ? ' active' : ''}`}
            onClick={() => setNewKind('jira')}
          >
            jira
          </button>
        </div>
        <input
          className="plan-filter"
          placeholder={
            newKind === 'jira'
              ? 'Jira to create → today’s daily note…'
              : 'Quick task → today’s daily note…'
          }
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTask();
          }}
        />
        <input
          type="date"
          className="cell-input"
          title="Due date (optional)"
          value={newDue}
          onChange={(e) => setNewDue(e.target.value)}
        />
        <button type="button" className="plan-btn" onClick={addTask} disabled={!newText.trim()}>
          + Add
        </button>
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        <span className="digest-ranges" title="Group tasks by due date or by the note they live in">
          <button
            type="button"
            className={`tab${groupMode === 'due' ? ' active' : ''}`}
            onClick={() => setGroupMode('due')}
          >
            by due
          </button>
          <button
            type="button"
            className={`tab${groupMode === 'note' ? ' active' : ''}`}
            onClick={() => setGroupMode('note')}
          >
            by note
          </button>
        </span>
        <label className="muted small">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />{' '}
          show done
        </label>
      </div>
      <div className="planning-scroll">
        <div className="task-cols">
          {column('task', 'Tasks', 'Nothing open. Write `- [ ] something` in any note.')}
          {column(
            'jira',
            'Jiras to create or prioritise',
            'Nothing queued. Write `- j[ ] something` in any note.',
          )}
        </div>
      </div>
    </div>
  );
}
