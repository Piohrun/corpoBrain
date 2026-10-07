/**
 * ```mermaid fences render as diagrams in live preview (flowcharts, org
 * charts, sequences, timelines, Gantt…). The library is loaded only when a
 * note has a diagram. Mermaid runs in its strict security mode: no
 * scripts, no click handlers, labels sanitized. Clicking a diagram puts the
 * cursor in its source; leaving the block renders it again.
 */
import { type EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface DiagramBlock {
  from: number;
  to: number;
  /** start of the first source line (where a click puts the cursor) */
  bodyFrom: number;
  source: string;
}

/** ```mermaid … ``` fences (also ~~~), outside other fences. */
export function findDiagrams(state: EditorState): DiagramBlock[] {
  const out: DiagramBlock[] = [];
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const open = /^\s*(```+|~~~+)\s*(\S*)/.exec(doc.line(n).text);
    if (!open) continue;
    const fence = (open[1] as string).slice(0, 3);
    let close = n + 1;
    while (close <= doc.lines && !doc.line(close).text.trimStart().startsWith(fence)) close++;
    if (close > doc.lines) break; // unclosed: nothing after it is a diagram
    if ((open[2] as string).toLowerCase() === 'mermaid' && close > n + 1)
      out.push({
        from: doc.line(n).from,
        to: doc.line(close).to,
        bodyFrom: doc.line(n + 1).from,
        source: doc.sliceString(doc.line(n + 1).from, doc.line(close - 1).to),
      });
    n = close;
  }
  return out;
}

const isDark = (): boolean => {
  if (typeof document === 'undefined') return false; // editor state built outside a page (tests)
  const set = document.documentElement.dataset.theme;
  if (set === 'dark' || set === 'light') return set === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

type Mermaid = typeof import('mermaid').default;
let loading: Promise<Mermaid> | null = null;
let theme: string | null = null;
const loadMermaid = (dark: boolean): Promise<Mermaid> => {
  loading ??= import('mermaid').then((m) => m.default);
  return loading.then((mermaid) => {
    const want = dark ? 'dark' : 'default';
    if (theme !== want) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: want,
        fontFamily: 'inherit',
      });
      theme = want;
    }
    return mermaid;
  });
};

/** rendered SVG by theme + source: re-rendering on every edit elsewhere would flicker */
const rendered = new Map<string, Promise<string>>();
let seq = 0;
function render(source: string, dark: boolean): Promise<string> {
  const key = `${dark ? 'd' : 'l'}\u0000${source}`;
  let hit = rendered.get(key);
  if (!hit) {
    hit = loadMermaid(dark).then(async (mermaid) => {
      const { svg } = await mermaid.render(`cb-diagram-${++seq}`, source);
      return svg;
    });
    hit.catch(() => rendered.delete(key)); // a fixed typo renders next time
    if (rendered.size > 50) rendered.delete(rendered.keys().next().value as string);
    rendered.set(key, hit);
  }
  return hit;
}

class DiagramWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly dark: boolean,
  ) {
    super();
  }

  eq(o: DiagramWidget): boolean {
    return o.source === this.source && o.dark === this.dark;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cm-cb-diagram';
    box.title = 'Click to edit the diagram';
    box.textContent = 'drawing diagram…';
    box.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // into the source: its first line, just after the opening fence
      const at = view.posAtDOM(box);
      const line = view.state.doc.lineAt(at);
      const next = Math.min(line.to + 1, view.state.doc.length);
      view.dispatch({ selection: { anchor: next } });
      view.focus();
    });
    render(this.source, this.dark).then(
      (svg) => {
        // mermaid's strict mode output (DOMPurify-sanitized SVG)
        box.innerHTML = svg;
        box.classList.remove('error');
        view.requestMeasure();
      },
      (e: unknown) => {
        box.classList.add('error');
        box.textContent = '';
        const msg = document.createElement('div');
        msg.className = 'cm-cb-diagram-error';
        msg.textContent = `diagram error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
        const code = document.createElement('pre');
        code.textContent = this.source;
        box.append(msg, code);
        view.requestMeasure();
      },
    );
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const head = state.selection.main.head;
  const dark = isDark();
  for (const d of findDiagrams(state)) {
    if (head >= d.from && head <= d.to) continue; // editing the source
    builder.add(
      d.from,
      d.to,
      Decoration.replace({ widget: new DiagramWidget(d.source, dark), block: true }),
    );
  }
  return builder.finish();
}

export const diagramsField = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    return tr.docChanged || tr.selection ? build(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
