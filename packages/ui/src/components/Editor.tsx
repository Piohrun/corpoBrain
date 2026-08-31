import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { api } from '../api.ts';
import { linksUpdated } from '../editor/livePreview.ts';
import { editorExtensions } from '../editor/setup.ts';
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
  onSaveState: (state: 'saved' | 'saving' | 'error') => void;
  onSaved: () => void;
}

export function Editor({
  path,
  content,
  completions,
  resolveMap,
  onNavigate,
  onSnapshot,
  onSaveState,
  onSaved,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
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

  const [save, flushSave] = useDebouncedCallback((p: string, text: string) => {
    latest.current.onSaveState('saving');
    api
      .save(p, text)
      .then(() => {
        latest.current.onSaveState('saved');
        latest.current.onSaved();
      })
      .catch(() => latest.current.onSaveState('error'));
  }, 700);

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
          completions: () => latest.current.completions(),
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) save(path, u.state.doc.toString());
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
      flushSave();
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
      });
    }
  }, [content]);

  // resolution data changed (note created/deleted elsewhere) → restyle links
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolveMap is deliberately the trigger; the effect reads it via the latest ref inside CM
  useEffect(() => {
    viewRef.current?.dispatch({ effects: linksUpdated.of(null) });
  }, [resolveMap]);

  return <div className="editor-host" ref={host} />;
}
