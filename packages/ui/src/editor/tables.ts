/**
 * Live-preview rendering for GFM tables: a StateField block widget replaces
 * the raw pipes with a real <table> while the cursor is outside. Cells
 * render wikilinks, inline secrets, bold and code; columns containing
 * secrets get a reveal-all button in the header.
 */
import { type EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { INLINE_SECRET, linksUpdated, livePreviewConfig } from './livePreview.ts';

interface TableBlock {
  from: number;
  to: number;
  lines: string[];
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function findTables(state: EditorState): TableBlock[] {
  const out: TableBlock[] = [];
  const doc = state.doc;
  let inFence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const t = line.text;
    if (t.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!t.trimStart().startsWith('|')) continue;
    const sep = n + 1 <= doc.lines ? doc.line(n + 1).text : '';
    if (!sep.includes('-') || !SEPARATOR.test(sep)) continue;
    // extend while rows keep starting with |
    let last = n + 1;
    while (
      last + 1 <= doc.lines &&
      doc
        .line(last + 1)
        .text.trimStart()
        .startsWith('|')
    )
      last++;
    const lines: string[] = [];
    for (let m = n; m <= last; m++) lines.push(doc.line(m).text);
    out.push({ from: line.from, to: doc.line(last).to, lines });
    n = last;
  }
  return out;
}

export function splitCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function alignments(sep: string): ('left' | 'center' | 'right')[] {
  return splitCells(sep).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    return 'left';
  });
}

/** extract the base64 cipher from a whole token — the lock char is a
 *  surrogate pair, so naive slicing corrupts the payload */
export function tokenCipher(wholeToken: string): string | null {
  INLINE_SECRET.lastIndex = 0;
  const m = INLINE_SECRET.exec(wholeToken);
  return m ? (m[1] as string) : null;
}

/** cell text → DOM with wikilinks, secrets, bold, code */
function renderCell(cell: string, td: HTMLElement, view: EditorView): void {
  const config = view.state.facet(livePreviewConfig);
  const pattern = /(`\u{1F512}[A-Za-z0-9+/=]{8,}`)|(`[^`]+`)|(\[\[[^[\]]+\]\])|(\*\*[^*]+\*\*)/gu;
  let last = 0;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(cell); m; m = pattern.exec(cell)) {
    if (m.index > last) td.appendChild(document.createTextNode(cell.slice(last, m.index)));
    const [whole, secret, code, wiki, bold] = m;
    if (secret) {
      const cipher = tokenCipher(whole);
      if (cipher === null) {
        td.appendChild(document.createTextNode(whole));
        last = m.index + whole.length;
        continue;
      }
      const revealedText = config.getSecret?.(cipher) ?? null;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `cm-secret cell-secret${revealedText !== null ? ' revealed' : ''}`;
      chip.textContent = revealedText !== null ? revealedText : '\u{1F512}';
      chip.title = revealedText !== null ? 'click to hide' : 'click to reveal';
      chip.onmousedown = (e) => {
        e.preventDefault();
        config.onSecretClick?.(cipher);
      };
      td.appendChild(chip);
    } else if (code) {
      const el = document.createElement('code');
      el.className = 'cm-cb-code';
      el.textContent = code.slice(1, -1);
      td.appendChild(el);
    } else if (wiki) {
      const inner = wiki.slice(2, -2);
      const [targetPart, alias] = inner.split('|');
      const target = (targetPart ?? '').split('#')[0]?.trim() ?? '';
      const link = document.createElement('button');
      link.type = 'button';
      const unresolved = target !== '' && config.isResolved?.(target) !== true;
      link.className = `cm-cb-wikilink${unresolved ? ' unresolved' : ''}`;
      link.textContent = (alias ?? targetPart ?? '').trim();
      link.onmousedown = (e) => {
        e.preventDefault();
        if (target) config.onNavigate(target);
      };
      td.appendChild(link);
    } else if (bold) {
      const el = document.createElement('b');
      el.textContent = bold.slice(2, -2);
      td.appendChild(el);
    }
    last = m.index + whole.length;
  }
  if (last < cell.length) td.appendChild(document.createTextNode(cell.slice(last)));
}

function ciphersInColumn(rows: string[][], col: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const cell = row[col] ?? '';
    INLINE_SECRET.lastIndex = 0;
    for (let m = INLINE_SECRET.exec(cell); m; m = INLINE_SECRET.exec(cell)) {
      out.push(m[1] as string);
    }
  }
  return out;
}

export type EncryptTarget = { kind: 'column'; index: number } | { kind: 'row'; rowIndex: number };

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|');
}

function isWholeToken(cell: string): boolean {
  INLINE_SECRET.lastIndex = 0;
  const m = INLINE_SECRET.exec(cell.trim());
  return m !== null && m[0] === cell.trim();
}

/**
 * Encrypt every targeted body cell into an inline token. Pure w.r.t. the
 * encryption function; empty cells and cells that are already tokens are
 * left alone. Header and separator rows are never touched.
 */
export async function encryptTableCells(
  lines: string[],
  target: EncryptTarget,
  encrypt: (text: string) => Promise<string>,
): Promise<{ lines: string[]; encrypted: number }> {
  const out = [...lines];
  let encrypted = 0;
  const rowIndexes = target.kind === 'row' ? [target.rowIndex] : lines.slice(2).map((_l, i) => i);
  for (const r of rowIndexes) {
    const lineIdx = r + 2;
    const raw = out[lineIdx];
    if (raw === undefined) continue;
    const cells = splitCells(raw);
    const cellIndexes = target.kind === 'column' ? [target.index] : cells.map((_c, i) => i);
    let changed = false;
    for (const c of cellIndexes) {
      const cell = cells[c];
      if (cell === undefined || cell.trim() === '' || isWholeToken(cell)) continue;
      const data = await encrypt(cell);
      cells[c] = '`\u{1F512}' + data + '`';
      encrypted++;
      changed = true;
    }
    if (changed) out[lineIdx] = `| ${cells.map(escapeCell).join(' | ')} |`;
  }
  return { lines: out, encrypted };
}

class TableWidget extends WidgetType {
  constructor(
    readonly text: string,
    /** signature of revealed state so eq() re-renders on reveal/hide */
    readonly revealSig: string,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.text === this.text && other.revealSig === this.revealSig;
  }
  toDOM(view: EditorView) {
    const config = view.state.facet(livePreviewConfig);
    const lines = this.text.split('\n');
    const header = splitCells(lines[0] ?? '');
    const aligns = alignments(lines[1] ?? '');
    const bodyRows = lines.slice(2).map(splitCells);

    const wrap = document.createElement('div');
    wrap.className = 'cm-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    header.forEach((cell, i) => {
      const th = document.createElement('th');
      th.style.textAlign = aligns[i] ?? 'left';
      renderCell(cell, th, view);
      const ciphers = ciphersInColumn(bodyRows, i);
      if (ciphers.length && config.onRevealMany) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cm-table-reveal';
        btn.textContent = '\u{1F513}';
        btn.title = `Reveal ${ciphers.length} encrypted cell(s) in this column`;
        btn.onmousedown = (e) => {
          e.preventDefault();
          config.onRevealMany?.(ciphers);
        };
        th.appendChild(btn);
      }
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of bodyRows) {
      const tr = document.createElement('tr');
      header.forEach((_h, i) => {
        const td = document.createElement('td');
        td.style.textAlign = aligns[i] ?? 'left';
        renderCell(row[i] ?? '', td, view);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
  override ignoreEvent() {
    return true;
  }
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const config = state.facet(livePreviewConfig);
  const cursor = state.selection.main.head;
  const builder = new RangeSetBuilder<Decoration>();
  for (const block of findTables(state)) {
    if (cursor >= block.from && cursor <= block.to) continue; // raw for editing
    const text = block.lines.join('\n');
    const ciphers: string[] = [];
    INLINE_SECRET.lastIndex = 0;
    for (let m = INLINE_SECRET.exec(text); m; m = INLINE_SECRET.exec(text)) {
      ciphers.push(m[1] as string);
    }
    const sig = ciphers
      .map((c) => (config.getSecret?.(c) !== null && config.getSecret !== undefined ? '1' : '0'))
      .join('');
    builder.add(
      block.from,
      block.to,
      Decoration.replace({ widget: new TableWidget(text, sig), block: true }),
    );
  }
  return builder.finish();
}

export const tablesField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(linksUpdated))) {
      return buildTableDecorations(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
