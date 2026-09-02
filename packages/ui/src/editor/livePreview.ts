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
  type Line,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { type ExternalLink, externalLinksInTree } from './externalLinks.ts';
import { tablesField } from './tables.ts';

export interface LivePreviewConfig {
  onNavigate: (target: string) => void;
  /**
   * Hide the frontmatter block (the app shows it as a properties bar).
   * It unfolds while the cursor is inside it, so it stays editable.
   */
  foldFrontmatter?: () => boolean;
  onOpenExternal?: (href: string) => void;
  /** revealed plaintext for an inline secret, or null while hidden */
  getSecret?: (cipher: string) => string | null;
  onSecretClick?: (cipher: string) => void;
  /** batch reveal (table columns) */
  onRevealMany?: (ciphers: string[]) => void;
  /** encrypt new plaintext cells in an encrypted column (tableFrom, colIndex) */
  onEncryptPending?: (tableFrom: number, colIndex: number) => void;
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
export const INLINE_SECRET = /`\u{1F512}([A-Za-z0-9+/=]{8,})`/gu;
const CHECKBOX = /^(\s*[-*+] )([jJ]?)\[( |x|X)\] /;
const TRACK_RANGE =
  /<!--\s*cb-track:([0-9A-Z]+):(commitment|decision|risk|assumption)\s*-->([\s\S]*?)<!--\s*\/cb-track:\1\s*-->/gi;

type TrackKind = 'commitment' | 'decision' | 'risk' | 'assumption';

class TrackBadgeWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly kind: TrackKind,
  ) {
    super();
  }
  override eq(other: TrackBadgeWidget) {
    return other.id === this.id && other.kind === this.kind;
  }
  toDOM() {
    const badge = document.createElement('span');
    badge.className = `cm-cb-track-badge ${this.kind}`;
    badge.textContent =
      this.kind === 'commitment'
        ? '✓'
        : this.kind === 'decision'
          ? '◆'
          : this.kind === 'risk'
            ? '▲'
            : '≈';
    badge.title = `Tracked ${this.kind}`;
    badge.dataset.trackId = this.id;
    return badge;
  }
  override ignoreEvent() {
    return true;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
    readonly jira = false,
  ) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos && other.jira === this.jira;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = `cm-cb-checkbox${this.jira ? ' jira' : ''}`;
    if (this.jira) box.title = 'Jira to create or prioritise';
    box.onmousedown = (e) => {
      e.preventDefault();
      const marker = this.jira ? 'j' : '';
      view.dispatch({
        changes: {
          from: this.pos,
          to: this.pos + (this.jira ? 4 : 3),
          insert: `${marker}${this.checked ? '[ ]' : '[x]'}`,
        },
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

interface InlineDecoration {
  from: number;
  to: number;
  deco: Decoration;
  /** Higher values win when two decorations cover the exact same span. */
  priority?: number;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const config = state.facet(livePreviewConfig);
  const cursor = state.selection.main.head;
  const doc = state.doc;
  const tree = syntaxTree(state);
  const viewportFrom = view.visibleRanges[0]?.from ?? 0;
  const viewportTo = view.visibleRanges.at(-1)?.to ?? doc.length;
  const externalLinks = externalLinksInTree(
    tree,
    (from, to) => doc.sliceString(from, to),
    viewportFrom,
    viewportTo,
  );

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
    tree.iterate({
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

  // Folded frontmatter is a block decoration and therefore lives in a
  // StateField (frontmatterFoldField); here we only skip the hidden lines.
  const foldedTo = foldedFrontmatter(state)?.to ?? -1;

  // Emit decorations line by line to keep RangeSetBuilder ordering valid.
  // A line is processed once even when it shows up in several visible
  // ranges: replaced content in the middle of a line (a hidden tracking
  // marker) splits the visible ranges, and processing the line twice would
  // add its inline decorations a second time, out of order.
  for (const line of visibleLines(doc, view.visibleRanges)) {
    if (line.to <= foldedTo) continue;
    {
      const ctx: LineCtx = {
        cursorTouches: cursor >= line.from && cursor <= line.to,
        inCodeBlock: codeLines.has(line.number),
      };
      const inline: InlineDecoration[] = [];

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
        collectInline(
          line.from,
          line.text,
          ctx,
          cursor,
          inline,
          emphasis,
          config.isResolved,
          config.getSecret,
          externalLinks,
        );
      }

      inline.sort(
        (a, b) => a.from - b.from || (b.priority ?? 0) - (a.priority ?? 0) || a.to - b.to,
      );
      let last = line.from;
      for (const d of inline) {
        if (d.from < last) continue; // skip overlaps
        builder.add(d.from, d.to, d.deco);
        if (d.to > last) last = d.to;
      }
    }
  }
  return builder.finish();
}

/** Every document line touched by the given ranges, once each, in order. */
export function visibleLines(doc: Text, ranges: readonly { from: number; to: number }[]): Line[] {
  const out: Line[] = [];
  let lastNumber = 0;
  for (const { from, to } of ranges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number > lastNumber) {
        out.push(line);
        lastNumber = line.number;
      }
      if (line.to + 1 > to) break;
      pos = line.to + 1;
    }
  }
  return out;
}

export function collectInline(
  lineFrom: number,
  text: string,
  ctx: LineCtx,
  cursor: number,
  out: InlineDecoration[],
  emphasis: { from: number; to: number; cls: string; marks: [number, number][] }[],
  isResolved?: (target: string) => boolean | undefined,
  getSecret?: (cipher: string) => string | null,
  externalLinks: readonly ExternalLink[] = [],
): void {
  const lineTo = lineFrom + text.length;

  // inline secret tokens replace their whole code span with a chip. The
  // parser also sees them as InlineCode, whose backtick-hiding decorations
  // would win the overlap filter and leave raw base64 on screen — so token
  // spans are excluded from emphasis/code handling below.
  const tokenSpans: [number, number][] = [];
  if (!ctx.cursorTouches) {
    INLINE_SECRET.lastIndex = 0;
    for (let m = INLINE_SECRET.exec(text); m; m = INLINE_SECRET.exec(text)) {
      const cipher = m[1] as string;
      const from = lineFrom + m.index;
      const to = from + m[0].length;
      tokenSpans.push([from, to]);
      out.push({
        from,
        to,
        deco: Decoration.replace({
          widget: new SecretWidget(cipher, getSecret?.(cipher) ?? null),
        }),
      });
    }
  }

  // emphasis / inline code within this line
  for (const e of emphasis) {
    if (e.from < lineFrom || e.to > lineTo) continue;
    if (tokenSpans.some(([f, t]) => e.from >= f && e.to <= t)) continue; // secret token owns this span
    const cursorIn = cursor >= e.from && cursor <= e.to;
    out.push({ from: e.from, to: e.to, deco: Decoration.mark({ class: e.cls }) });
    if (!cursorIn)
      for (const [mf, mt] of e.marks) out.push({ from: mf, to: mt, deco: Decoration.replace({}) });
  }

  // checkbox
  const cb = CHECKBOX.exec(text);
  if (cb) {
    const prefix = (cb[1] as string).length;
    const jira = (cb[2] as string).length > 0; // `- j[ ]`: a jira to create
    const boxFrom = lineFrom + prefix;
    const boxTo = boxFrom + (jira ? 4 : 3); // covers "j[ ]" or "[ ]"
    if (!ctx.cursorTouches) {
      out.push({
        from: boxFrom,
        to: boxTo,
        deco: Decoration.replace({
          widget: new CheckboxWidget(cb[3] !== ' ', boxFrom, jira),
        }),
      });
      if (cb[3] !== ' ') {
        out.push({
          from: boxTo + 1,
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
      out.push({ from, to, deco: Decoration.mark({ attributes: attrs }), priority: 2 });
      continue;
    }
    // hide `[[` + (target| when aliased) … `]]`
    const openEnd =
      from + 2 + (alias !== undefined ? (m[2] as string).length + (m[3]?.length ?? 0) + 1 : 0);
    out.push({ from, to: openEnd, deco: Decoration.replace({}), priority: 2 });
    out.push({
      from: openEnd,
      to: to - 2,
      deco: Decoration.mark({ attributes: attrs }),
      priority: 2,
    });
    out.push({ from: to - 2, to, deco: Decoration.replace({}), priority: 2 });
    void target;
  }

  // Standard Markdown links, autolinks, and GFM bare URLs. Markdown syntax is
  // revealed on the active line; elsewhere `[label](url)` collapses to label.
  for (const link of externalLinks) {
    if (link.from < lineFrom || link.to > lineTo) continue;
    const attrs = {
      class: 'cm-cb-external-link',
      'data-href': link.href,
      title: link.href,
    };
    const cursorIn = cursor >= link.from && cursor <= link.to;
    if (cursorIn || ctx.cursorTouches || link.labelFrom >= link.labelTo) {
      out.push({
        from: link.from,
        to: link.to,
        deco: Decoration.mark({ attributes: attrs }),
        priority: 1,
      });
      continue;
    }
    if (link.from < link.labelFrom) {
      out.push({ from: link.from, to: link.labelFrom, deco: Decoration.replace({}), priority: 1 });
    }
    out.push({
      from: link.labelFrom,
      to: link.labelTo,
      deco: Decoration.mark({ attributes: attrs }),
      priority: 1,
    });
    if (link.labelTo < link.to) {
      out.push({ from: link.labelTo, to: link.to, deco: Decoration.replace({}), priority: 1 });
    }
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

function buildTrackDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  TRACK_RANGE.lastIndex = 0;
  for (let match = TRACK_RANGE.exec(text); match; match = TRACK_RANGE.exec(text)) {
    const whole = match[0];
    const id = match[1];
    const kind = match[2] as TrackKind | undefined;
    if (!whole || !id || !kind) continue;
    const openTo = match.index + whole.indexOf('-->') + 3;
    const closeFrom = match.index + whole.lastIndexOf('<!--');
    const to = match.index + whole.length;
    builder.add(
      match.index,
      openTo,
      Decoration.replace({ widget: new TrackBadgeWidget(id, kind) }),
    );
    if (openTo < closeFrom) {
      builder.add(
        openTo,
        closeFrom,
        Decoration.mark({
          class: `cm-cb-tracked ${kind}`,
          attributes: { 'data-track-id': id },
        }),
      );
    }
    builder.add(closeFrom, to, Decoration.replace({}));
  }
  return builder.finish();
}

const trackField = StateField.define<DecorationSet>({
  create: buildTrackDecorations,
  update(value, transaction) {
    return transaction.docChanged
      ? buildTrackDecorations(transaction.state)
      : value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildTrackAtomicRanges(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  TRACK_RANGE.lastIndex = 0;
  for (let match = TRACK_RANGE.exec(text); match; match = TRACK_RANGE.exec(text)) {
    const whole = match[0];
    if (!whole) continue;
    const openTo = match.index + whole.indexOf('-->') + 3;
    const closeFrom = match.index + whole.lastIndexOf('<!--');
    const to = match.index + whole.length;
    builder.add(match.index, openTo, Decoration.mark({}));
    builder.add(closeFrom, to, Decoration.mark({}));
  }
  return builder.finish();
}

const trackAtomicField = StateField.define<DecorationSet>({
  create: buildTrackAtomicRanges,
  update(value, transaction) {
    return transaction.docChanged
      ? buildTrackAtomicRanges(transaction.state)
      : value.map(transaction.changes);
  },
  provide: (field) => EditorView.atomicRanges.of((view) => view.state.field(field)),
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
  const eventTarget = event.target as HTMLElement;
  const external = eventTarget.closest('.cm-cb-external-link');
  if (external) {
    const href = external.getAttribute('data-href');
    if (!href) return false;
    event.preventDefault();
    view.state.facet(livePreviewConfig).onOpenExternal?.(href);
    return true;
  }

  const wiki = eventTarget.closest('.cm-cb-wikilink');
  if (!wiki) return false;
  const target = wiki.getAttribute('data-target');
  if (!target || target === 'SELF') return false;
  event.preventDefault();
  view.state.facet(livePreviewConfig).onNavigate(target);
  return true;
};

/** The frontmatter block's range, or null when the note has none. */
export function frontmatterRange(doc: Text): { from: number; to: number } | null {
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return null;
  for (let i = 2; i <= Math.min(doc.lines, 100); i++) {
    const t = doc.line(i).text.trim();
    if (t === '---' || t === '...') return { from: 0, to: doc.line(i).to };
  }
  return null;
}

/** The range to hide: folding is on, a block exists, and the cursor is not in it. */
function foldedFrontmatter(state: EditorState): { from: number; to: number } | null {
  if (!state.facet(livePreviewConfig).foldFrontmatter?.()) return null;
  const r = frontmatterRange(state.doc);
  if (!r) return null;
  const c = state.selection.main.head;
  return c >= r.from && c <= r.to ? null : r;
}

function buildFrontmatterFold(state: EditorState): DecorationSet {
  const r = foldedFrontmatter(state);
  if (!r) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  b.add(r.from, r.to, Decoration.replace({ block: true }));
  return b.finish();
}

// Block decorations must come from a state field, not a view plugin.
const frontmatterFoldField = StateField.define<DecorationSet>({
  create: buildFrontmatterFold,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(linksUpdated)))
      return buildFrontmatterFold(tr.state);
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function livePreview(config: LivePreviewConfig): Extension {
  return [
    livePreviewConfig.of(config),
    frontmatterFoldField,
    plugin,
    trackField,
    trackAtomicField,
    secretField,
    tablesField,
    // mousedown so the editor does not move the cursor first
    ViewPlugin.define(() => ({}), {
      eventHandlers: { mousedown: (e, view) => clickHandler(view, e) },
    }),
  ];
}
