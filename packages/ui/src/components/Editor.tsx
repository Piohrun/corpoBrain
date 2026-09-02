import { Annotation, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, privateApi, type TrackKind, trackedApi } from '../api.ts';
import { useDialogs } from '../dialogs.tsx';
import { clearFind, type FindMatch, findMatches, selectMatch, setFind } from '../editor/find.ts';
import { linksUpdated } from '../editor/livePreview.ts';
import { editorExtensions } from '../editor/setup.ts';
import { encryptTableCells, findTables, pendingCells, splitCells } from '../editor/tables.ts';
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
  TRACK_RANGE.lastIndex = 0;
  for (let match = TRACK_RANGE.exec(documentText); match; match = TRACK_RANGE.exec(documentText)) {
    if (from < match.index + match[0].length && to > match.index) return null;
  }
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
}

export interface EditorApi {
  /** current text of the open note (unsaved edits included) */
  text: () => string;
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

export function Editor({
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
  };

  const [save, flushSave, cancelSave] = useDebouncedCallback((p: string, text: string) => {
    latest.current.onSaveState(p, 'saving');
    api
      .save(p, text)
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

  // (Re)create the editor whenever the note path changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recreate only on path change; content is the initial doc, callbacks go through latest ref
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        editorExtensions({
          onNavigate: (t) => latest.current.onNavigate(t),
          onFind: () => latest.current.onFind?.(),
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
          save(path, u.state.doc.toString());
          scheduleAutoEncrypt();
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    if (apiRef) {
      apiRef.current = {
        text: () => view.state.doc.toString(),
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
}
