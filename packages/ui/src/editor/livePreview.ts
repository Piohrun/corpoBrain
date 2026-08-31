/**
 * Obsidian-style live preview as CodeMirror decorations over raw Markdown.
 * The document is never transformed; markup is hidden/styled contextually
 * and revealed when the cursor touches it.
 */
import { syntaxTree } from '@codemirror/language';
import {
  type EditorState,
  type Extension,
  Facet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

export interface LivePreviewConfig {
  onNavigate: (target: string) => void;
  /** revealed plaintext for an inline secret, or null while hidden */
  getSecret?: (cipher: string) => string | null;
  onSecretClick?: (cipher: string) => void;
  /** true = note exists; false/undefined = placeholder (Obsidian-style dimming) */
  isResolved?: (target: string) => boolean | undefined;
}

/** dispatch when link-resolution data changes so decorations rebuild */
export const linksUpdated = StateEffect.define<null>();

export const livePreviewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig>({
  combine: (values) => values[0] ?? { onNavigate: () => {} },
});

const WIKILINK = /(!?)\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;
const TAG = /(^|[\s(,;])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;
const CHECKBOX = /^(\s*[-*+] )\[( |x|X)\] /;

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-cb-checkbox';
    box.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? '[ ]' : '[x]' },
      });
    };
    return box;
  }
  override ignoreEvent() {
    return true;
  }
}

class SecretWidget extends WidgetType {
  constructor(
    readonly cipher: string,
    readonly revealed: string | null,
  ) {
    super();
  }
  override eq(other: SecretWidget) {
    return other.cipher === this.cipher && other.revealed === this.revealed;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = `cm-secret${this.revealed !== null ? ' revealed' : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cm-secret-btn';
    btn.textContent =
      this.revealed === null ? '\u{1F512} encrypted \u2014 click to reveal' : '\u{1F513}';
    btn.onmousedown = (e) => {
      e.preventDefault();
      view.state.facet(livePreviewConfig).onSecretClick?.(this.cipher);
    };
    wrap.appendChild(btn);
    if (this.revealed !== null) {
      const value = document.createElement('span');
      value.className = 'cm-secret-value';
      value.textContent = this.revealed;
      wrap.appendChild(value);
      const note = document.createElement('span');
      note.className = 'cm-secret-note';
      note.textContent = 'auto-hides';
      wrap.appendChild(note);
    }
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

interface LineCtx {
  cursorTouches: boolean;
  inCodeBlock: boolean;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const config = state.facet(livePreviewConfig);
  const cursor = state.selection.main.head;
  const doc = state.doc;

  // Frontmatter block bounds (manual: lang-markdown does not parse it).
  let fmEnd = -1;
  if (doc.lines > 1 && doc.line(1).text.trim() === '---') {
    for (let i = 2; i <= Math.min(doc.lines, 100); i++) {
      const t = doc.line(i).text.trim();
      if (t === '---' || t === '...') {
        fmEnd = i;
        break;
      }
    }
  }

  // Collect syntax info for the viewport.
  const headings = new Map<number, { level: number; markEnd: number }>();
  const codeLines = new Set<number>();
  const quoteLines = new Set<number>();
  const emphasis: { from: number; to: number; cls: string; marks: [number, number][] }[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        if (name.startsWith('ATXHeading')) {
          const level = Number(name.slice(10)) || 1;
          const line = doc.lineAt(node.from);
          const mark = node.node.getChild('HeaderMark');
          headings.set(line.number, {
            level,
            markEnd: mark ? Math.min(mark.to + 1, line.to) : node.from,
          });
        } else if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let l = first; l <= last; l++) codeLines.add(l);
        } else if (name === 'Blockquote') {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let l = first; l <= last; l++) quoteLines.add(l);
        } else if (name === 'Emphasis' || name === 'StrongEmphasis' || name === 'InlineCode') {
          const cls =
            name === 'Emphasis'
              ? 'cm-cb-em'
              : name === 'StrongEmphasis'
                ? 'cm-cb-strong'
                : 'cm-cb-code';
          const marks: [number, number][] = [];
          const markName = name === 'InlineCode' ? 'CodeMark' : 'EmphasisMark';
          for (let ch = node.node.firstChild; ch; ch = ch.nextSibling) {
            if (ch.name === markName) marks.push([ch.from, ch.to]);
          }
          emphasis.push({ from: node.from, to: node.to, cls, marks });
        }
      },
    });
  }

  // Emit decorations line by line to keep RangeSetBuilder ordering valid.
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const ctx: LineCtx = {
        cursorTouches: cursor >= line.from && cursor <= line.to,
        inCodeBlock: codeLines.has(line.number),
      };
      const inline: { from: number; to: number; deco: Decoration }[] = [];

      // line-level classes
      if (fmEnd >= 0 && line.number <= fmEnd) {
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-cb-frontmatter' }));
      } else if (ctx.inCodeBlock) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({ class: 'cm-cb-codeblock cm-cb-codeblock-bg' }),
        );
      } else {
        const h = headings.get(line.number);
        if (h) {
          builder.add(line.from, line.from, Decoration.line({ class: `cm-cb-h${h.level}` }));
          if (!ctx.cursorTouches && h.markEnd > line.from) {
            inline.push({ from: line.from, to: h.markEnd, deco: Decoration.replace({}) });
          }
        }
        if (quoteLines.has(line.number)) {
          builder.add(line.from, line.from, Decoration.line({ class: 'cm-cb-quote' }));
        }
      }

      if (!ctx.inCodeBlock && (fmEnd < 0 || line.number > fmEnd)) {
        collectInline(line.from, line.text, ctx, cursor, inline, emphasis, config.isResolved);
      }

      inline.sort((a, b) => a.from - b.from || a.to - b.to);
      let last = line.from;
      for (const d of inline) {
        if (d.from < last) continue; // skip overlaps
        builder.add(d.from, d.to, d.deco);
        if (d.to > last) last = d.to;
      }
      if (line.to + 1 > to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function collectInline(
  lineFrom: number,
  text: string,
  ctx: LineCtx,
  cursor: number,
  out: { from: number; to: number; deco: Decoration }[],
  emphasis: { from: number; to: number; cls: string; marks: [number, number][] }[],
  isResolved?: (target: string) => boolean | undefined,
): void {
  const lineTo = lineFrom + text.length;

  // emphasis / inline code within this line
  for (const e of emphasis) {
    if (e.from < lineFrom || e.to > lineTo) continue;
    const cursorIn = cursor >= e.from && cursor <= e.to;
    out.push({ from: e.from, to: e.to, deco: Decoration.mark({ class: e.cls }) });
    if (!cursorIn)
      for (const [mf, mt] of e.marks) out.push({ from: mf, to: mt, deco: Decoration.replace({}) });
  }

  // checkbox
  const cb = CHECKBOX.exec(text);
  if (cb) {
    const prefix = (cb[1] as string).length;
    const boxFrom = lineFrom + prefix;
    if (!ctx.cursorTouches) {
      out.push({
        from: boxFrom,
        to: boxFrom + 3,
        deco: Decoration.replace({
          widget: new CheckboxWidget(cb[2] !== ' ', boxFrom),
        }),
      });
      if (cb[2] !== ' ') {
        out.push({
          from: boxFrom + 4,
          to: lineTo,
          deco: Decoration.mark({ class: 'cm-cb-task-done' }),
        });
      }
    }
  }

  // wikilinks
  WIKILINK.lastIndex = 0;
  for (let m = WIKILINK.exec(text); m; m = WIKILINK.exec(text)) {
    const from = lineFrom + m.index;
    const to = from + m[0].length;
    const target = ((m[2] as string) + (m[3] ?? '')).trim();
    const alias = m[4];
    const cursorIn = cursor >= from && cursor <= to;
    const bareTarget = (m[2] as string).trim();
    const unresolved =
      bareTarget !== '' && isResolved?.(bareTarget) !== true && isResolved !== undefined;
    const attrs = {
      class: `cm-cb-wikilink${unresolved ? ' unresolved' : ''}`,
      'data-target': bareTarget || 'SELF',
      'data-fragment': m[3] ?? '',
    };
    if (cursorIn || ctx.cursorTouches) {
      out.push({ from, to, deco: Decoration.mark({ attributes: attrs }) });
      continue;
    }
    // hide `[[` + (target| when aliased) … `]]`
    const openEnd =
      from + 2 + (alias !== undefined ? (m[2] as string).length + (m[3]?.length ?? 0) + 1 : 0);
    out.push({ from, to: openEnd, deco: Decoration.replace({}) });
    out.push({ from: openEnd, to: to - 2, deco: Decoration.mark({ attributes: attrs }) });
    out.push({ from: to - 2, to, deco: Decoration.replace({}) });
    void target;
  }

  // tags
  TAG.lastIndex = 0;
  for (let m = TAG.exec(text); m; m = TAG.exec(text)) {
    const start = lineFrom + m.index + (m[1] as string).length;
    out.push({
      from: start,
      to: start + 1 + (m[2] as string).length,
      deco: Decoration.mark({ class: 'cm-cb-tag' }),
    });
  }
}

// ---------------------------------------------------------------- secrets
// Block decorations may not come from a view plugin, so secret fences get
// their own StateField. Regex-scanned (parser-independent) — a fence is
// a line that is exactly ```secret, closed by the next ``` line.

interface SecretRange {
  from: number;
  to: number;
  cipher: string;
}

function findSecretBlocks(state: EditorState): SecretRange[] {
  const out: SecretRange[] = [];
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.text.trimEnd() !== '```secret') continue;
    const inner: string[] = [];
    let closed = -1;
    for (let m = n + 1; m <= doc.lines; m++) {
      const t = doc.line(m).text;
      if (t.trimEnd().startsWith('```')) {
        closed = m;
        break;
      }
      inner.push(t.trim());
    }
    if (closed === -1) continue; // unterminated → leave raw
    out.push({ from: line.from, to: doc.line(closed).to, cipher: inner.join('') });
    n = closed;
  }
  return out;
}

function buildSecretDecorations(state: EditorState): DecorationSet {
  const config = state.facet(livePreviewConfig);
  const cursor = state.selection.main.head;
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of findSecretBlocks(state)) {
    // cursor inside → show the raw fence so it can be edited or deleted
    if (cursor >= block.from && cursor <= block.to) continue;
    builder.add(
      block.from,
      block.to,
      Decoration.replace({
        widget: new SecretWidget(block.cipher, config.getSecret?.(block.cipher) ?? null),
        block: true,
      }),
    );
  }
  return builder.finish();
}

const secretField = StateField.define<DecorationSet>({
  create: buildSecretDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(linksUpdated))) {
      return buildSecretDecorations(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.transactions.some((t) => t.effects.some((e) => e.is(linksUpdated)))
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const clickHandler = (view: EditorView, event: MouseEvent): boolean => {
  const el = (event.target as HTMLElement).closest('.cm-cb-wikilink');
  if (!el) return false;
  const target = el.getAttribute('data-target');
  if (!target || target === 'SELF') return false;
  event.preventDefault();
  view.state.facet(livePreviewConfig).onNavigate(target);
  return true;
};

export function livePreview(config: LivePreviewConfig): Extension {
  return [
    livePreviewConfig.of(config),
    plugin,
    secretField,
    // mousedown so the editor does not move the cursor first
    ViewPlugin.define(() => ({}), {
      eventHandlers: { mousedown: (e, view) => clickHandler(view, e) },
    }),
  ];
}
