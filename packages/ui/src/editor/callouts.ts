/**
 * Callouts, as in Obsidian: a blockquote whose first line is
 * `> [!type] Optional title` renders as a coloured box. `[!type]-` is
 * foldable and folded, `[!type]+` foldable and open; the chevron flips the
 * marker in the file, so the state is saved with the note.
 */
import { type EditorState, RangeSetBuilder, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export const CALLOUT = /^(\s*>\s*)\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;
/** the `> ` in front of a callout's body lines */
export const QUOTE_PREFIX = /^\s*>[ \t]?/;

type Color = 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'gray';
const KINDS: Record<string, { color: Color; icon: string; aliases?: string[] }> = {
  note: { color: 'blue', icon: '✎' },
  info: { color: 'blue', icon: 'ℹ' },
  todo: { color: 'blue', icon: '☐' },
  abstract: { color: 'teal', icon: '≡', aliases: ['summary', 'tldr'] },
  tip: { color: 'teal', icon: '✦', aliases: ['hint', 'important'] },
  success: { color: 'green', icon: '✓', aliases: ['check', 'done'] },
  question: { color: 'yellow', icon: '?', aliases: ['help', 'faq'] },
  warning: { color: 'orange', icon: '⚠', aliases: ['caution', 'attention'] },
  risk: { color: 'orange', icon: '▲' },
  failure: { color: 'red', icon: '✕', aliases: ['fail', 'missing'] },
  danger: { color: 'red', icon: '⚡', aliases: ['error'] },
  bug: { color: 'red', icon: '✱' },
  example: { color: 'purple', icon: '◇' },
  decision: { color: 'purple', icon: '◆' },
  quote: { color: 'gray', icon: '❝', aliases: ['cite'] },
};
/** the types offered when turning a selection into a callout, in menu order */
export const CALLOUT_CHOICES = [
  'note',
  'info',
  'tip',
  'success',
  'question',
  'warning',
  'risk',
  'decision',
  'danger',
  'example',
  'quote',
] as const;

/** Lines → a callout of `type` (each line quoted; empty lines kept inside). */
export function toCallout(text: string, type: string): string {
  const body = text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'));
  return [`> [!${type}]`, ...body].join('\n');
}

/** Wrap each non-empty line's text in `==` (a highlight cannot cross lines). */
export function toHighlight(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const m = /^(\s*)(.*?)(\s*)$/.exec(l) as RegExpExecArray;
      return m[2] ? `${m[1]}==${m[2]}==${m[3]}` : l;
    })
    .join('\n');
}

const BY_NAME = new Map<string, { color: Color; icon: string }>();
for (const [name, k] of Object.entries(KINDS)) {
  BY_NAME.set(name, k);
  for (const a of k.aliases ?? []) BY_NAME.set(a, k);
}

/** A callout type's look; unknown types are notes (as in Obsidian). */
export function calloutStyle(type: string): { color: Color; icon: string } {
  return BY_NAME.get(type.toLowerCase()) ?? (KINDS.note as { color: Color; icon: string });
}

export interface Callout {
  /** line numbers, 1-based, inclusive */
  first: number;
  last: number;
  type: string;
  fold: '' | '+' | '-';
  title: string;
  /** document offset of the fold marker character (or where it would go) */
  foldAt: number;
  /** end of `> [!type]-<spaces>` on the title line */
  headEnd: number;
}

/**
 * Callouts in the document, by scanning lines (independent of the parser,
 * which may not have reached the end of a long note yet). A callout runs
 * while lines keep starting with `>`; fenced code is skipped.
 */
export function findCallouts(doc: Text, fromLine = 1, toLine = doc.lines): Callout[] {
  const out: Callout[] = [];
  let inFence = false;
  for (let n = 1; n <= Math.min(doc.lines, toLine); n++) {
    const text = doc.line(n).text;
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
    if (inFence) continue;
    const m = CALLOUT.exec(text);
    if (!m) continue;
    let last = n;
    while (last + 1 <= doc.lines && /^\s*>/.test(doc.line(last + 1).text)) last++;
    if (last >= fromLine) {
      const line = doc.line(n);
      const lead = (m[1] as string).length;
      const markerEnd = lead + 3 + (m[2] as string).length; // `[!` + type + `]`
      out.push({
        first: n,
        last,
        type: (m[2] as string).toLowerCase(),
        fold: m[3] as '' | '+' | '-',
        title: (m[4] as string).trim(),
        foldAt: line.from + markerEnd,
        headEnd: line.from + text.length - (m[4] as string).length,
      });
    }
    n = last;
  }
  return out;
}

const label = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

/** The icon, default title and fold chevron that replace `> [!type]-`. */
export class CalloutHeadWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly fold: '' | '+' | '-',
    readonly foldAt: number,
    readonly hasTitle: boolean,
  ) {
    super();
  }

  eq(o: CalloutHeadWidget): boolean {
    return (
      o.type === this.type &&
      o.fold === this.fold &&
      o.foldAt === this.foldAt &&
      o.hasTitle === this.hasTitle
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const head = document.createElement('span');
    head.className = 'cm-cb-callout-head';
    if (this.fold) {
      const chevron = document.createElement('span');
      chevron.className = 'cm-cb-callout-fold';
      chevron.textContent = this.fold === '-' ? '▸' : '▾';
      chevron.title = this.fold === '-' ? 'Unfold' : 'Fold';
      chevron.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({
          changes: {
            from: this.foldAt,
            to: this.foldAt + 1,
            insert: this.fold === '-' ? '+' : '-',
          },
        });
      });
      head.appendChild(chevron);
    }
    const icon = document.createElement('span');
    icon.className = 'cm-cb-callout-icon';
    icon.textContent = calloutStyle(this.type).icon;
    head.appendChild(icon);
    if (!this.hasTitle) {
      const title = document.createElement('span');
      title.className = 'cm-cb-callout-title-text';
      title.textContent = label(this.type);
      head.appendChild(title);
    }
    return head;
  }

  ignoreEvent(e: Event): boolean {
    // the chevron handles its own clicks; anything else places the cursor
    return (e.target as HTMLElement | null)?.classList?.contains('cm-cb-callout-fold') ?? false;
  }
}

/** The body of a folded callout, while the cursor is not inside it. */
function buildFolds(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const head = state.selection.main.head;
  for (const c of findCallouts(doc)) {
    if (c.fold !== '-' || c.last === c.first) continue;
    const from = doc.line(c.first + 1).from;
    const to = doc.line(c.last).to;
    if (head >= from && head <= to) continue; // editing inside: show it
    builder.add(doc.line(c.first).to, to, Decoration.replace({ block: false }));
  }
  return builder.finish();
}

export const calloutFoldField = StateField.define<DecorationSet>({
  create: buildFolds,
  update(value, tr) {
    return tr.docChanged || tr.selection ? buildFolds(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
