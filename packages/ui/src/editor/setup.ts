import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { livePreview } from './livePreview.ts';

export interface EditorConfig {
  onNavigate: (target: string) => void;
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
        apply: `${n.title}]]`,
      })),
      validFor: /^[^\][|#]*$/,
    };
  };
}

export function editorExtensions(cfg: EditorConfig): Extension {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(mdHighlight),
    highlightSelectionMatches(),
    closeBrackets(),
    autocompletion({ override: [wikilinkCompletions(cfg)], icons: false }),
    livePreview({ onNavigate: cfg.onNavigate }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
  ];
}
