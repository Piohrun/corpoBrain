import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type TaskItem } from '../api.ts';
import { localISODate } from '../dates.ts';
import { useVaultEvents } from '../hooks.ts';
import { WikiText } from './WikiText.tsx';

type Kind = 'task' | 'jira';

/** Group a column's items the same way, so both sides read alike. */
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

export function TasksPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [showDone, setShowDone] = useState(false);
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
      .then((note) => {
        const sep = note.content.endsWith('\n') ? '' : '\n';
        return api.save(note.path, `${note.content}${sep}${line}\n`);
      })
      .then(() => {
        setNewText('');
        setNewDue('');
        setError(null);
        refresh();
      })
      .catch((e: Error) => setError(e.message));
  }, [newText, newDue, newKind, refresh]);

  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  const toggle = useCallback(
    (t: TaskItem) => {
      api
        .toggleTask(t.path, t.line)
        .then(() => {
          setError(null);
          refresh();
        })
        .catch((e: Error) => {
          // 409: the note moved under us — refetch so the box reflects the file
          setError(e.message);
          refresh();
        });
    },
    [refresh],
  );

  const columns = useMemo(() => {
    const visible = tasks.filter((t) => showDone || !t.done);
    return {
      task: groupTasks(visible.filter((t) => t.kind !== 'jira')),
      jira: groupTasks(visible.filter((t) => t.kind === 'jira')),
    };
  }, [tasks, showDone]);

  const openCount = (kind: Kind) =>
    tasks.filter((t) => !t.done && (kind === 'jira' ? t.kind === 'jira' : t.kind !== 'jira'))
      .length;

  const column = (kind: Kind, title: string, hint: string) => {
    const groups = columns[kind];
    return (
      <section className={`task-col${kind === 'jira' ? ' jira' : ''}`}>
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
                <div key={`${t.path}:${t.line}`} className="task-row">
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
