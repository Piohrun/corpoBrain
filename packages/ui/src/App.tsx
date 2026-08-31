import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type NoteListItem,
  type NoteResponse,
  type TagCount,
  type TreeModel,
  treeApi,
} from './api.ts';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette.tsx';
import { Editor } from './components/Editor.tsx';
import { ObjectsPage } from './components/ObjectsPage.tsx';
import { PlanningPage } from './components/PlanningPage.tsx';
import { PrivatePage } from './components/PrivatePage.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TasksPage } from './components/TasksPage.tsx';
import { useVaultEvents } from './hooks.ts';

export function App() {
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [view, setView] = useState<'notes' | 'planning' | 'tasks' | 'objects' | 'private'>('notes');
  const noteRef = useRef<NoteResponse | null>(null);
  noteRef.current = note;

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
    api
      .note(path)
      .then((n) => {
        setNote(n);
        setSaveState('saved');
        window.location.hash = `#/${encodeURIComponent(path)}`;
      })
      .catch(() => {});
  }, []);

  // restore note from URL hash on load
  useEffect(() => {
    const fromHash = decodeURIComponent(window.location.hash.replace(/^#\//, ''));
    if (fromHash) openPath(fromHash);
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
        .resolve(target)
        .then(async (r) => {
          if (!r.exists) {
            await api.create(r.path, target);
            refreshLists();
          }
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
        .resolve(title)
        .then(async (r) => {
          if (!r.exists) await api.create(r.path, title);
          refreshLists();
          openPath(r.path);
        })
        .catch(() => {});
    },
    [openPath, refreshLists],
  );

  // refresh backlinks/properties after a save settles
  const onSaved = useCallback(() => {
    refreshLists();
    const current = noteRef.current;
    if (current) {
      api
        .note(current.path)
        .then((fresh) =>
          setNote((prev) =>
            prev && prev.path === fresh.path
              ? { ...fresh, content: prev.content } // do not clobber the editor
              : prev,
          ),
        )
        .catch(() => {});
    }
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
          className={view === 'private' ? 'active' : ''}
          onClick={() => setView('private')}
          title="Protected notes"
        >
          🔒
        </button>
      </nav>
      {view === 'planning' ? (
        <PlanningPage onOpenNote={openFromPlanning} />
      ) : view === 'tasks' ? (
        <TasksPage onOpenNote={openFromPlanning} />
      ) : view === 'objects' ? (
        <ObjectsPage onOpenNote={openFromPlanning} />
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
                      api
                        .remove(current.path)
                        .then(() => {
                          setNote(null);
                          refreshLists();
                        })
                        .catch(() => {});
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
                <Editor
                  path={note.path}
                  content={note.content}
                  completions={completions}
                  onNavigate={navigate}
                  onSaveState={setSaveState}
                  onSaved={onSaved}
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
