import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type NoteListItem,
  type NoteResponse,
  type TagCount,
  type TreeModel,
  treeApi,
} from './api.ts';
import { AvailabilityPage } from './components/AvailabilityPage.tsx';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette.tsx';
import { DigestPage } from './components/DigestPage.tsx';
import { Editor } from './components/Editor.tsx';
import { JiraPage } from './components/JiraPage.tsx';
import { ObjectsPage } from './components/ObjectsPage.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { PlanningPage } from './components/PlanningPage.tsx';
import { PrivatePage } from './components/PrivatePage.tsx';
import { ProjectsPage } from './components/ProjectsPage.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TasksPage } from './components/TasksPage.tsx';
import { useVaultEvents } from './hooks.ts';

function hashPath(): string {
  return decodeURIComponent(window.location.hash.replace(/^#\//, ''));
}

/** Does the sidebar (note list, tags, tree) need refetching after this save? */
function listsAffected(prev: NoteResponse, fresh: NoteResponse): boolean {
  const meta = (n: NoteResponse) =>
    JSON.stringify([n.meta?.title, n.meta?.type, n.meta?.frontmatter ?? null, n.tags]);
  return meta(prev) !== meta(fresh);
}

export function App() {
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [view, setView] = useState<
    | 'notes'
    | 'planning'
    | 'projects'
    | 'availability'
    | 'digest'
    | 'tasks'
    | 'objects'
    | 'jira'
    | 'private'
    | 'settings'
  >('notes');
  const noteRef = useRef<NoteResponse | null>(null);
  noteRef.current = note;
  /** true while a delete is in flight, so the editor drops its pending save */
  const discardRef = useRef(false);
  /** sequence of note loads: a slow earlier response must not overtake a later click */
  const loadSeq = useRef(0);

  const refreshLists = useCallback(() => {
    api
      .notes()
      .then(setNotes)
      .catch(() => {});
    api
      .tags()
      .then(setTags)
      .catch(() => {});
    treeApi
      .get()
      .then(setTree)
      .catch(() => {});
  }, []);

  useEffect(refreshLists, [refreshLists]);

  const openPath = useCallback((path: string) => {
    const seq = ++loadSeq.current;
    api
      .note(path)
      .then((n) => {
        if (seq !== loadSeq.current) return; // a later open won
        setNote(n);
        setSaveState('saved');
        if (hashPath() !== path) window.location.hash = `#/${encodeURIComponent(path)}`;
      })
      .catch(() => {});
  }, []);

  // restore note from URL hash on load, and follow back/forward
  useEffect(() => {
    const fromHash = hashPath();
    if (fromHash) openPath(fromHash);
    const onHash = () => {
      const p = hashPath();
      if (p && p !== noteRef.current?.path) openPath(p);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openPath]);

  // live updates from the vault watcher
  useVaultEvents((paths) => {
    refreshLists();
    const current = noteRef.current;
    if (current && paths.includes(current.path)) {
      api
        .note(current.path)
        .then(setNote)
        .catch(() => {});
    }
  });

  const navigate = useCallback(
    (target: string) => {
      api
        .resolveOrCreate(target)
        .then((r) => {
          if (r.created) refreshLists();
          openPath(r.path);
        })
        .catch(() => {});
    },
    [openPath, refreshLists],
  );

  const openDaily = useCallback(() => {
    api
      .daily()
      .then((r) => {
        if (r.created) refreshLists();
        openPath(r.path);
      })
      .catch(() => {});
  }, [openPath, refreshLists]);

  const createNote = useCallback(
    (title: string) => {
      api
        .resolveOrCreate(title)
        .then((r) => {
          refreshLists();
          openPath(r.path);
        })
        .catch(() => {});
    },
    [openPath, refreshLists],
  );

  // refresh backlinks/properties after a save settles
  // Refresh backlinks/properties after a save settles. The sidebar lists
  // (notes, tags, tree) only change when the note's title, type, tags or
  // frontmatter did — a body edit leaves them alone, so skip the three
  // list fetches and the 1500-row tree re-render in that case.
  const onSaved = useCallback(() => {
    const current = noteRef.current;
    if (!current) return refreshLists();
    api
      .note(current.path)
      .then((fresh) => {
        const prev = noteRef.current;
        if (!prev || prev.path !== fresh.path) return refreshLists();
        if (listsAffected(prev, fresh)) refreshLists();
        setNote({ ...fresh, content: prev.content }); // do not clobber the editor
      })
      .catch(() => refreshLists());
  }, [refreshLists]);

  // global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'k')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        openDaily();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openDaily]);

  const commands: PaletteCommand[] = [
    { id: 'daily', label: 'Open today’s daily note', hint: 'Ctrl+D', run: openDaily },
    {
      id: 'reload',
      label: 'Reload note lists',
      run: refreshLists,
    },
  ];

  const completions = useCallback(
    () => notes.filter((n) => !n.protected).map((n) => ({ title: n.title, path: n.path })),
    [notes],
  );

  const openTag = useCallback((tag: string | null) => {
    setTagFilter(tag);
    if (tag) setView('notes');
  }, []);

  const resolveMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const l of note?.links ?? []) m.set(l.target.toLowerCase(), l.resolved);
    return m;
  }, [note?.links]);

  const openFromPlanning = useCallback(
    (path: string) => {
      setView('notes');
      openPath(path);
    },
    [openPath],
  );

  return (
    <div className="app">
      <nav className="rail">
        <button
          type="button"
          className={view === 'notes' ? 'active' : ''}
          onClick={() => setView('notes')}
          title="Notes"
        >
          ✎
        </button>
        <button
          type="button"
          className={view === 'planning' ? 'active' : ''}
          onClick={() => setView('planning')}
          title="Planning"
        >
          ▦
        </button>
        <button
          type="button"
          className={view === 'projects' ? 'active' : ''}
          onClick={() => setView('projects')}
          title="Projects: timeline, forecast and dependencies"
        >
          ◈
        </button>
        <button
          type="button"
          className={view === 'availability' ? 'active' : ''}
          onClick={() => setView('availability')}
          title="Availability: who is out when — feeds sprint bandwidth"
        >
          ✈
        </button>
        <button
          type="button"
          className={view === 'digest' ? 'active' : ''}
          onClick={() => setView('digest')}
          title="What changed in Jira since the last refresh"
        >
          ⟳
        </button>
        <button
          type="button"
          className={view === 'tasks' ? 'active' : ''}
          onClick={() => setView('tasks')}
          title="Tasks"
        >
          ☑
        </button>
        <button
          type="button"
          className={view === 'objects' ? 'active' : ''}
          onClick={() => setView('objects')}
          title="Objects"
        >
          ▤
        </button>
        <button
          type="button"
          className={view === 'jira' ? 'active' : ''}
          onClick={() => setView('jira')}
          title="Jira: settings, sprints, issues"
        >
          ⚙
        </button>
        <button
          type="button"
          className={view === 'settings' ? 'active' : ''}
          onClick={() => setView('settings')}
          title="Settings: appearance, vault history"
        >
          ◐
        </button>
        <button
          type="button"
          className={view === 'private' ? 'active' : ''}
          onClick={() => setView('private')}
          title="Protected notes"
        >
          🔒
        </button>
      </nav>
      {view === 'planning' ? (
        <PlanningPage onOpenNote={openFromPlanning} />
      ) : view === 'projects' ? (
        <ProjectsPage onOpenNote={openFromPlanning} />
      ) : view === 'availability' ? (
        <AvailabilityPage onOpenNote={openFromPlanning} />
      ) : view === 'digest' ? (
        <DigestPage onOpenNote={openFromPlanning} />
      ) : view === 'tasks' ? (
        <TasksPage onOpenNote={openFromPlanning} />
      ) : view === 'objects' ? (
        <ObjectsPage onOpenNote={openFromPlanning} />
      ) : view === 'jira' ? (
        <JiraPage onOpenNote={openFromPlanning} />
      ) : view === 'settings' ? (
        <SettingsPage />
      ) : view === 'private' ? (
        <PrivatePage />
      ) : (
        <>
          <Sidebar
            tree={tree}
            tags={tags}
            tagFilter={tagFilter}
            onTagFilter={openTag}
            currentPath={note?.path ?? null}
            onOpen={openPath}
            onDaily={openDaily}
            onNew={() => setPaletteOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onTreeChanged={(moved) => {
              refreshLists();
              const current = noteRef.current;
              if (!current) return;
              if (moved && current.path === moved.from) openPath(moved.to);
              else
                api
                  .note(current.path)
                  .then(setNote)
                  .catch(() => setNote(null));
            }}
          />
          <div className="main">
            {note ? (
              <>
                <div className="main-header">
                  <span className="title">{note.meta?.title ?? note.path}</span>
                  <span>{note.path}</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="note-delete"
                    title="Delete note (moved to .trash inside the vault)"
                    onClick={() => {
                      const current = noteRef.current;
                      if (!current) return;
                      if (!window.confirm(`Delete "${current.meta?.title ?? current.path}"?`))
                        return;
                      // the editor's debounced save must not resurrect the file
                      discardRef.current = true;
                      api
                        .remove(current.path)
                        .then(() => {
                          setNote(null);
                          history.replaceState(null, '', window.location.pathname);
                          refreshLists();
                        })
                        .catch((e: Error) => window.alert(`Delete failed: ${e.message}`))
                        .finally(() => {
                          discardRef.current = false;
                        });
                    }}
                  >
                    🗑
                  </button>
                  <span className="save-state">
                    {saveState === 'saved'
                      ? '✓ saved'
                      : saveState === 'saving'
                        ? 'saving…'
                        : '⚠ save failed'}
                  </span>
                </div>
                {note.path.startsWith('people/') && (
                  <PersonPanel path={note.path} onOpen={openPath} />
                )}
                <Editor
                  path={note.path}
                  content={note.content}
                  completions={completions}
                  resolveMap={resolveMap}
                  onNavigate={navigate}
                  onSnapshot={(path, content) =>
                    setNote((prev) => (prev && prev.path === path ? { ...prev, content } : prev))
                  }
                  onSaveState={(p, st) => {
                    // a save for the previous note must not relabel this one
                    if (noteRef.current?.path === p) setSaveState(st);
                  }}
                  onSaved={onSaved}
                  discardRef={discardRef}
                />
                {note.tags.length > 0 && (
                  <div className="tag-footer">
                    {note.tags.map((t) => (
                      <button
                        type="button"
                        key={t}
                        className="tag-row clickable"
                        onClick={() => openTag(t)}
                      >
                        #{t}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                <div>
                  <p>
                    <strong>corpoBrain</strong>
                  </p>
                  <p>Ctrl+P to open or create a note · Ctrl+D for today’s daily note</p>
                </div>
              </div>
            )}
          </div>
          <RightPanel
            note={note}
            notes={notes}
            onOpen={openPath}
            onTag={openTag}
            onMetaChanged={(newPath) => {
              refreshLists();
              const current = noteRef.current;
              if (!current) return;
              if (newPath && newPath !== current.path) openPath(newPath);
              else
                api
                  .note(current.path)
                  .then(setNote)
                  .catch(() => setNote(null));
            }}
          />
        </>
      )}
      <CommandPalette
        open={paletteOpen}
        notes={notes}
        commands={commands}
        onOpen={openPath}
        onClose={() => setPaletteOpen(false)}
        onCreate={createNote}
      />
    </div>
  );
}
