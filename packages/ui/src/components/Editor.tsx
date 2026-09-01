import { Annotation, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, privateApi } from '../api.ts';
import { linksUpdated } from '../editor/livePreview.ts';
import { editorExtensions } from '../editor/setup.ts';
import { encryptTableCells, findTables, pendingCells, splitCells } from '../editor/tables.ts';
import { useDebouncedCallback } from '../hooks.ts';

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
  /**
   * Set to true right before unmounting when the note is being deleted:
   * a pending debounced save is dropped instead of flushed, so the file
   * is not written back after the delete.
   */
  discardRef?: React.RefObject<boolean>;
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
  discardRef,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
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
      window.alert(
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
      window.alert('Wrong passphrase.');
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
      window.alert(e instanceof Error ? e.message : 'decrypt failed');
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
        window.alert(e instanceof Error ? e.message : 'decrypt failed');
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
      window.alert(e instanceof Error ? e.message : 'encrypt failed');
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
        window.alert(
          'Select the text to encrypt first (then Ctrl+Shift+E) — or put the cursor inside a table to encrypt a column/row.',
        );
        return;
      }
      const header = splitCells(table.lines[0] ?? '');
      const answer = window.prompt(
        `Encrypt table cells — enter a column (1-${header.length} or a header name: ${header.join(', ')}) or "row" for the current row:`,
      );
      if (!answer?.trim()) return;
      const doc = view.state.doc;
      const firstLine = doc.lineAt(table.from).number;
      let target: import('../editor/tables.ts').EncryptTarget;
      if (answer.trim().toLowerCase() === 'row') {
        const rowIndex = doc.lineAt(sel.head).number - firstLine - 2;
        if (rowIndex < 0 || rowIndex >= table.lines.length - 2) {
          window.alert('Put the cursor on a data row (not the header) to encrypt a row.');
          return;
        }
        target = { kind: 'row', rowIndex };
      } else {
        const byNumber = Number(answer.trim());
        const index = Number.isInteger(byNumber)
          ? byNumber - 1
          : header.findIndex((h) => h.toLowerCase() === answer.trim().toLowerCase());
        if (index < 0 || index >= header.length) {
          window.alert(`No such column: ${answer.trim()}`);
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
          window.alert('Nothing to encrypt there (cells empty or already encrypted).');
          return;
        }
        view.dispatch({
          changes: { from: table.from, to: table.to, insert: lines.join('\n') },
        });
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'encrypt failed');
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
      window.alert(e instanceof Error ? e.message : 'encrypt failed');
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
  });
  latest.current = { path, onNavigate, onSnapshot, completions, resolveMap, onSaveState, onSaved };

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

  // (Re)create the editor whenever the note path changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recreate only on path change; content is the initial doc, callbacks go through latest ref
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        editorExtensions({
          onNavigate: (t) => latest.current.onNavigate(t),
          isResolved: (t) => latest.current.resolveMap.get(t.toLowerCase()),
          getSecret: (cipher) => revealed.current.get(cipher) ?? null,
          onSecretClick: (cipher) => void onSecretClick(cipher),
          onRevealMany: (ciphers) => void revealMany(ciphers),
          onEncryptPending: (tableFrom, colIndex) => void onEncryptPending(tableFrom, colIndex),
          onEncryptSelection: () => void onEncryptSelection(),
          completions: () => latest.current.completions(),
        }),
        EditorView.updateListener.of((u) => {
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
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem('pass') as HTMLInputElement).value;
              passRequest.resolve(input || null);
              setPassRequest(null);
            }}
          >
            <h2>🔒 Unlock secrets</h2>
            <input
              name="pass"
              type="password"
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
