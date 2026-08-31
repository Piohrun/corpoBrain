import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type TaskItem } from '../api.ts';
import { useVaultEvents } from '../hooks.ts';
import { WikiText } from './WikiText.tsx';

export function TasksPage({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [showDone, setShowDone] = useState(false);

  const refresh = useCallback(() => {
    api
      .tasks()
      .then(setTasks)
      .catch(() => {});
  }, []);

  const [newText, setNewText] = useState('');
  const [newDue, setNewDue] = useState('');

  const addTask = useCallback(() => {
    const text = newText.trim();
    if (!text) return;
    const line = `- [ ] ${text}${newDue ? ` 📅 ${newDue}` : ''}`;
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
        refresh();
      })
      .catch(() => {});
  }, [newText, newDue, refresh]);

  useEffect(refresh, [refresh]);
  useVaultEvents(refresh);

  const toggle = useCallback(
    (t: TaskItem) => {
      fetch('/api/task/toggle', {
        method: 'POST',
        body: JSON.stringify({ path: t.path, line: t.line }),
      })
        .then(refresh)
        .catch(() => {});
    },
    [refresh],
  );

  const groups = useMemo(() => {
    const visible = tasks.filter((t) => showDone || !t.done);
    const overdue: TaskItem[] = [];
    const today: TaskItem[] = [];
    const upcoming: TaskItem[] = [];
    const someday: TaskItem[] = [];
    const done: TaskItem[] = [];
    const now = new Date().toISOString().slice(0, 10);
    for (const t of visible) {
      if (t.done) done.push(t);
      else if (!t.due) someday.push(t);
      else if (t.due < now) overdue.push(t);
      else if (t.due === now) today.push(t);
      else upcoming.push(t);
    }
    return [
      ['Overdue', overdue],
      ['Today', today],
      ['Upcoming', upcoming],
      ['No date', someday],
      ['Done', done],
    ].filter(([, items]) => (items as TaskItem[]).length > 0) as [string, TaskItem[]][];
  }, [tasks, showDone]);

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">Tasks</span>
        <span className="muted">{tasks.filter((t) => !t.done).length} open</span>
        <input
          className="plan-filter"
          placeholder="Quick task → today's daily note…"
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
        {groups.map(([label, items]) => (
          <section key={label}>
            <h2 className={`plan-h2${label === 'Overdue' ? ' overdue' : ''}`}>{label}</h2>
            {items.map((t) => (
              <div key={`${t.path}:${t.line}`} className="task-row">
                <input type="checkbox" checked={t.done === 1} onChange={() => toggle(t)} />
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
                <button type="button" className="key-link small" onClick={() => onOpenNote(t.path)}>
                  {t.title}
                </button>
              </div>
            ))}
          </section>
        ))}
        {groups.length === 0 && (
          <div className="empty-state">No tasks. Write some `- [ ]` items.</div>
        )}
      </div>
    </div>
  );
}
