import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { api } from '../api.ts';
import { editorExtensions } from '../editor/setup.ts';
import { useDebouncedCallback } from '../hooks.ts';

interface Props {
  path: string;
  content: string;
  completions: () => { title: string; path: string }[];
  onNavigate: (target: string) => void;
  onSaveState: (state: 'saved' | 'saving' | 'error') => void;
  onSaved: () => void;
}

export function Editor({ path, content, completions, onNavigate, onSaveState, onSaved }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef({ path, onNavigate, completions, onSaveState, onSaved });
  latest.current = { path, onNavigate, completions, onSaveState, onSaved };

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
      flushSave();
      view.destroy();
      viewRef.current = null;
    };
  }, [path]);

  // External change to the open note (SSE): replace content, keep cursor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to content only; the view ref is stable
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

  return <div className="editor-host" ref={host} />;
}
