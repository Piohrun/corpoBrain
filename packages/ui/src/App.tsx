import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  api,
  type NoteListItem,
  type NoteResponse,
  type TagCount,
  type TreeModel,
  treeApi,
} from './api.ts';
import { ContextDock } from './components/ContextDock.tsx';
import { Editor, type EditorApi } from './components/Editor.tsx';
import { Icon } from './components/Icon.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { PropertiesBar } from './components/PropertiesBar.tsx';
import { RightPanel } from './components/RightPanel.tsx';
import { ShortcutHelp } from './components/ShortcutHelp.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { NAV_VIEWS as VIEW_KEYS, type View, WorkspaceNav } from './components/WorkspaceNav.tsx';
import { ContextPreview } from './context-preview.tsx';
import { DialogProvider, useDialogs } from './dialogs.tsx';
import { ContextMenuProvider } from './finder/ContextMenu.tsx';
import { Finder } from './finder/Finder.tsx';
import { rankBy } from './finder/match.ts';
import {
  FinderProvider,
  useFinder,
  useFinderActions,
  useFinderSections,
} from './finder/registry.tsx';
import { type FinderItem, type FinderSection, section } from './finder/types.ts';
import { useVaultEvents } from './hooks.ts';
import { NoteTitlesProvider, titleResolver } from './note-titles.tsx';
import { emptyPreview, previewPath, previewReducer } from './preview-state.ts';
import { getSaveState, setSaveState } from './save-state.ts';
import { installShortcuts, isMac, type Shortcut } from './shortcuts.ts';
import { lsGet, lsJson, lsSet, lsSetJson } from './storage.ts';

/**
 * Pages other than Notes load on first use: they are most of the bundle, and
 * memo keeps an open page from re-rendering when only the app shell changed.
 */
const AvailabilityPage = memo(
  lazy(() =>
    import('./components/AvailabilityPage.tsx').then((m) => ({ default: m.AvailabilityPage })),
  ),
);
const DigestPage = memo(
  lazy(() => import('./components/DigestPage.tsx').then((m) => ({ default: m.DigestPage }))),
);
const JiraPage = memo(
  lazy(() => import('./components/JiraPage.tsx').then((m) => ({ default: m.JiraPage }))),
);
const TeambookPage = memo(
  lazy(() => import('./components/TeambookPage.tsx').then((m) => ({ default: m.TeambookPage }))),
);
const OutlookPage = memo(
  lazy(() => import('./components/OutlookPage.tsx').then((m) => ({ default: m.OutlookPage }))),
);
const ObjectsPage = memo(
  lazy(() => import('./components/ObjectsPage.tsx').then((m) => ({ default: m.ObjectsPage }))),
);
const OrganizationPage = memo(
  lazy(() =>
    import('./components/OrganizationPage.tsx').then((m) => ({ default: m.OrganizationPage })),
  ),
);
const PlanningPage = memo(
  lazy(() => import('./components/PlanningPage.tsx').then((m) => ({ default: m.PlanningPage }))),
);
const PrivatePage = memo(
  lazy(() => import('./components/PrivatePage.tsx').then((m) => ({ default: m.PrivatePage }))),
);
const ProjectsPage = memo(
  lazy(() => import('./components/ProjectsPage.tsx').then((m) => ({ default: m.ProjectsPage }))),
);
const SettingsPage = memo(
  lazy(() => import('./components/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage }))),
);
const TasksPage = memo(
  lazy(() => import('./components/TasksPage.tsx').then((m) => ({ default: m.TasksPage }))),
);
const TrackedPage = memo(
  lazy(() => import('./components/TrackedPage.tsx').then((m) => ({ default: m.TrackedPage }))),
);

/** True when two loads of the same note differ in nothing but the body text. */
function sameExceptContent(a: NoteResponse, b: NoteResponse): boolean {
  const { content: _a, ...restA } = a;
  const { content: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/** Clears the editor's in-note find highlights when the Finder closes. */
function ClearFindOnClose({ editorApi }: { editorApi: React.RefObject<EditorApi | null> }) {
  const { isOpen } = useFinder();
  useEffect(() => {
    if (!isOpen) editorApi.current?.clearFind();
  }, [isOpen, editorApi]);
  return null;
}

/** `#/<note path>` — the Notes panel with that note open. */
function hashPath(): string {
  const h = window.location.hash;
  return h.startsWith('#/') ? decodeURIComponent(h.slice(2)) : '';
}

/** `#view=<panel>` — any other panel. */
function hashView(): string | null {
  const m = /^#view=([a-z]+)$/.exec(window.location.hash);
  return m ? (m[1] as string) : null;
}

type NoteHistoryMode = 'push' | 'replace' | 'none';

interface NoteHistoryState {
  corpoBrainNote: true;
  index: number;
  path: string | null;
  /** the panel this entry shows; absent in entries written before panels joined the history */
  view?: string;
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

function locationHash(view: string, path: string | null): string {
  if (view !== 'notes') return `#view=${view}`;
  return path ? noteHash(path) : `${window.location.pathname}${window.location.search}`;
}

/** The note title in the header: click to rename, Enter saves, Esc cancels. */
function RenameableTitle({
  title,
  onRename,
}: {
  title: string;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  if (!editing)
    return (
      <button
        type="button"
        className="title title-edit"
        title="Click to rename"
        onClick={() => {
          setValue(title);
          setEditing(true);
        }}
      >
        {title}
      </button>
    );
  return (
    <input
      className="title-input"
      value={value}
      // biome-ignore lint/a11y/noAutofocus: the field appears on an explicit click
      autoFocus
      aria-label="Note title"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setEditing(false);
        else if (e.key === 'Enter') {
          e.preventDefault();
          setEditing(false);
          if (value.trim() && value.trim() !== title) onRename(value.trim());
        }
      }}
    />
  );
}

/** Does the sidebar (note list, tags, tree) need refetching after this save? */
function listsAffected(prev: NoteResponse, fresh: NoteResponse): boolean {
  const meta = (n: NoteResponse) =>
    JSON.stringify([n.meta?.title, n.meta?.type, n.meta?.frontmatter ?? null, n.tags]);
  return meta(prev) !== meta(fresh);
}

export function App() {
  return (
    <DialogProvider>
      <FinderProvider>
        <ContextMenuProvider>
          <AppShell />
        </ContextMenuProvider>
      </FinderProvider>
    </DialogProvider>
  );
}

function AppShell() {
  const finder = useFinderActions();
  const [preview, dispatchPreview] = useReducer(previewReducer, emptyPreview);
  const previewResolveSeq = useRef(0);
  const openPreview = useCallback((path: string) => {
    ++previewResolveSeq.current;
    dispatchPreview({ type: 'open', path });
  }, []);
  const [detailsOpen, setDetailsOpen] = useState(() => lsGet('cb.note.details') === 'yes');
  useEffect(() => lsSet('cb.note.details', detailsOpen ? 'yes' : 'no'), [detailsOpen]);
  const dlg = useDialogs();
  const [helpOpen, setHelpOpen] = useState(false);
  const [foldFrontmatter, setFoldFrontmatter] = useState(() => lsGet('cb.fm.fold', 'yes') !== 'no');
  const [recentPaths, setRecentPaths] = useState<string[]>(() => lsJson<string[]>('cb.recent', []));
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(() => lsJson<string[]>('cb.pinned', []));
  const [treeSort, setTreeSort] = useState<'title' | 'recent'>(() =>
    lsGet('cb.tree.sort', 'title') === 'recent' ? 'recent' : 'title',
  );
  useEffect(() => lsSetJson('cb.recent', recentPaths), [recentPaths]);
  useEffect(() => lsSetJson('cb.pinned', pinnedPaths), [pinnedPaths]);
  useEffect(() => lsSet('cb.tree.sort', treeSort), [treeSort]);
  const togglePin = useCallback((path: string) => {
    setPinnedPaths((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path]));
  }, []);
  useEffect(() => lsSet('cb.fm.fold', foldFrontmatter ? 'yes' : 'no'), [foldFrontmatter]);
  const [chord, setChord] = useState<string | null>(null);
  const editorApi = useRef<EditorApi | null>(null);
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [tree, setTree] = useState<TreeModel | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [noteOpenSequence, setNoteOpenSequence] = useState(0);

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
  /** highest history index this session has pushed — forward exists below it */
  const noteHistoryMax = useRef(0);
  const [canGoForward, setCanGoForward] = useState(false);

  // Bursts of vault events (a sync touching many files, a save plus its
  // echo) coalesce into one refetch; a slower older answer never overwrites
  // a newer one; unchanged lists keep their identity (see reqStable).
  const listsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listsSeq = useRef(0);
  const fetchLists = useCallback(() => {
    listsTimer.current = null;
    const seq = ++listsSeq.current;
    const keep =
      <T,>(set: (v: T) => void) =>
      (v: T) => {
        if (seq === listsSeq.current) set(v);
      };
    api
      .notes()
      .then(keep(setNotes))
      .catch(() => {});
    api
      .tags()
      .then(keep(setTags))
      .catch(() => {});
    treeApi
      .get()
      .then(keep(setTree))
      .catch(() => {});
  }, []);
  const refreshLists = useCallback(() => {
    if (listsTimer.current) clearTimeout(listsTimer.current);
    listsTimer.current = setTimeout(fetchLists, 120);
  }, [fetchLists]);

  useEffect(fetchLists, [fetchLists]);

  const openPath = useCallback((path: string, historyMode: NoteHistoryMode = 'push') => {
    const seq = ++loadSeq.current;
    const previousPath = noteRef.current?.path ?? null;
    api
      .note(path)
      .then((n) => {
        if (seq !== loadSeq.current) return; // a later open won
        setNote(n);
        setNoteOpenSequence(seq);
        setSaveState('saved');
        setRecentPaths((r) => [path, ...r.filter((x) => x !== path)].slice(0, 10));

        if (historyMode === 'none') return;
        if (historyMode === 'push' && previousPath && previousPath !== path) {
          const index = noteHistoryIndex.current + 1;
          noteHistoryIndex.current = index;
          noteHistoryMax.current = index; // a new push discards any forward entries
          setCanGoBack(true);
          setCanGoForward(false);
          window.history.pushState(
            { corpoBrainNote: true, index, path, view: 'notes' } satisfies NoteHistoryState,
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
            view: 'notes',
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
    const startView = (hashView() ?? 'notes') as View;
    const existing = noteHistoryState(window.history.state);
    const index = existing && existing.path === (fromHash || null) ? existing.index : 0;
    noteHistoryIndex.current = index;
    noteHistoryMax.current = index;
    setCanGoBack(index > 0);
    window.history.replaceState(
      {
        corpoBrainNote: true,
        index,
        path: fromHash || null,
        view: startView,
      } satisfies NoteHistoryState,
      '',
    );
    if (VIEW_KEYS.some((v) => v.view === startView)) setView(startView);
    if (fromHash) openPath(fromHash, 'none');

    const onPopState = (event: PopStateEvent) => {
      const entry = noteHistoryState(event.state);
      noteHistoryIndex.current = entry?.index ?? 0;
      if (noteHistoryIndex.current > noteHistoryMax.current)
        noteHistoryMax.current = noteHistoryIndex.current;
      setCanGoBack(noteHistoryIndex.current > 0);
      setCanGoForward(noteHistoryIndex.current < noteHistoryMax.current);
      // panels are history entries too: restore the one this entry shows
      const v = (entry?.view ?? hashView() ?? 'notes') as View;
      if (VIEW_KEYS.some((x) => x.view === v)) setView(v);
      if (v !== 'notes') return;
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
  const goForward = useCallback(() => {
    if (noteHistoryIndex.current < noteHistoryMax.current) window.history.forward();
  }, []);

  /** Switch panels through the history, so Back returns to the panel you came from. */
  const goView = useCallback((next: View) => {
    if (next === viewRef.current) return;
    const index = noteHistoryIndex.current + 1;
    noteHistoryIndex.current = index;
    noteHistoryMax.current = index;
    setCanGoBack(true);
    setCanGoForward(false);
    const path = noteRef.current?.path ?? null;
    window.history.pushState(
      { corpoBrainNote: true, index, path, view: next } satisfies NoteHistoryState,
      '',
      locationHash(next, path),
    );
    setView(next);
  }, []);

  /** Alt+↑/↓: the panel above/below in the left rail, from anywhere. */
  const stepView = useCallback(
    (dir: 1 | -1) => {
      const order = VIEW_KEYS.map((v) => v.view);
      const at = order.indexOf(viewRef.current);
      const next = order[(at + dir + order.length) % order.length];
      if (next) goView(next);
    },
    [goView],
  );

  /** Alt+Shift+↑/↓: open the note above/below the current one in the sidebar's visible order. */
  const openNeighbour = useCallback(
    (dir: 1 | -1) => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>('.sidebar-scroll button[data-path]'),
      ].filter((b) => b.offsetParent !== null);
      if (!rows.length) return;
      const current = noteRef.current?.path ?? null;
      const at = rows.findIndex((b) => b.dataset.path === current);
      const next = rows[at < 0 ? (dir === 1 ? 0 : rows.length - 1) : at + dir];
      const path = next?.dataset.path;
      if (!path) return;
      next?.scrollIntoView({ block: 'nearest' });
      openPath(path);
    },
    [openPath],
  );

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
      const bare = target.split('#')[0]?.trim().replace(/\.md$/, '');
      if (!bare) return;
      const seq = ++previewResolveSeq.current;
      api
        .resolve(bare)
        .then((result) => {
          if (seq === previewResolveSeq.current)
            dispatchPreview({ type: 'open', path: result.path });
        })
        .catch((e: Error) => {
          if (seq === previewResolveSeq.current) dlg.toast({ kind: 'error', message: e.message });
        });
    },
    [dlg],
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
        // A body-only save usually changes nothing else (backlinks, links,
        // properties): keep the same object so nothing downstream re-renders.
        if (sameExceptContent(prev, fresh)) return;
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
        id: 'context-menu',
        keys: 'Shift+F10',
        label:
          'Actions for what is under the cursor (also the Menu key and right-click; Shift+right-click for the browser menu)',
        scope: 'global',
        passive: true,
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
        scope: 'global',
        inInputs: true,
        when: () => canGoBack,
        run: () => goBack(),
      },
      {
        id: 'forward',
        keys: isMac ? 'Mod+]' : 'Alt+ArrowRight',
        label: 'Forward again',
        scope: 'global',
        inInputs: true,
        when: () => canGoForward,
        run: () => goForward(),
      },
      {
        id: 'prev-view',
        keys: 'Alt+ArrowUp',
        label: 'Previous panel in the left rail',
        scope: 'global',
        inInputs: true,
        run: () => stepView(-1),
      },
      {
        id: 'next-view',
        keys: 'Alt+ArrowDown',
        label: 'Next panel in the left rail',
        scope: 'global',
        inInputs: true,
        run: () => stepView(1),
      },
      {
        id: 'prev-note',
        keys: 'Alt+Shift+ArrowUp',
        label: 'Open the note above in the sidebar',
        scope: 'notes',
        inInputs: true,
        run: () => (viewRef.current === 'notes' ? openNeighbour(-1) : goView('notes')),
      },
      {
        id: 'next-note',
        keys: 'Alt+Shift+ArrowDown',
        label: 'Open the note below in the sidebar',
        scope: 'notes',
        inInputs: true,
        run: () => (viewRef.current === 'notes' ? openNeighbour(1) : goView('notes')),
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
        run: () => goView(v.view),
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
    [
      finder,
      canGoBack,
      canGoForward,
      goBack,
      goForward,
      openNeighbour,
      stepView,
      goView,
      openDaily,
      helpOpen,
    ],
  );
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  useEffect(() => installShortcuts(() => shortcutsRef.current, setChord), []);

  // in-note find highlights go away with the Finder

  /** Delete any note (no confirm: it goes to .trash and the toast undoes it). */
  const deleteNote = useCallback(
    (path: string, title: string) => {
      const isOpen = noteRef.current?.path === path;
      // the editor's debounced save must not resurrect the file
      if (isOpen) discardRef.current = true;
      api
        .remove(path)
        .then(() => {
          dlg.toast({
            message: `Deleted “${title}”`,
            action: {
              label: 'Undo',
              run: () =>
                api
                  .restore(path)
                  .then(() => {
                    refreshLists();
                    goView('notes');
                    openPath(path);
                  })
                  .catch((e: Error) => dlg.alert(`Undo failed: ${e.message}`)),
            },
          });
          if (isOpen) {
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
          }
          refreshLists();
        })
        .catch((e: Error) => dlg.alert(`Delete failed: ${e.message}`))
        .finally(() => {
          if (isOpen) discardRef.current = false;
        });
    },
    [dlg, refreshLists, goView, openPath],
  );

  /** Rename any note; the open one follows to its new path. */
  const renameNote = useCallback(
    (path: string, title: string) =>
      treeApi
        .rename(path, title)
        .then((r) => {
          refreshLists();
          if (noteRef.current?.path !== path) return;
          if (r.path !== path) openPath(r.path, 'replace');
          else
            api
              .note(path)
              .then((fresh) =>
                setNote((prev) =>
                  prev && prev.path === fresh.path ? { ...fresh, content: prev.content } : prev,
                ),
              )
              .catch(() => {});
        })
        .catch((e: Error) => dlg.alert(`Rename failed: ${e.message}`)),
    [dlg, refreshLists, openPath],
  );

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
    const byPath = new Map(linkable.map((n) => [n.path, n]));
    const noteItem = (n: NoteListItem): FinderItem<NoteListItem | { create: string }> => ({
      id: n.path,
      label: n.title,
      detail: n.path,
      icon: n.type === 'jira' ? '◈' : n.type === 'person' ? '👤' : '📄',
      data: n,
    });
    const isNote = (items: FinderItem[]) => {
      const data = items.length === 1 ? items[0]?.data : undefined;
      return typeof data === 'object' && data !== null && !('create' in data);
    };
    const noteSection: FinderSection<NoteListItem | { create: string }> = {
      id: 'notes',
      title: 'Notes',
      order: 20,
      limit: 8,
      async: true,
      // a path (sidebar rows) or a link target as written ([[Title]], [[folder/name]], EXEC-12)
      resolve: (id) => {
        const direct = byPath.get(id) ?? byPath.get(`${id}.md`);
        if (direct) return noteItem(direct);
        const key = id.trim().toLowerCase().replace(/\.md$/, '');
        if (!key) return null;
        const hit =
          linkable.find((n) => n.path.toLowerCase().replace(/\.md$/, '') === key) ??
          linkable.find((n) => n.title.toLowerCase() === key) ??
          linkable.find((n) => n.path.toLowerCase().endsWith(`/${key}.md`));
        if (hit) return noteItem(hit);
        return {
          id: '::create::',
          label: id,
          detail: 'no such note yet',
          icon: '＋',
          data: { create: id },
        };
      },
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
          // not for the note already open (a right-click inside it)
          when: (items) => {
            const only =
              items.length === 1 ? (items[0]?.data as NoteListItem | undefined) : undefined;
            return !(only && only.path === noteRef.current?.path);
          },
          run: ([item], ctx) => {
            ctx.close();
            if (!item) return;
            const d = item.data as NoteListItem | { create: string };
            if (viewRef.current !== 'notes') goView('notes');
            if ('create' in d) createNote(d.create);
            else openPath(d.path);
          },
        },
        {
          id: 'preview',
          label: 'preview beside this screen',
          when: (items) =>
            items.length === 1 && !items.some((item) => 'create' in (item.data as object)),
          run: ([item], ctx) => {
            ctx.close();
            if (item) openPreview((item.data as NoteListItem).path);
          },
        },
        {
          id: 'pin',
          label: 'pin / unpin in sidebar',
          when: (items) => {
            const only = items.length === 1 ? items[0] : undefined;
            return only !== undefined && !('create' in (only.data as object));
          },
          run: ([item], ctx) => {
            ctx.close();
            if (item) togglePin((item.data as NoteListItem).path);
          },
        },
        {
          id: 'copy-link',
          label: 'copy [[link]]',
          when: isNote,
          run: ([item], ctx) => {
            ctx.close();
            const n = item?.data as NoteListItem | undefined;
            if (n) void navigator.clipboard?.writeText(`[[${n.title}]]`).catch(() => {});
          },
        },
        {
          id: 'rename',
          label: 'rename…',
          when: isNote,
          run: async ([item], ctx) => {
            ctx.close();
            const n = item?.data as NoteListItem | undefined;
            if (!n) return;
            const title = await dlg.prompt({
              title: 'Rename note',
              label: 'New title',
              initial: n.title,
              confirmLabel: 'Rename',
            });
            if (title?.trim() && title.trim() !== n.title) await renameNote(n.path, title.trim());
          },
        },
        {
          id: 'delete',
          label: 'delete (undo in the toast)',
          when: isNote,
          run: ([item], ctx) => {
            ctx.close();
            const n = item?.data as NoteListItem | undefined;
            if (n) deleteNote(n.path, n.title);
          },
        },
        {
          id: 'link',
          label: 'insert [[link]] here',
          keys: 'Mod+L',
          when: (items) =>
            viewRef.current === 'notes' &&
            editorApi.current !== null &&
            !items.some(
              (i) =>
                'create' in (i.data as object) ||
                (i.data as NoteListItem).path === noteRef.current?.path,
            ),
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
            run: () => goView(v.view),
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
  }, [
    notes,
    view,
    openPath,
    createNote,
    openDaily,
    refreshLists,
    goView,
    togglePin,
    openPreview,
    dlg,
    renameNote,
    deleteNote,
  ]);
  useFinderSections('app', notesSections);

  const titleOf = useMemo(() => new Map(notes.map((n) => [n.path, n.title])), [notes]);
  const titleFor = useMemo(() => titleResolver(notes), [notes]);
  const mtimeOf = useMemo(() => {
    const m = new Map(notes.map((n) => [n.path, n.mtime]));
    return (path: string) => m.get(path) ?? 0;
  }, [notes]);

  const completions = useCallback(
    () => notes.filter((n) => !n.protected).map((n) => ({ title: n.title, path: n.path })),
    [notes],
  );

  const openTag = useCallback(
    (tag: string | null) => {
      setTagFilter(tag);
      if (tag) goView('notes');
    },
    [goView],
  );

  // keyed on the links' content, not the array's identity: a refetch with the
  // same links must not make the editor restyle every link again
  const linksKey = useMemo(
    () =>
      (note?.links ?? [])
        .map((l) => `${l.target.toLowerCase()}\u0000${l.resolved ? 1 : 0}`)
        .join('\u0001'),
    [note?.links],
  );
  const resolveMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const entry of linksKey ? linksKey.split('\u0001') : []) {
      const [target, resolved] = entry.split('\u0000');
      m.set(target as string, resolved === '1');
    }
    return m;
  }, [linksKey]);

  const openFromPlanning = openPreview;
  const openPreviewInEditor = useCallback(
    (path: string) => {
      ++previewResolveSeq.current;
      dispatchPreview({ type: 'close' });
      goView('notes');
      if (noteRef.current?.path !== path) openPath(path);
    },
    [goView, openPath],
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

  // Stable props, so memoized panels skip re-rendering when the shell does.
  const openFinder = useCallback(() => finder.open(), [finder]);
  const openFinderNotes = useCallback(() => finder.open({ section: 'notes' }), [finder]);
  const showTracked = useCallback(() => goView('tracked'), [goView]);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const saveBeforeMetaChange = useCallback(async () => {
    await editorApi.current?.saveNow();
  }, []);
  const jumpTo = useCallback((pos: number) => editorApi.current?.goTo({ from: pos, to: pos }), []);
  const reloadOpenNote = useCallback(
    (newPath?: string | null) => {
      const current = noteRef.current;
      if (!current) return;
      if (newPath && newPath !== current.path) openPath(newPath, 'replace');
      else
        api
          .note(current.path)
          .then(setNote)
          .catch(() => setNote(null));
    },
    [openPath],
  );
  const onMetaChanged = useCallback(
    (newPath?: string) => {
      refreshLists();
      reloadOpenNote(newPath);
    },
    [refreshLists, reloadOpenNote],
  );
  const onTreeChanged = useCallback(
    (moved?: { from: string; to: string }) => {
      refreshLists();
      reloadOpenNote(moved && noteRef.current?.path === moved.from ? moved.to : null);
    },
    [refreshLists, reloadOpenNote],
  );
  const onSnapshot = useCallback((path: string, content: string) => {
    setNote((prev) =>
      prev && prev.path === path && prev.content !== content ? { ...prev, content } : prev,
    );
  }, []);
  const onSaveState = useCallback(
    (p: string, st: 'saved' | 'saving' | 'error') => {
      // a save for the previous note must not relabel this one
      if (noteRef.current?.path !== p) return;
      if (st === 'error' && getSaveState() !== 'error')
        dlg.toast({ kind: 'error', message: `Could not save ${p}` });
      setSaveState(st);
    },
    [dlg],
  );
  const openNotePath = note?.path;
  const recentList = useMemo(
    () =>
      recentPaths
        .filter((p) => p !== openNotePath && titleOf.has(p))
        .map((p) => ({ path: p, title: titleOf.get(p) ?? p })),
    [recentPaths, openNotePath, titleOf],
  );
  const pinnedList = useMemo(
    () => pinnedPaths.map((p) => ({ path: p, title: titleOf.get(p) ?? p })),
    [pinnedPaths, titleOf],
  );
  const navPinned = useMemo(
    () => pinnedList.filter((p) => titleOf.has(p.path)),
    [pinnedList, titleOf],
  );
  const previewContext = useMemo(
    () => ({ open: openPreview, resolve: navigate }),
    [openPreview, navigate],
  );

  return (
    <ContextPreview value={previewContext}>
      <NoteTitlesProvider value={titleFor}>
        <div className="app-shell">
          <div className={`app${preview.pinned || previewPath(preview) ? ' has-preview' : ''}`}>
            <WorkspaceNav
              view={view}
              onView={goView}
              onFind={openFinder}
              pinned={navPinned}
              onPreview={openPreview}
            />
            <div className="workspace-content">
              <Suspense fallback={<div className="empty-state">Loading…</div>}>
                {view === 'planning' ? (
                  <PlanningPage onOpenNote={openFromPlanning} />
                ) : view === 'projects' ? (
                  <ProjectsPage onOpenNote={openFromPlanning} />
                ) : view === 'availability' ? (
                  <AvailabilityPage onOpenNote={openFromPlanning} />
                ) : view === 'organization' ? (
                  <OrganizationPage onOpenNote={openFromPlanning} />
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
                ) : view === 'outlook' ? (
                  <OutlookPage onOpenNote={openFromPlanning} onNotesChanged={refreshLists} />
                ) : view === 'teambook' ? (
                  <TeambookPage />
                ) : view === 'settings' ? (
                  <SettingsPage />
                ) : view === 'private' ? (
                  <PrivatePage />
                ) : (
                  <>
                    <Sidebar
                      openSequence={noteOpenSequence}
                      tree={tree}
                      tags={tags}
                      tagFilter={tagFilter}
                      onTagFilter={openTag}
                      currentPath={note?.path ?? null}
                      onOpen={openPath}
                      onDaily={openDaily}
                      onNew={openFinderNotes}
                      recent={recentList}
                      pinned={pinnedList}
                      onUnpin={togglePin}
                      sort={treeSort}
                      onSort={setTreeSort}
                      mtimeOf={mtimeOf}
                      onTreeChanged={onTreeChanged}
                    />
                    <div className="main">
                      {note ? (
                        <>
                          <div className="main-header">
                            <button
                              type="button"
                              className="note-back"
                              disabled={!canGoBack}
                              title={`Back to previous note (${isMac ? '⌘[' : 'Alt+←'})`}
                              aria-label="Back to previous note"
                              onClick={goBack}
                            >
                              <Icon name="back" />
                            </button>
                            <button
                              type="button"
                              className="note-back"
                              disabled={!canGoForward}
                              title={`Forward again (${isMac ? '⌘]' : 'Alt+→'})`}
                              aria-label="Forward to the next note"
                              onClick={goForward}
                            >
                              <Icon name="forward" />
                            </button>
                            <RenameableTitle
                              key={note.path}
                              title={
                                note.meta?.title ??
                                note.path.replace(/^.*\//, '').replace(/\.md$/, '')
                              }
                              onRename={(title) => renameNote(note.path, title)}
                            />
                            <span className="note-header-path">{note.path}</span>
                            <span className="spacer" />
                            <button
                              type="button"
                              className={`icon-button${detailsOpen ? ' selected' : ''}`}
                              aria-label="Note details"
                              aria-pressed={detailsOpen}
                              title="Toggle note details and outline"
                              onClick={() => setDetailsOpen((open) => !open)}
                            >
                              <Icon name="panel" />
                            </button>
                            <button
                              type="button"
                              className={`note-pin${pinnedPaths.includes(note.path) ? ' on' : ''}`}
                              title={
                                pinnedPaths.includes(note.path)
                                  ? 'Unpin from the sidebar'
                                  : 'Pin to the top of the sidebar'
                              }
                              aria-label="Pin note"
                              onClick={() => togglePin(note.path)}
                            >
                              <Icon name="pin" />
                            </button>
                            <button
                              type="button"
                              className="note-delete"
                              title="Delete note (moved to .trash inside the vault)"
                              onClick={() => {
                                const current = noteRef.current;
                                if (current)
                                  deleteNote(current.path, current.meta?.title ?? current.path);
                              }}
                            >
                              <Icon name="trash" />
                            </button>
                          </div>
                          <PropertiesBar
                            note={note}
                            folded={foldFrontmatter}
                            onToggleFold={() => setFoldFrontmatter((f) => !f)}
                            onEdit={() => {
                              // reveal by putting the cursor on the first property line
                              const text = editorApi.current?.text() ?? note.content;
                              const secondLine = text.indexOf('\n') + 1;
                              editorApi.current?.goTo({ from: secondLine, to: secondLine });
                            }}
                            onTag={openTag}
                            onNavigate={navigate}
                          />
                          {note.path.startsWith('people/') && (
                            <PersonPanel path={note.path} onOpen={openPreview} />
                          )}
                          <Editor
                            path={note.path}
                            content={note.content}
                            completions={completions}
                            resolveMap={resolveMap}
                            onNavigate={navigate}
                            onSnapshot={onSnapshot}
                            onSaveState={onSaveState}
                            onSaved={onSaved}
                            onTrackedCreated={trackedCreated}
                            onShowTracked={showTracked}
                            discardRef={discardRef}
                            apiRef={editorApi}
                            onFind={openFinder}
                            foldFrontmatter={foldFrontmatter}
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
                              Ctrl+F finds anything · Ctrl+D opens today’s daily note · ? lists the
                              shortcuts
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                    {detailsOpen && !preview.pinned && !previewPath(preview) && (
                      <RightPanel
                        note={note}
                        notes={notes}
                        onOpen={openPreview}
                        onClose={closeDetails}
                        onTag={openTag}
                        beforeMetaChange={saveBeforeMetaChange}
                        onJump={jumpTo}
                        onMetaChanged={onMetaChanged}
                      />
                    )}
                  </>
                )}
              </Suspense>
            </div>
            <ContextDock
              state={preview}
              dispatch={(action) => {
                ++previewResolveSeq.current;
                dispatchPreview(action);
              }}
              onOpen={openPreviewInEditor}
              onPreview={openPreview}
              onResolve={navigate}
              onChanged={() => {
                refreshLists();
                onSaved();
              }}
              onProtected={() => {
                dispatchPreview({ type: 'close' });
                goView('private');
              }}
            />
          </div>
          <StatusBar
            notePath={view === 'notes' ? (note?.path ?? null) : null}
            onOpenJira={() => goView('jira')}
            onOpenSettings={() => goView('settings')}
            onHelp={() => setHelpOpen(true)}
          />
          <Finder />
          <ClearFindOnClose editorApi={editorApi} />
          {helpOpen && <ShortcutHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
          {chord && <div className="chord-pending">{chord} … then a letter (? for the list)</div>}
        </div>
      </NoteTitlesProvider>
    </ContextPreview>
  );
}
