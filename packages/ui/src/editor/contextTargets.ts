/**
 * What is under the cursor, for the context menu, and the line/table edits its
 * actions make. Pure functions over strings so they are easy to test.
 */
import { splitCells } from './tables.ts';

export type LinkAt =
  | { kind: 'note'; target: string }
  | { kind: 'jira'; key: string }
  | { kind: 'url'; url: string };

const WIKILINK = /!?\[\[([^[\]|#]*)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const URL = /\bhttps?:\/\/[^\s<>()[\]]+/g;
const JIRA = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

/** The link covering column `col` (0-based) of a line, if any. */
export function linkAt(line: string, col: number): LinkAt | null {
  const hit = (re: RegExp) => {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line))
      if (col >= m.index && col <= m.index + m[0].length) return m;
    return null;
  };
  const wiki = hit(WIKILINK);
  if (wiki) {
    const target = (wiki[1] ?? '').trim();
    if (!target) return null;
    return /^[A-Z][A-Z0-9_]+-\d+$/.test(target)
      ? { kind: 'jira', key: target }
      : { kind: 'note', target };
  }
  const md = hit(MD_LINK);
  if (md) {
    const href = md[1] as string;
    return /^[a-z][a-z0-9+.-]*:/i.test(href)
      ? { kind: 'url', url: href }
      : { kind: 'note', target: decodeURIComponent(href).replace(/\.md$/i, '') };
  }
  const url = hit(URL);
  if (url) return { kind: 'url', url: url[0].replace(/[.,;:!?]+$/, '') };
  const jira = hit(JIRA);
  if (jira) return { kind: 'jira', key: jira[0] };
  return null;
}

// ---------------------------------------------------------------- tasks

const TASK = /^(\s*[-*+]\s+)(j?)\[([ xXj])\](.*)$/;

export interface TaskLine {
  done: boolean;
  jira: boolean;
}

export function taskLine(line: string): TaskLine | null {
  const m = TASK.exec(line);
  if (!m) return null;
  const mark = m[3] as string;
  return { done: mark.toLowerCase() === 'x', jira: m[2] === 'j' || mark === 'j' };
}

/** `[ ]` ↔ `[x]`, keeping the Jira marker (`[j]` shorthand becomes `j[x]`). */
export function toggleTask(line: string): string {
  const m = TASK.exec(line);
  if (!m) return line;
  const [, lead, j, mark, rest] = m as unknown as [string, string, string, string, string];
  if (mark === 'j') return `${lead}j[x]${rest}`;
  const done = mark.toLowerCase() === 'x';
  return `${lead}${j}[${done ? ' ' : 'x'}]${rest}`;
}

/** A personal task ↔ a Jira item to create or prioritise. */
export function toggleTaskKind(line: string): string {
  const m = TASK.exec(line);
  if (!m) return line;
  const [, lead, j, mark, rest] = m as unknown as [string, string, string, string, string];
  if (mark === 'j') return `${lead}[ ]${rest}`;
  return `${lead}${j ? '' : 'j'}[${mark}]${rest}`;
}

/** Set (or replace) the `📅 YYYY-MM-DD` due date; null removes it. */
export function setTaskDue(line: string, date: string | null): string {
  const cleaned = line
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\s*@due\(\d{4}-\d{2}-\d{2}\)/g, '');
  if (!date) return cleaned;
  // keep a trailing block id last
  const block = /(\s\^[A-Za-z0-9-]+)\s*$/.exec(cleaned);
  return block
    ? `${cleaned.slice(0, block.index)} 📅 ${date}${block[1]}`
    : `${cleaned.replace(/\s+$/, '')} 📅 ${date}`;
}

/** Turn plain lines into open tasks; list items keep their bullet. */
export function linesToTasks(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      if (!l.trim() || TASK.test(l)) return l;
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(l);
      if (bullet) return `${bullet[1]}- [ ] ${bullet[2]}`;
      const indent = /^\s*/.exec(l)?.[0] ?? '';
      return `${indent}- [ ] ${l.trim()}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------- tables

/**
 * Where a cursor sits in a table: `row` is the data row index (-1 header,
 * -2 the separator line), `col` the cell index.
 */
export function tableCellAt(
  lines: string[],
  lineIndex: number,
  col: number,
): { row: number; col: number } {
  const line = lines[lineIndex] ?? '';
  let pipes = 0;
  for (let i = 0; i < Math.min(col, line.length); i++)
    if (line[i] === '|' && line[i - 1] !== '\\') pipes++;
  const leading = line.trimStart().startsWith('|') ? 1 : 0;
  const cells = splitCells(line).length;
  return {
    row: lineIndex === 0 ? -1 : lineIndex === 1 ? -2 : lineIndex - 2,
    col: Math.max(0, Math.min(cells - 1, pipes - leading)),
  };
}

const row = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;

export function insertRow(lines: string[], afterDataRow: number): string[] {
  const n = splitCells(lines[0] ?? '').length;
  const at = Math.max(2, afterDataRow + 3); // after the header+separator, below the row
  return [...lines.slice(0, at), row(Array.from({ length: n }, () => '')), ...lines.slice(at)];
}

export function deleteRow(lines: string[], dataRow: number): string[] {
  if (dataRow < 0) return lines;
  return lines.filter((_, i) => i !== dataRow + 2);
}

export function insertColumn(lines: string[], afterCol: number): string[] {
  return lines.map((l, i) => {
    const cells = splitCells(l);
    cells.splice(afterCol + 1, 0, i === 1 ? '---' : '');
    return row(cells);
  });
}

export function deleteColumn(lines: string[], col: number): string[] {
  if (splitCells(lines[0] ?? '').length <= 1) return lines;
  return lines.map((l) => {
    const cells = splitCells(l);
    cells.splice(col, 1);
    return row(cells);
  });
}
