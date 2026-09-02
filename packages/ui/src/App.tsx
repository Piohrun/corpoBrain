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

import { DigestPage } from './components/DigestPage.tsx';
import { Editor, type EditorApi } from './components/Editor.tsx';
import { JiraPage } from './components/JiraPage.tsx';
import { ObjectsPage } from './components/ObjectsPage.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { PlanningPage } from './components/PlanningPage.tsx';
import { PrivatePage } from './components/PrivatePage.tsx';
import { ProjectsPage } from './components/ProjectsPage.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { ShortcutHelp } from './components/ShortcutHelp.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TasksPage } from './components/TasksPage.tsx';
import { TrackedPage } from './components/TrackedPage.tsx';
import { Finder } from './finder/Finder.tsx';
import { rankBy } from './finder/match.ts';
import { FinderProvider, useFinder, useFinderSections } from './finder/registry.tsx';
import { type FinderSection, section } from './finder/types.ts';
import { useVaultEvents } from './hooks.ts';
import { installShortcuts, isMac, type Shortcut } from './shortcuts.ts';

function hashPath(): string {
  return decodeURIComponent(window.location.hash.replace(/^#\//, ''));
}

type NoteHistoryMode = 'push' | 'replace' | 'none';

interface NoteHistoryState {
  corpoBrainNote: true;
  index: number;
  path: string | null;
}

function noteHistoryState(value: unknown): NoteHistoryState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NoteHistoryState>;
  return candidate.corpoBrainNote === true &&
    typeof candidate.index === 'number' &&
    (typeof candidate.path === 'string' || candidate.path === null)
    ? (candidate as NoteHistoryState)
    : null;
}

function noteHash(path: string): string {
  return `#/${encodeURIComponent(path)}`;
}

/** Does the sidebar (note list, tags, tree) need refetching after this save? */
function listsAffected(prev: NoteResponse, fresh: NoteResponse): boolean {
  const meta = (n: NoteResponse) =>
    JSON.stringify([n.meta?.title, n.meta?.type, n.meta?.frontmatter ?? null, n.tags]);
  return meta(prev) !== meta(fresh);
}

export function App() {
  return (
    <FinderProvider>
      <AppShell />
    </FinderProvider>
  );
}

type View =
  | 'notes'
  | 'planning'
  | 'projects'
  | 'availability'
  | 'digest'
  | 'tasks'
  | 'tracked'
  | 'objects'
  | 'jira'
  | 'private'
  | 'settings';

/** `g` then this letter jumps to the view */
const VIEW_KEYS: { key: string; view: View; label: string }[] = [
  { key: 'n', view: 'notes', label: 'Notes' },
  { key: 'p', view: 'planning', label: 'Planning' },
  { key: 'j', view: 'projects', label: 'Projects' },
  { key: 'a', view: 'availability', label: 'Availability' },
  { key: 'd', view: 'digest', label: 'Digest (what changed in Jira)' },
  { key: 't', view: 'tasks', label: 'Tasks' },
  { key: 'k', view: 'tracked', label: 'Tracked commitments, decisions, risks' },
  { key: 'o', view: 'objects', label: 'Objects' },
  { key: 'i', view: 'jira', label: 'Jira settings and sync' },
  { key: 's', view: 'settings', label: 'Settings' },
  { key: 'l', view: 'private', label: 'Protected notes' },
];

function AppShell() {
  const finder = useFinder();
  const [helpOpen, setHelpOpen] = useState(false);
  const [chord, setChord] = useState<string | null>(null);
  const editorApi = useRef<EditorApi | null>(null);
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [view, setView] = useState<View>('notes');
  const viewRef = useRef<View>('notes');
  viewRef.current = view;
  const noteRef = useRef<NoteResponse | null>(null);
  noteRef.current = note;
  /** true while a delete is in flight, so the editor drops its pending save */
  const discardRef = useRef(false);
  /** sequence of note loads: a slow earlier response must not overtake a later click */
  const loadSeq = useRef(0);
  /** Browser-history position owned by note navigation in this app session. */
  const noteHistoryIndex = useRef(0);
  const [canGoBack, setCanGoBack] = useState(false);

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

  const openPath = useCallback((path: string, historyMode: NoteHistoryMode = 'push') => {
    const seq = ++loadSeq.current;
    const previousPath = noteRef.current?.path ?? null;
    api
      .note(path)
      .then((n) => {
        if (seq !== loadSeq.current) return; // a later open won
        setNote(n);
        setSaveState('saved');

        if (historyMode === 'none') return;
        if (historyMode === 'push' && previousPath && previousPath !== path) {
          const index = noteHistoryIndex.current + 1;
          noteHistoryIndex.current = index;
          setCanGoBack(true);
          window.history.pushState(
            { corpoBrainNote: true, index, path } satisfies NoteHistoryState,
            '',
            noteHash(path),
          );
          return;
        }

        // The first opened note and path-only changes (rename/move) replace
        // the current entry, so Back never points at an empty or dead note.
        window.history.replaceState(
          {
            corpoBrainNote: true,
            index: noteHistoryIndex.current,
            path,
          } satisfies NoteHistoryState,
          '',
          noteHash(path),
        );
      })
      .catch(() => {});
  }, []);

  // Restore from the URL and make browser Back/Forward share the same note
  // history as the in-app Back button.
  useEffect(() => {
    const fromHash = hashPath();
    const existing = noteHistoryState(window.history.state);
    const index = existing && existing.path === (fromHash || null) ? existing.index : 0;
    noteHistoryIndex.current = index;
    setCanGoBack(index > 0);
    window.history.replaceState(
      { corpoBrainNote: true, index, path: fromHash || null } satisfies NoteHistoryState,
      '',
    );
    if (fromHash) openPath(fromHash, 'none');

    const onPopState = (event: PopStateEvent) => {
      const entry = noteHistoryState(event.state);
      noteHistoryIndex.current = entry?.index ?? 0;
      setCanGoBack(noteHistoryIndex.current > 0);
      const p = hashPath();
      if (p && p !== noteRef.current?.path) openPath(p, 'none');
      else if (!p) {
        ++loadSeq.current;
        setNote(null);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openPath]);

  const goBack = useCallback(() => {
    if (noteHistoryIndex.current > 0) window.history.back();
  }, []);

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

  // ---- one keyboard model: the list below is also the help overlay ----
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      {
        id: 'finder',
        keys: 'Mod+F',
        label: 'Find: in this note, notes, Jira, commands — or what the page offers',
        scope: 'global',
        inInputs: true,
        run: () => finder.open(),
      },
      {
        id: 'finder-alt',
        keys: 'Mod+P',
        label: 'Find (same as Ctrl+F)',
        scope: 'global',
        inInputs: true,
        run: () => finder.open(),
      },
      {
        id: 'finder-alt2',
        keys: 'Mod+K',
        label: 'Find (same as Ctrl+F)',
        scope: 'global',
        inInputs: true,
        passive: false,
        run: () => finder.open(),
      },
      {
        id: 'daily',
        keys: 'Mod+D',
        label: 'Open today’s daily note',
        scope: 'global',
        inInputs: true,
        run: () => openDaily(),
      },
      {
        id: 'back',
        keys: isMac ? 'Mod+[' : 'Alt+ArrowLeft',
        label: 'Back to the previous note',
        scope: 'notes',
        inInputs: true,
        when: () => canGoBack,
        run: () => goBack(),
      },
      {
        id: 'help',
        keys: 'Mod+/',
        label: 'Keyboard shortcuts',
        scope: 'global',
        inInputs: true,
        run: () => setHelpOpen((v) => !v),
      },
      {
        id: 'help2',
        keys: '?',
        label: 'Keyboard shortcuts',
        scope: 'global',
        run: () => setHelpOpen((v) => !v),
      },
      {
        id: 'escape',
        keys: 'Escape',
        label: 'Close the open overlay',
        scope: 'global',
        inInputs: true,
        when: () => helpOpen,
        run: () => setHelpOpen(false),
      },
      ...VIEW_KEYS.map<Shortcut>((v) => ({
        id: `go-${v.view}`,
        keys: `g ${v.key}`,
        label: v.label,
        scope: 'navigate',
        run: () => setView(v.view),
      })),
      {
        id: 'go-editor',
        keys: 'g e',
        label: 'Focus the editor',
        scope: 'navigate',
        run: () => editorApi.current?.focus(),
      },
      // documented here, handled by the editor / lists themselves
      {
        id: 'ed-next',
        keys: 'F3',
        label: 'Next match of the last find',
        scope: 'editor',
        passive: true,
      },
      {
        id: 'ed-wiki',
        keys: '[[',
        label: 'Link to a note (autocomplete)',
        scope: 'editor',
        passive: true,
      },
      {
        id: 'ed-enc',
        keys: 'Mod+Shift+E',
        label: 'Encrypt the selection',
        scope: 'editor',
        passive: true,
      },
      {
        id: 'ed-track',
        keys: 'select text',
        label: '“Track as…” a commitment, decision, risk or assumption',
        scope: 'editor',
        passive: true,
      },
      {
        id: 'ls-move',
        keys: 'ArrowUp / ArrowDown',
        label: 'Move between rows',
        scope: 'lists',
        passive: true,
      },
      { id: 'ls-open', keys: 'Enter', label: 'Open the row', scope: 'lists', passive: true },
      {
        id: 'fi-sections',
        keys: 'Tab',
        label: 'Jump to the next section',
        scope: 'finder',
        passive: true,
      },
      {
        id: 'fi-actions',
        keys: 'ArrowRight',
        label: 'Other actions for the row',
        scope: 'finder',
        passive: true,
      },
      {
        id: 'fi-select',
        keys: 'Space',
        label: 'Select several (multi sections)',
        scope: 'finder',
        passive: true,
      },
      {
        id: 'fi-prefix',
        keys: '/ # > @',
        label: 'Prefixes: this note · tags · commands · people',
        scope: 'finder',
        passive: true,
      },
    ],
    [finder, canGoBack, goBack, openDaily, helpOpen],
  );
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  useEffect(() => installShortcuts(() => shortcutsRef.current, setChord), []);

  // in-note find highlights go away with the Finder
  useEffect(() => {
    if (!finder.isOpen) editorApi.current?.clearFind();
  }, [finder.isOpen]);

  // ---- Finder sections the shell owns: this note, notes, commands ----
  const notesSections = useMemo<FinderSection[]>(() => {
    const inNote: FinderSection<{ from: number; to: number }> = {
      id: 'in-note',
      title: 'In this note',
      order: 10,
      prefix: '/',
      limit: 6,
      showEmpty: false,
      search: (q) => {
        const ed = editorApi.current;
        if (!ed || !q.trim()) return [];
        return ed.find(q).map((m) => ({
          id: `${m.from}`,
          label: m.text.trim(),
          detail: `line ${m.line}`,
          icon: '¶',
          data: { from: m.from, to: m.to },
        }));
      },
      actions: [
        {
          id: 'jump',
          label: 'go to match',
          run: ([m], ctx) => {
            ctx.close();
            if (m) editorApi.current?.goTo(m.data);
          },
        },
      ],
    };
    const linkable = notes.filter((n) => !n.protected);
    const noteSection: FinderSection<NoteListItem | { create: string }> = {
      id: 'notes',
      title: 'Notes',
      order: 20,
      limit: 8,
      async: true,
      search: async (q) => {
        const titleHits = rankBy(linkable, q, (n) => [n.title, n.path], 40).map(
          ({ row, score }) => ({
            id: row.path,
            label: row.title,
            detail: row.path,
            icon: row.type === 'jira' ? '◈' : row.type === 'person' ? '👤' : '📄',
            data: row,
            score,
          }),
        );
        const trimmed = q.trim();
        let bodyHits: typeof titleHits = [];
        if (trimmed.length >= 2) {
          try {
            const seen = new Set(titleHits.map((t) => t.id));
            const byPath = new Map(linkable.map((n) => [n.path, n]));
            bodyHits = (await api.search(trimmed, 12))
              .filter((h) => !seen.has(h.path) && byPath.has(h.path))
              .map((h) => ({
                id: h.path,
                label: h.title,
                detail: h.snippet.replace(/<<|>>/g, '').replace(/\s+/g, ' ').slice(0, 80),
                icon: '¶',
                data: byPath.get(h.path) as NoteListItem,
                score: 5,
              }));
          } catch {
            bodyHits = [];
          }
        }
        const items: (typeof titleHits)[number][] = [...titleHits, ...bodyHits];
        if (trimmed && !linkable.some((n) => n.title.toLowerCase() === trimmed.toLowerCase())) {
          items.push({
            id: '::create::',
            label: `Create “${trimmed}”`,
            detail: 'new note',
            icon: '＋',
            data: { create: trimmed } as unknown as NoteListItem,
            score: 99,
          });
        }
        return items;
      },
      actions: [
        {
          id: 'open',
          label: 'open',
          run: ([item], ctx) => {
            ctx.close();
            if (!item) return;
            const d = item.data as NoteListItem | { create: string };
            if (viewRef.current !== 'notes') setView('notes');
            if ('create' in d) createNote(d.create);
            else openPath(d.path);
          },
        },
        {
          id: 'link',
          label: 'insert [[link]] here',
          keys: 'Mod+L',
          when: (items) =>
            viewRef.current === 'notes' &&
            editorApi.current !== null &&
            !items.some((i) => 'create' in (i.data as object)),
          run: (items, ctx) => {
            ctx.close();
            const ed = editorApi.current;
            if (!ed) return;
            const titles = items.map((i) => (i.data as NoteListItem).title);
            const sel = ed.selection();
            if (sel && titles.length === 1) ed.wrap(`[[${titles[0]}|`, ']]');
            else ed.insert(titles.map((t) => `[[${t}]]`).join(' '));
          },
        },
      ],
    };
    const commands: FinderSection<() => void> = {
      id: 'commands',
      title: 'Commands',
      order: 90,
      prefix: '>',
      limit: 6,
      search: (q) => {
        const all: { id: string; label: string; hint?: string; run: () => void }[] = [
          { id: 'daily', label: 'Open today’s daily note', hint: 'Ctrl+D', run: openDaily },
          { id: 'help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelpOpen(true) },
          { id: 'reload', label: 'Reload note lists', run: refreshLists },
          ...VIEW_KEYS.map((v) => ({
            id: `go-${v.view}`,
            label: `Go to ${v.label}`,
            hint: `g ${v.key}`,
            run: () => setView(v.view),
          })),
        ];
        return rankBy(all, q, (c) => [c.label]).map(({ row, score }) => ({
          id: row.id,
          label: row.label,
          hint: row.hint,
          icon: '›',
          data: row.run,
          score,
        }));
      },
      actions: [
        {
          id: 'run',
          label: 'run',
          run: ([c], ctx) => {
            ctx.close();
            c?.data();
          },
        },
      ],
    };
    return view === 'notes'
      ? [section(inNote), section(noteSection), section(commands)]
      : [section(noteSection), section(commands)];
  }, [notes, view, openPath, createNote, openDaily, refreshLists]);
  useFinderSections('app', notesSections);

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

  // Pages that edit notes while the editor is unmounted must refresh the
  // selected note, otherwise returning to Notes remounts its stale snapshot.
  const refreshOpenNote = useCallback(
    (path: string) => {
      if (noteRef.current?.path === path) openPath(path);
    },
    [openPath],
  );

  const trackedCreated = useCallback(
    (_recordPath: string, sourcePath: string, sourceContent: string) => {
      refreshLists();
      setNote((prev) => (prev?.path === sourcePath ? { ...prev, content: sourceContent } : prev));
      api
        .note(sourcePath)
        .then((fresh) =>
          setNote((prev) =>
            prev?.path === sourcePath ? { ...fresh, content: prev.content } : prev,
          ),
        )
        .catch(() => {});
    },
    [refreshLists],
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
          className={view === 'tracked' ? 'active' : ''}
          onClick={() => setView('tracked')}
          title="Tracked: commitments, decisions, risks and assumptions"
        >
          ◎
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
        <TasksPage onOpenNote={openFromPlanning} onNoteChanged={refreshOpenNote} />
      ) : view === 'tracked' ? (
        <TrackedPage onOpenNote={openFromPlanning} onNoteChanged={refreshOpenNote} />
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
            onNew={() => finder.open({ section: 'notes' })}
            onFind={() => finder.open()}
            onTreeChanged={(moved) => {
              refreshLists();
              const current = noteRef.current;
              if (!current) return;
              if (moved && current.path === moved.from) openPath(moved.to, 'replace');
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
                  <button
                    type="button"
                    className="note-back"
                    disabled={!canGoBack}
                    title={`Back to previous note (${/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘[' : 'Alt+←'})`}
                    aria-label="Back to previous note"
                    onClick={goBack}
                  >
                    ←
                  </button>
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
                          window.history.replaceState(
                            {
                              corpoBrainNote: true,
                              index: noteHistoryIndex.current,
                              path: null,
                            } satisfies NoteHistoryState,
                            '',
                            `${window.location.pathname}${window.location.search}`,
                          );
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
                  onTrackedCreated={trackedCreated}
                  onShowTracked={() => setView('tracked')}
                  discardRef={discardRef}
                  apiRef={editorApi}
                  onFind={() => finder.open()}
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
                  <p>
                    Ctrl+F finds anything · Ctrl+D opens today’s daily note · ? lists the shortcuts
                  </p>
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
              if (newPath && newPath !== current.path) openPath(newPath, 'replace');
              else
                api
                  .note(current.path)
                  .then(setNote)
                  .catch(() => setNote(null));
            }}
          />
        </>
      )}
      <Finder />
      {helpOpen && <ShortcutHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
      {chord && <div className="chord-pending">{chord} … then a letter (? for the list)</div>}
    </div>
  );
}
