import { Annotation, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type React from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api, privateApi, type TrackKind, trackedApi } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  linesToTasks,
  linkAt,
  setTaskDue,
  tableCellAt,
  taskLine,
  toggleTask,
  toggleTaskKind,
} from '../editor/contextTargets.ts';
import { clearFind, type FindMatch, findMatches, selectMatch, setFind } from '../editor/find.ts';
import { linksUpdated } from '../editor/livePreview.ts';
import { editorExtensions } from '../editor/setup.ts';
import { encryptTableCells, findTables, pendingCells, splitCells } from '../editor/tables.ts';
import { type ContextTarget, useContextMenu } from '../finder/ContextMenu.tsx';
import { useFinderActions, useFinderSections } from '../finder/registry.tsx';
import { type FinderItem, section } from '../finder/types.ts';
import { useDebouncedCallback } from '../hooks.ts';
import { TrackDialog, type TrackDialogValue } from './TrackDialog.tsx';

interface TrackSelection {
  excerpt: string;
  from: number;
  to: number;
  line: number;
  left: number;
  top: number;
}

const TRACK_RANGE =
  /<!--\s*cb-track:([0-9A-Z]+):(commitment|decision|risk|assumption)\s*-->[\s\S]*?<!--\s*\/cb-track:\1\s*-->/gi;

function selectedEvidence(view: EditorView): TrackSelection | null {
  const selection = view.state.selection.main;
  if (selection.empty) return null;
  const raw = view.state.doc.sliceString(selection.from, selection.to);
  const excerpt = raw.trim();
  if (!excerpt || excerpt.length > 4_000) return null;
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const from = selection.from + leading;
  const to = selection.to - trailing;
  const documentText = view.state.doc.toString();
  if (!/cb-track/i.test(documentText)) return evidenceAt(view, excerpt, from, to);
  TRACK_RANGE.lastIndex = 0;
  for (let match = TRACK_RANGE.exec(documentText); match; match = TRACK_RANGE.exec(documentText)) {
    if (from < match.index + match[0].length && to > match.index) return null;
  }
  return evidenceAt(view, excerpt, from, to);
}

function evidenceAt(
  view: EditorView,
  excerpt: string,
  from: number,
  to: number,
): TrackSelection | null {
  const start = view.coordsAtPos(from);
  const end = view.coordsAtPos(to);
  if (!start || !end) return null;
  return {
    excerpt,
    from,
    to,
    line: view.state.doc.lineAt(from).number,
    left: Math.max(76, Math.min(window.innerWidth - 76, (start.left + end.right) / 2)),
    top: Math.max(8, Math.min(start.top, end.top) - 42),
  };
}

interface Props {
  path: string;
  content: string;
  completions: () => { title: string; path: string }[];
  /** lowercased link target → exists? */
  resolveMap: Map<string, boolean>;
  onNavigate: (target: string) => void;
  /** called on unmount with the editor's final text so the app state stays current */
  onSnapshot: (path: string, content: string) => void;
  /** save progress for `path` — the app ignores reports for a note that is no longer open */
  onSaveState: (path: string, state: 'saved' | 'saving' | 'error') => void;
  onSaved: () => void;
  onTrackedCreated: (recordPath: string, sourcePath: string, sourceContent: string) => void;
  onShowTracked: () => void;
  /**
   * Set to true right before unmounting when the note is being deleted:
   * a pending debounced save is dropped instead of flushed, so the file
   * is not written back after the delete.
   */
  discardRef?: React.RefObject<boolean>;
  /** imperative access for the Finder: in-note find, insert/wrap, focus */
  apiRef?: React.RefObject<EditorApi | null>;
  onFind?: () => void;
  /** hide the frontmatter block (shown as a properties bar by the app) */
  foldFrontmatter?: boolean;
}

export interface EditorApi {
  /** current text of the open note (unsaved edits included) */
  text: () => string;
  /** Persist pending text before a metadata editor changes this note on disk. */
  saveNow: () => Promise<void>;
  /** every match with line context; also highlights them in the editor */
  find: (query: string) => FindMatch[];
  clearFind: () => void;
  goTo: (m: { from: number; to: number }) => void;
  selection: () => string;
  /** insert at the cursor (replacing a selection) and focus */
  insert: (text: string) => void;
  /** wrap the selection (or insert when empty) */
  wrap: (before: string, after: string) => void;
  focus: () => void;
}

/** marks a doc replacement that came FROM the server (SSE), so it is not saved back */
const externalChange = Annotation.define<boolean>();

export const Editor = memo(function Editor({
  path,
  content,
  completions,
  resolveMap,
  onNavigate,
  onSnapshot,
  onSaveState,
  onSaved,
  onTrackedCreated,
  onShowTracked,
  discardRef,
  apiRef,
  onFind,
  foldFrontmatter = false,
}: Props) {
  const dlg = useDialogs();
  const host = useRef<HTMLDivElement>(null);
  const [trackSelection, setTrackSelection] = useState<TrackSelection | null>(null);
  const [trackDialogOpen, setTrackDialogOpen] = useState(false);
  const [trackSaving, setTrackSaving] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);
  const [trackConfirmation, setTrackConfirmation] = useState<TrackKind | null>(null);
  const trackToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** revealed inline secrets: cipher → plaintext (memory only, self-expiring) */
  const revealed = useRef(new Map<string, string>());
  const [passRequest, setPassRequest] = useState<{
    resolve: (value: string | null) => void;
  } | null>(null);

  const promptPassphrase = () =>
    new Promise<string | null>((resolve) => setPassRequest({ resolve }));
  const hideTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const refreshDecorations = () => viewRef.current?.dispatch({ effects: linksUpdated.of(null) });

  const hideSecret = (cipher?: string) => {
    if (cipher) {
      revealed.current.delete(cipher);
      const t = hideTimers.current.get(cipher);
      if (t) clearTimeout(t);
      hideTimers.current.delete(cipher);
    } else {
      revealed.current.clear();
      for (const t of hideTimers.current.values()) clearTimeout(t);
      hideTimers.current.clear();
    }
    refreshDecorations();
  };

  const ensureUnlocked = async (): Promise<boolean> => {
    const st = await privateApi.status();
    if (st.unlocked) return true;
    if (!st.initialized) {
      dlg.alert(
        'Set up protected notes first (\u{1F512} page) — inline secrets share that passphrase.',
      );
      return false;
    }
    const pass = await promptPassphrase();
    if (!pass) return false;
    try {
      await privateApi.unlock(pass);
      return true;
    } catch {
      dlg.alert('Wrong passphrase.');
      return false;
    }
  };

  const onSecretClick = async (cipher: string) => {
    if (revealed.current.has(cipher)) {
      hideSecret(cipher);
      return;
    }
    if (!(await ensureUnlocked())) return;
    try {
      const { text } = await privateApi.decrypt(cipher);
      revealed.current.set(cipher, text);
      hideTimers.current.set(
        cipher,
        setTimeout(() => hideSecret(cipher), 30_000),
      );
      refreshDecorations();
    } catch (e) {
      dlg.alert(e instanceof Error ? e.message : 'decrypt failed');
    }
  };

  const revealMany = async (ciphers: string[]) => {
    const missing = ciphers.filter((c) => !revealed.current.has(c));
    if (missing.length === 0) {
      // everything already revealed → toggle the whole set hidden
      for (const cipher of ciphers) {
        revealed.current.delete(cipher);
        const t = hideTimers.current.get(cipher);
        if (t) clearTimeout(t);
        hideTimers.current.delete(cipher);
      }
      refreshDecorations();
      return;
    }
    if (missing.length) {
      if (!(await ensureUnlocked())) return;
      try {
        const { texts } = await privateApi.decryptMany(missing);
        missing.forEach((cipher, i) => {
          const text = texts[i];
          if (text === null || text === undefined) return;
          revealed.current.set(cipher, text);
          hideTimers.current.set(
            cipher,
            setTimeout(() => hideSecret(cipher), 30_000),
          );
        });
      } catch (e) {
        dlg.alert(e instanceof Error ? e.message : 'decrypt failed');
        return;
      }
    }
    refreshDecorations();
  };

  /** encrypt the plaintext cells of one encrypted column (header ⚠ button) */
  /** false once the note switched under an in-flight async edit */
  const stillOpen = (view: EditorView): boolean => viewRef.current === view;

  const onEncryptPending = async (tableFrom: number, colIndex: number) => {
    const view = viewRef.current;
    if (!view) return;
    const table = findTables(view.state).find((t) => t.from === tableFrom);
    if (!table) return;
    if (!(await ensureUnlocked())) return;
    if (!stillOpen(view)) return;
    try {
      const { lines, encrypted } = await encryptTableCells(
        table.lines,
        { kind: 'column', index: colIndex },
        async (t) => (await privateApi.encrypt(t)).data,
      );
      if (!stillOpen(view)) return;
      if (encrypted > 0) {
        view.dispatch({ changes: { from: table.from, to: table.to, insert: lines.join('\n') } });
      }
    } catch (e) {
      dlg.alert(e instanceof Error ? e.message : 'encrypt failed');
    }
  };

  /**
   * Auto-heal: when the doc settles and the cursor is outside a table that
   * has plaintext cells in encrypted columns, encrypt them — but only if
   * the session is already unlocked (never prompt spontaneously; locked
   * sessions leave the cells visibly flagged instead).
   */
  const autoEncryptPending = async () => {
    const view = viewRef.current;
    if (!view) return;
    const head = view.state.selection.main.head;
    const targets = findTables(view.state).filter(
      (t) => (head < t.from || head > t.to) && pendingCells(t.lines).length > 0,
    );
    if (!targets.length) return;
    try {
      const st = await privateApi.status();
      if (!st.unlocked) return; // flagged in the UI; user encrypts explicitly
    } catch {
      return;
    }
    if (!stillOpen(view)) return;
    for (const table of targets) {
      // re-read: the doc may have moved on while a previous table encrypted
      const current = findTables(view.state).find((t) => t.from === table.from);
      if (!current) continue;
      const cols = [...new Set(pendingCells(current.lines).map((c) => c.colIndex))];
      let lines = current.lines;
      let total = 0;
      for (const col of cols) {
        const res = await encryptTableCells(lines, { kind: 'column', index: col }, async (t) => {
          const { data } = await privateApi.encrypt(t);
          return data;
        });
        lines = res.lines;
        total += res.encrypted;
      }
      // the offsets belong to THIS view; a note switch mid-await must not
      // splice encrypted rows into whatever note is open now
      if (!stillOpen(view)) return;
      if (total > 0) {
        view.dispatch({
          changes: { from: current.from, to: current.to, insert: lines.join('\n') },
        });
      }
    }
  };

  /** Encrypt one column or row of a table (unlocking first if needed). */
  const encryptTable = async (
    view: EditorView,
    table: { from: number; to: number; lines: string[] },
    target: import('../editor/tables.ts').EncryptTarget,
  ) => {
    if (!(await ensureUnlocked())) return;
    if (!stillOpen(view)) return;
    try {
      const { lines, encrypted } = await encryptTableCells(table.lines, target, async (t) => {
        const { data } = await privateApi.encrypt(t);
        return data;
      });
      if (!stillOpen(view)) return;
      if (encrypted === 0) {
        dlg.alert('Nothing to encrypt there (cells empty or already encrypted).');
        return;
      }
      view.dispatch({
        changes: { from: table.from, to: table.to, insert: lines.join('\n') },
      });
    } catch (e) {
      dlg.alert(e instanceof Error ? e.message : 'encrypt failed');
    }
  };

  const onEncryptSelection = async () => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) {
      // cursor inside a table → offer column/row encryption
      const table = findTables(view.state).find((t) => sel.head >= t.from && sel.head <= t.to);
      if (!table) {
        dlg.alert(
          'Select the text to encrypt first (then Ctrl+Shift+E) — or put the cursor inside a table to encrypt a column/row.',
        );
        return;
      }
      const header = splitCells(table.lines[0] ?? '');
      const answer = await dlg.prompt(
        `Encrypt table cells — enter a column (1-${header.length} or a header name: ${header.join(', ')}) or "row" for the current row:`,
      );
      if (!answer?.trim()) return;
      const doc = view.state.doc;
      const firstLine = doc.lineAt(table.from).number;
      let target: import('../editor/tables.ts').EncryptTarget;
      if (answer.trim().toLowerCase() === 'row') {
        const rowIndex = doc.lineAt(sel.head).number - firstLine - 2;
        if (rowIndex < 0 || rowIndex >= table.lines.length - 2) {
          dlg.alert('Put the cursor on a data row (not the header) to encrypt a row.');
          return;
        }
        target = { kind: 'row', rowIndex };
      } else {
        const byNumber = Number(answer.trim());
        const index = Number.isInteger(byNumber)
          ? byNumber - 1
          : header.findIndex((h) => h.toLowerCase() === answer.trim().toLowerCase());
        if (index < 0 || index >= header.length) {
          dlg.alert(`No such column: ${answer.trim()}`);
          return;
        }
        target = { kind: 'column', index };
      }
      await encryptTable(view, table, target);
      return;
    }
    const text = view.state.doc.sliceString(sel.from, sel.to);
    if (!(await ensureUnlocked())) return;
    if (!stillOpen(view)) return;
    try {
      const { data } = await privateApi.encrypt(text);
      if (!stillOpen(view)) return;
      const insert = text.includes('\n')
        ? `\n\`\`\`secret\n${data}\n\`\`\`\n`
        : `\`\u{1F512}${data}\``;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
      });
    } catch (e) {
      dlg.alert(e instanceof Error ? e.message : 'encrypt failed');
    }
  };

  // hide all revealed secrets when the tab loses visibility
  // biome-ignore lint/correctness/useExhaustiveDependencies: hideSecret reads refs only; attach once
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) hideSecret();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({
    path,
    onNavigate,
    onSnapshot,
    completions,
    resolveMap,
    onSaveState,
    onSaved,
    onFind,
    foldFrontmatter,
  });
  latest.current = {
    path,
    onNavigate,
    onSnapshot,
    completions,
    resolveMap,
    onSaveState,
    onSaved,
    onFind,
    foldFrontmatter,
  };
  // the fold flag is read through the ref at decoration time; nudge a rebuild when it flips
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshDecorations reads refs only
  useEffect(() => {
    refreshDecorations();
  }, [foldFrontmatter]);

  const saveInFlight = useRef<Promise<unknown>>(Promise.resolve());
  // Receives the editor state, not its text: stringifying a long note on every
  // keystroke was wasted work, only the state the debounce settles on is saved.
  const [save, flushSave, cancelSave] = useDebouncedCallback((p: string, state: EditorState) => {
    const text = state.doc.toString();
    latest.current.onSaveState(p, 'saving');
    const pending = saveInFlight.current.catch(() => undefined).then(() => api.save(p, text));
    saveInFlight.current = pending;
    pending
      .then(() => {
        latest.current.onSaveState(p, 'saved');
        latest.current.onSaved();
      })
      .catch(() => latest.current.onSaveState(p, 'error'));
  }, 700);

  const [scheduleAutoEncrypt] = useDebouncedCallback(() => {
    void autoEncryptPending();
  }, 1200);

  useEffect(
    () => () => {
      if (trackToastTimer.current) clearTimeout(trackToastTimer.current);
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing notes clears transient selection UI
  useEffect(() => {
    setTrackSelection(null);
    setTrackDialogOpen(false);
    setTrackError(null);
  }, [path]);

  const submitTracked = async (value: TrackDialogValue) => {
    const evidence = trackSelection;
    const view = viewRef.current;
    if (!evidence || !view) return;
    setTrackSaving(true);
    setTrackError(null);

    // The tracked object must point at the exact version the user selected.
    // Cancel the pending debounce and persist that version before creating it.
    cancelSave();
    latest.current.onSaveState(path, 'saving');
    try {
      await api.save(path, view.state.doc.toString());
      latest.current.onSaveState(path, 'saved');
      latest.current.onSaved();
    } catch (e) {
      latest.current.onSaveState(path, 'error');
      setTrackError(e instanceof Error ? `Could not save the source: ${e.message}` : 'Save failed');
      setTrackSaving(false);
      return;
    }

    try {
      const created = await trackedApi.create({
        kind: value.kind,
        statement: value.statement,
        excerpt: evidence.excerpt,
        sourcePath: path,
        sourceLine: evidence.line,
        sourceFrom: evidence.from,
        sourceTo: evidence.to,
        ...(value.owner ? { owner: value.owner } : {}),
        ...(value.date ? { date: value.date } : {}),
      });
      if (!stillOpen(view)) return;
      const closing = `<!-- /cb-track:${created.trackId} -->`;
      const closingAt = created.sourceContent.indexOf(closing);
      const head =
        closingAt >= 0
          ? closingAt + closing.length
          : Math.min(evidence.to, created.sourceContent.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: created.sourceContent },
        selection: { anchor: head },
        annotations: externalChange.of(true),
      });
      latest.current.onSnapshot(path, created.sourceContent);
      onTrackedCreated(created.path, path, created.sourceContent);
      setTrackDialogOpen(false);
      setTrackSelection(null);
      setTrackConfirmation(value.kind);
      if (trackToastTimer.current) clearTimeout(trackToastTimer.current);
      trackToastTimer.current = setTimeout(() => setTrackConfirmation(null), 4_000);
      view.focus();
    } catch (e) {
      setTrackError(e instanceof Error ? e.message : 'Could not create tracked item');
    } finally {
      setTrackSaving(false);
    }
  };

  // ---- context menu: what is under the cursor, and what can be done there ----
  const finder = useFinderActions();
  const ctxMenu = useContextMenu();
  /** a document position, and for a rendered table the cell that was clicked */
  type At = { pos: number; cell?: { row: number; col: number } };
  // biome-ignore lint/correctness/useExhaustiveDependencies: actions read the live view and refs at run time
  const editorSections = useMemo(() => {
    const view = () => viewRef.current;
    /** run a line edit if the line still looks like it did when the menu opened */
    const editLine = (pos: number, edit: (text: string) => string) => {
      const v = view();
      if (!v || pos > v.state.doc.length) return;
      const line = v.state.doc.lineAt(pos);
      const next = edit(line.text);
      if (next !== line.text)
        v.dispatch({ changes: { from: line.from, to: line.to, insert: next } });
      v.focus();
    };
    const tableAt = ({ pos, cell: clicked }: At) => {
      const v = view();
      if (!v) return null;
      const table = findTables(v.state).find((t) => pos >= t.from && pos <= t.to);
      if (!table) return null;
      const doc = v.state.doc;
      const line = doc.lineAt(pos);
      const cell =
        clicked ??
        tableCellAt(table.lines, line.number - doc.lineAt(table.from).number, pos - line.from);
      return { v, table, ...cell };
    };
    const editTable = (
      at: At,
      edit: (lines: string[], cell: { row: number; col: number }) => string[],
    ) => {
      const t = tableAt(at);
      if (!t) return;
      const next = edit(t.table.lines, t);
      if (next !== t.table.lines)
        t.v.dispatch({ changes: { from: t.table.from, to: t.table.to, insert: next.join('\n') } });
      t.v.focus();
    };
    const selection = section<{ text: string }>({
      id: 'editor-selection',
      title: 'Selection',
      order: 100,
      contextOnly: true,
      search: () => [],
      actions: [
        {
          id: 'track',
          label: 'track as…',
          run: () => {
            const v = view();
            const evidence = v ? selectedEvidence(v) : null;
            if (!evidence) return;
            setTrackSelection(evidence);
            setTrackDialogOpen(true);
          },
        },
        {
          id: 'task',
          label: 'turn into tasks',
          run: () => {
            const v = view();
            if (!v) return;
            const sel = v.state.selection.main;
            const from = v.state.doc.lineAt(sel.from).from;
            const to = v.state.doc.lineAt(sel.to).to;
            const text = v.state.doc.sliceString(from, to);
            const next = linesToTasks(text);
            if (next !== text) v.dispatch({ changes: { from, to, insert: next } });
            v.focus();
          },
        },
        {
          id: 'encrypt',
          label: 'encrypt',
          keys: 'Mod+Shift+E',
          run: () => void onEncryptSelection(),
        },
        {
          id: 'find',
          label: 'find in vault',
          run: ([item]) => finder.open({ query: item?.data.text.slice(0, 120) ?? '' }),
        },
        {
          id: 'copy',
          label: 'copy',
          run: ([item]) =>
            void navigator.clipboard?.writeText(item?.data.text ?? '').catch(() => {}),
        },
      ],
    });
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const task = section<At & { done: boolean; jira: boolean }>({
      id: 'editor-task',
      title: 'Task',
      order: 101,
      contextOnly: true,
      search: () => [],
      actions: [
        {
          id: 'toggle',
          label: 'mark done / not done',
          run: ([i]) => i && editLine(i.data.pos, toggleTask),
        },
        {
          id: 'today',
          label: 'due today',
          run: ([i]) => i && editLine(i.data.pos, (t) => setTaskDue(t, today())),
        },
        {
          id: 'due',
          label: 'set due date…',
          run: async ([i]) => {
            if (!i) return;
            const date = await dlg.prompt({
              title: 'Due date',
              label: 'YYYY-MM-DD (empty removes it)',
              initial: today(),
              confirmLabel: 'Set',
            });
            if (date === null) return;
            const d = date.trim();
            if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
              dlg.alert('Use the form YYYY-MM-DD.');
              return;
            }
            editLine(i.data.pos, (t) => setTaskDue(t, d || null));
          },
        },
        {
          id: 'kind',
          label: 'switch: task ↔ Jira item',
          run: ([i]) => i && editLine(i.data.pos, toggleTaskKind),
        },
      ],
    });
    const table = section<At>({
      id: 'editor-table',
      title: 'Table',
      order: 102,
      contextOnly: true,
      search: () => [],
      actions: [
        {
          id: 'row-below',
          label: 'insert row below',
          run: ([i]) => i && editTable(i.data, (lines, c) => insertRow(lines, c.row)),
        },
        {
          id: 'col-right',
          label: 'insert column to the right',
          run: ([i]) => i && editTable(i.data, (lines, c) => insertColumn(lines, c.col)),
        },
        {
          id: 'row-delete',
          label: 'delete this row',
          when: (items) => {
            const t = items[0] ? tableAt(items[0].data) : null;
            return !!t && t.row >= 0;
          },
          run: ([i]) => i && editTable(i.data, (lines, c) => deleteRow(lines, c.row)),
        },
        {
          id: 'col-delete',
          label: 'delete this column',
          run: ([i]) => i && editTable(i.data, (lines, c) => deleteColumn(lines, c.col)),
        },
        {
          id: 'enc-col',
          label: 'encrypt this column',
          run: ([i]) => {
            const t = i ? tableAt(i.data) : null;
            if (t) void encryptTable(t.v, t.table, { kind: 'column', index: t.col });
          },
        },
        {
          id: 'enc-row',
          label: 'encrypt this row',
          when: (items) => {
            const t = items[0] ? tableAt(items[0].data) : null;
            return !!t && t.row >= 0;
          },
          run: ([i]) => {
            const t = i ? tableAt(i.data) : null;
            if (t && t.row >= 0) void encryptTable(t.v, t.table, { kind: 'row', rowIndex: t.row });
          },
        },
      ],
    });
    const url = section<{ url: string }>({
      id: 'editor-url',
      title: 'Web link',
      order: 99,
      contextOnly: true,
      search: () => [],
      actions: [
        {
          id: 'open',
          label: 'open in a new tab',
          run: ([i]) => i && void window.open(i.data.url, '_blank', 'noopener'),
        },
        {
          id: 'copy',
          label: 'copy address',
          run: ([i]) => i && void navigator.clipboard?.writeText(i.data.url).catch(() => {}),
        },
      ],
    });
    return [selection, task, table, url];
  }, [finder, dlg]);
  useFinderSections('editor', editorSections);

  /** What the context menu offers at a document position. */
  const targetsAt = (
    view: EditorView,
    pos: number,
    cell?: { row: number; col: number },
  ): ContextTarget[] => {
    const out: ContextTarget[] = [];
    const line = view.state.doc.lineAt(pos);
    const link = linkAt(line.text, pos - line.from);
    if (link?.kind === 'note') out.push({ section: 'notes', id: link.target });
    if (link?.kind === 'jira') {
      out.push({ section: 'plan-issues', id: link.key });
      out.push({ section: 'notes', id: `jira/${link.key}.md` });
    }
    if (link?.kind === 'url')
      out.push({
        section: 'editor-url',
        item: { id: link.url, label: link.url, data: { url: link.url } },
      });
    const sel = view.state.selection.main;
    if (!sel.empty) {
      const text = view.state.doc.sliceString(sel.from, sel.to);
      out.push({
        section: 'editor-selection',
        item: { id: 'sel', label: text.slice(0, 40), data: { text } },
      });
    }
    const t = taskLine(line.text);
    if (t)
      out.push({
        section: 'editor-task',
        item: {
          id: `task:${line.number}`,
          label: line.text.trim(),
          data: { pos, ...t },
        } as FinderItem,
      });
    if (findTables(view.state).some((tb) => pos >= tb.from && pos <= tb.to))
      out.push({
        section: 'editor-table',
        item: { id: `table:${pos}`, label: 'table', data: cell ? { pos, cell } : { pos } },
      });
    // and always the note itself, so the menu is never empty in a note
    out.push({ section: 'notes', id: latest.current.path });
    return out;
  };
  const targetsAtRef = useRef(targetsAt);
  targetsAtRef.current = targetsAt;

  // biome-ignore lint/correctness/useExhaustiveDependencies: registers once for the editor host; reads refs
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    return ctxMenu.provide(root, ({ event }) => {
      const view = viewRef.current;
      if (!view) return null;
      if (event) {
        let pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return null;
        // Right after a block widget (a table) changes height, the editor's
        // height map can be stale and map the click to a neighbouring line:
        // trust the line element that was actually clicked.
        const clickedLine =
          event.target instanceof Element ? event.target.closest('.cm-line') : null;
        if (clickedLine && view.contentDOM.contains(clickedLine)) {
          const lineStart = view.posAtDOM(clickedLine);
          const line = view.state.doc.lineAt(lineStart);
          if (pos < line.from || pos > line.to) pos = line.from;
        }
        const sel = view.state.selection.main;
        // like any editor: a right-click outside the selection moves the cursor there
        if (pos < sel.from || pos > sel.to || sel.empty)
          view.dispatch({ selection: { anchor: pos } });
        // a rendered table cell knows exactly which row and column it is
        const td =
          event.target instanceof Element ? event.target.closest<HTMLElement>('td, th') : null;
        const cell =
          td?.dataset.row !== undefined && td.dataset.col !== undefined
            ? { row: Number(td.dataset.row), col: Number(td.dataset.col) }
            : undefined;
        return {
          targets: targetsAtRef.current(view, pos, cell),
          x: event.clientX,
          y: event.clientY,
        };
      }
      const pos = view.state.selection.main.head;
      const coords = view.coordsAtPos(pos);
      return {
        targets: targetsAtRef.current(view, pos),
        x: coords?.left ?? 0,
        y: coords?.bottom ?? 0,
      };
    });
  }, []);

  // (Re)create the editor whenever the note path changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recreate only on path change; content is the initial doc, callbacks go through latest ref
  useEffect(() => {
    if (!host.current) return;
    // open with the cursor on the first body line, not inside the frontmatter
    // (which would keep the folded block open)
    const fmMatch = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
    let bodyStart = Math.min(fmMatch ? fmMatch[0].length : 0, content.length);
    // a cursor on the H1 would show its raw '#': start on the line after it
    const firstLine = /^(#{1,6} [^\n]*)\n?/.exec(content.slice(bodyStart));
    if (firstLine) bodyStart = Math.min(bodyStart + firstLine[0].length, content.length);
    const state = EditorState.create({
      doc: content,
      selection: { anchor: bodyStart },
      extensions: [
        editorExtensions({
          onNavigate: (t) => latest.current.onNavigate(t),
          onFind: () => latest.current.onFind?.(),
          foldFrontmatter: () => latest.current.foldFrontmatter,
          isResolved: (t) => latest.current.resolveMap.get(t.toLowerCase()),
          getSecret: (cipher) => revealed.current.get(cipher) ?? null,
          onSecretClick: (cipher) => void onSecretClick(cipher),
          onRevealMany: (ciphers) => void revealMany(ciphers),
          onEncryptPending: (tableFrom, colIndex) => void onEncryptPending(tableFrom, colIndex),
          onEncryptSelection: () => void onEncryptSelection(),
          completions: () => latest.current.completions(),
        }),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged || u.viewportChanged) {
            setTrackSelection(selectedEvidence(u.view));
          }
          if (!u.docChanged) return;
          // content pushed in from the vault watcher is already on disk;
          // echoing it back would overwrite a newer external edit
          if (u.transactions.some((t) => t.annotation(externalChange))) return;
          save(path, u.state);
          scheduleAutoEncrypt();
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    if (apiRef) {
      apiRef.current = {
        text: () => view.state.doc.toString(),
        saveNow: async () => {
          cancelSave();
          await saveInFlight.current.catch(() => undefined);
          cancelSave();
          if (viewRef.current !== view) throw new Error('The open note changed; try again.');
          latest.current.onSaveState(path, 'saving');
          try {
            const pending = api.save(path, view.state.doc.toString());
            saveInFlight.current = pending;
            await pending;
            latest.current.onSaveState(path, 'saved');
          } catch (error) {
            latest.current.onSaveState(path, 'error');
            throw error;
          }
        },
        find: (q) => {
          setFind(view, q);
          return findMatches(view, q);
        },
        clearFind: () => clearFind(view),
        goTo: (m) => selectMatch(view, m),
        selection: () => {
          const sel = view.state.selection.main;
          return view.state.doc.sliceString(sel.from, sel.to);
        },
        insert: (text) => {
          const sel = view.state.selection.main;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
            scrollIntoView: true,
          });
          view.focus();
        },
        wrap: (before, after) => {
          const sel = view.state.selection.main;
          const inner = view.state.doc.sliceString(sel.from, sel.to);
          const text = `${before}${inner}${after}`;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            selection: { anchor: sel.from + text.length },
            scrollIntoView: true,
          });
          view.focus();
        },
        focus: () => view.focus(),
      };
    }
    view.focus();
    return () => {
      // hand the final text back before unmount so a remount shows what was
      // typed (the flush below persists it, but app state must match too)
      latest.current.onSnapshot(path, view.state.doc.toString());
      revealed.current.clear();
      for (const t of hideTimers.current.values()) clearTimeout(t);
      hideTimers.current.clear();
      if (discardRef?.current) cancelSave();
      else flushSave();
      view.destroy();
      viewRef.current = null;
      if (apiRef) apiRef.current = null;
    };
  }, [path]);

  // External change to the open note (SSE): replace content, keep cursor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      const head = Math.min(view.state.selection.main.head, content.length);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: content },
        selection: { anchor: head },
        annotations: externalChange.of(true),
      });
    }
  }, [content]);

  // resolution data changed (note created/deleted elsewhere) → restyle links
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveMap is deliberately the trigger; the effect reads it via the latest ref inside CM
  useEffect(() => {
    viewRef.current?.dispatch({ effects: linksUpdated.of(null) });
  }, [resolveMap]);

  return (
    <>
      <div className="editor-host" ref={host} />
      {trackSelection && !trackDialogOpen && (
        <button
          type="button"
          className="track-selection-button"
          style={{ left: trackSelection.left, top: trackSelection.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setTrackError(null);
            setTrackDialogOpen(true);
          }}
        >
          ＋ Track as…
        </button>
      )}
      {trackDialogOpen && trackSelection && (
        <TrackDialog
          excerpt={trackSelection.excerpt}
          sourcePath={path}
          sourceLine={trackSelection.line}
          saving={trackSaving}
          error={trackError}
          onClose={() => {
            if (!trackSaving) {
              setTrackDialogOpen(false);
              setTrackError(null);
            }
          }}
          onSubmit={(value) => void submitTracked(value)}
        />
      )}
      {trackConfirmation && (
        <div className="track-toast" role="status">
          <span>✓ Tracked as {trackConfirmation}</span>
          <button
            type="button"
            onClick={() => {
              setTrackConfirmation(null);
              onShowTracked();
            }}
          >
            View tracked
          </button>
        </div>
      )}
      {passRequest && (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click cancels; Escape handled on the input
        <div
          className="palette-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              passRequest.resolve(null);
              setPassRequest(null);
            }
          }}
        >
          <form
            className="unlock-box"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unlock-title"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem('pass') as HTMLInputElement).value;
              passRequest.resolve(input || null);
              setPassRequest(null);
            }}
          >
            <h2 id="unlock-title">🔒 Unlock secrets</h2>
            <input
              name="pass"
              type="password"
              aria-label="Passphrase"
              placeholder="Passphrase"
              ref={(el) => el?.focus()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  passRequest.resolve(null);
                  setPassRequest(null);
                }
              }}
            />
            <button type="submit" className="plan-btn">
              Unlock
            </button>
          </form>
        </div>
      )}
    </>
  );
});
