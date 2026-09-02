import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  pickedCompletion,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { findNext, findPrevious, highlightSelectionMatches } from '@codemirror/search';
import type { EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { findExtension } from './find.ts';
import { livePreview } from './livePreview.ts';
import { findTables, htmlTableToMarkdown, tsvToMarkdownTable } from './tables.ts';

export interface EditorConfig {
  onNavigate: (target: string) => void;
  /** Mod-F inside the editor: open the app's Finder (in-note matches first) */
  onFind: () => void;
  isResolved: (target: string) => boolean | undefined;
  getSecret: (cipher: string) => string | null;
  onSecretClick: (cipher: string) => void;
  onRevealMany: (ciphers: string[]) => void;
  onEncryptPending: (tableFrom: number, colIndex: number) => void;
  onEncryptSelection: () => void;
  /** note titles/paths for [[ autocompletion */
  completions: () => { title: string; path: string }[];
}

const mdHighlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--fg-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--mono)' },
  { tag: tags.processingInstruction, color: 'var(--fg-muted)' },
  { tag: tags.meta, color: 'var(--fg-muted)' },
  { tag: tags.comment, color: 'var(--fg-muted)', fontStyle: 'italic' },
]);

/** Consume the closing brackets that closeBrackets() already put after the cursor. */
export function wikilinkCompletionReplaceTo(state: EditorState, to: number): number {
  const after = state.doc.sliceString(to, Math.min(state.doc.length, to + 2));
  if (after.startsWith(']]')) return to + 2;
  if (after.startsWith(']')) return to + 1;
  return to;
}

function wikilinkCompletions(cfg: EditorConfig) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[([^\][|#]*)$/);
    if (!before) return null;
    const items = cfg.completions();
    return {
      from: before.from + 2,
      options: items.map((n) => ({
        label: n.title,
        detail: n.path,
        apply: (view: EditorView, completion: Completion, from: number, to: number) => {
          const insert = `${n.title}]]`;
          view.dispatch({
            changes: {
              from,
              to: wikilinkCompletionReplaceTo(view.state, to),
              insert,
            },
            selection: { anchor: from + insert.length },
            annotations: pickedCompletion.of(completion),
            scrollIntoView: true,
          });
        },
      })),
      validFor: /^[^\][|#]*$/,
    };
  };
}

/** paste from Excel/OneNote/Sheets → auto-converted markdown table */
function tablePaste(event: ClipboardEvent, view: EditorView): boolean {
  const cd = event.clipboardData;
  if (!cd) return false;
  const sel = view.state.selection.main;
  // pasting inside an existing table = editing cells; leave it raw
  if (findTables(view.state).some((t) => sel.head >= t.from && sel.head <= t.to)) return false;
  const md =
    htmlTableToMarkdown(cd.getData('text/html')) ?? tsvToMarkdownTable(cd.getData('text/plain'));
  if (!md) return false;
  event.preventDefault();
  const atLineStart = sel.from === 0 || view.state.doc.sliceString(sel.from - 1, sel.from) === '\n';
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `${atLineStart ? '' : '\n'}${md}\n` },
  });
  return true;
}

export function editorExtensions(cfg: EditorConfig): Extension {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdHighlight),
    highlightSelectionMatches(),
    findExtension(),
    closeBrackets(),
    autocompletion({ override: [wikilinkCompletions(cfg)], icons: false }),
    EditorView.domEventHandlers({ paste: (e, v) => tablePaste(e, v) }),
    livePreview({
      onNavigate: cfg.onNavigate,
      onOpenExternal: (href) => window.open(href, '_blank', 'noopener,noreferrer'),
      isResolved: cfg.isResolved,
      getSecret: cfg.getSecret,
      onSecretClick: cfg.onSecretClick,
      onRevealMany: cfg.onRevealMany,
      onEncryptPending: cfg.onEncryptPending,
    }),
    keymap.of([
      {
        key: 'Mod-Shift-e',
        run: () => {
          cfg.onEncryptSelection();
          return true;
        },
      },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      // Mod-F belongs to the Finder; F3 / Mod-G walk the current query
      {
        key: 'Mod-f',
        run: () => {
          cfg.onFind();
          return true;
        },
      },
      { key: 'F3', run: findNext, shift: findPrevious, preventDefault: true },
      { key: 'Mod-g', run: findNext, shift: findPrevious, preventDefault: true },
      ...completionKeymap,
      indentWithTab,
    ]),
  ];
}
