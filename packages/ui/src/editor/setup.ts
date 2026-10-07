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
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { findNext, findPrevious, highlightSelectionMatches } from '@codemirror/search';
import type { EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { tags } from '@lezer/highlight';
import { findExtension } from './find.ts';
import { frontmatterRange, livePreview } from './livePreview.ts';
import { htmlToMarkdown } from './richPaste.ts';
import { findTables, htmlTableToMarkdown, tsvToMarkdownTable } from './tables.ts';

export interface EditorConfig {
  onNavigate: (target: string) => void;
  /** Mod-F inside the editor: open the app's Finder (in-note matches first) */
  onFind: () => void;
  foldFrontmatter?: () => boolean;
  isResolved: (target: string) => boolean | undefined;
  getSecret: (cipher: string) => string | null;
  onSecretClick: (cipher: string) => void;
  onRevealMany: (ciphers: string[]) => void;
  onEncryptPending: (tableFrom: number, colIndex: number) => void;
  onEncryptSelection: () => void;
  /** note titles/paths for [[ autocompletion */
  completions: () => { title: string; path: string }[];
  /** an image reference in this note → its vault path */
  resolveImage?: (ref: string) => Promise<string | null>;
  /** save a pasted/dropped image; returns the name to embed */
  uploadImage?: (file: File) => Promise<string>;
  onError?: (message: string) => void;
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

/** Image files from a paste or drop: saved under attachments/, embedded as `![[name]]`. */
function insertImages(view: EditorView, cfg: EditorConfig, files: File[], at: number): void {
  const upload = cfg.uploadImage;
  if (!upload) return;
  Promise.all(files.map((f) => upload(f))).then(
    (names) => {
      const pos = Math.min(at, view.state.doc.length);
      const line = view.state.doc.lineAt(pos);
      const before = pos > line.from ? '\n' : '';
      const insert = `${before}${names.map((n) => `![[${n}]]`).join('\n')}\n`;
      view.dispatch({
        changes: { from: pos, insert },
        selection: { anchor: pos + insert.length },
        scrollIntoView: true,
      });
    },
    (e: Error) => cfg.onError?.(`image not saved: ${e.message}`),
  );
}

const imageFiles = (list: FileList | null | undefined): File[] =>
  [...(list ?? [])].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));

function imagePaste(event: ClipboardEvent, view: EditorView, cfg: EditorConfig): boolean {
  const files = imageFiles(event.clipboardData?.files);
  if (!files.length || !cfg.uploadImage) return false;
  event.preventDefault();
  const sel = view.state.selection.main;
  if (!sel.empty) view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } });
  const fm = frontmatterRange(view.state.doc);
  insertImages(view, cfg, files, fm && sel.from <= fm.to ? fm.to : sel.from);
  return true;
}

function imageDrop(event: DragEvent, view: EditorView, cfg: EditorConfig): boolean {
  const files = imageFiles(event.dataTransfer?.files);
  if (!files.length || !cfg.uploadImage) return false;
  event.preventDefault();
  const pos =
    view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
  // never into the properties block: an image line there would break it
  const fm = frontmatterRange(view.state.doc);
  insertImages(view, cfg, files, fm && pos <= fm.to ? fm.to : view.state.doc.lineAt(pos).to);
  return true;
}

/** formatted text from Outlook/Word/Confluence/the web → Markdown (Ctrl+Shift+V stays plain) */
function richPaste(event: ClipboardEvent, view: EditorView): boolean {
  const html = event.clipboardData?.getData('text/html');
  if (!html) return false;
  const sel = view.state.selection.main;
  // inside a table or code, a paste is literal text
  if (findTables(view.state).some((t) => sel.head >= t.from && sel.head <= t.to)) return false;
  for (
    let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(sel.head, -1);
    n;
    n = n.parent
  )
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') return false;
  const md = htmlToMarkdown(html);
  if (!md) return false;
  event.preventDefault();
  const doc = view.state.doc;
  const block = md.includes('\n');
  const atLineStart = sel.from === doc.lineAt(sel.from).from;
  const insert = block && !atLineStart ? `\n${md}\n` : block ? `${md}\n` : md;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    scrollIntoView: true,
  });
  return true;
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
    EditorView.domEventHandlers({
      paste: (e, v) => imagePaste(e, v, cfg) || richPaste(e, v) || tablePaste(e, v),
      drop: (e, v) => imageDrop(e, v, cfg),
    }),
    livePreview({
      onNavigate: cfg.onNavigate,
      foldFrontmatter: cfg.foldFrontmatter,
      onOpenExternal: (href) => window.open(href, '_blank', 'noopener,noreferrer'),
      isResolved: cfg.isResolved,
      getSecret: cfg.getSecret,
      onSecretClick: cfg.onSecretClick,
      onRevealMany: cfg.onRevealMany,
      onEncryptPending: cfg.onEncryptPending,
      resolveImage: cfg.resolveImage,
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
      // Alt+↑/↓ (panels) and Alt+Shift+↑/↓ (notes) are app-wide keys: the
      // editor's move/copy-line bindings on them are dropped, not shadowed
      ...defaultKeymap.filter((b) => !/^(Shift-)?Alt-Arrow(Up|Down)$/.test(b.key ?? '')),
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
