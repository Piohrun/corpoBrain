/**
 * Frontmatter handling per docs/SPEC.md §4.
 *
 * Reading: YAML 1.2 core schema (dates stay strings).
 * Writing: line-level patching of the frontmatter block so that every byte
 * outside the touched key is preserved (quoting, comments, order, EOL style).
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type Eol = '\n' | '\r\n';

export interface FrontmatterSplit {
  /** true when a well-formed `---` block exists at the top of the file */
  present: boolean;
  /** raw YAML text between the delimiters, without the delimiter lines */
  raw: string;
  /** byte offset where the Markdown body starts (0 if no frontmatter) */
  bodyOffset: number;
  /** line index (0-based) of the body's first line */
  bodyLine: number;
  eol: Eol;
}

export interface ParsedFrontmatter extends FrontmatterSplit {
  data: Record<string, unknown>;
  error: string | null;
}

export function detectEol(text: string): Eol {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(---|\.\.\.)[ \t]*$/;

/** Split a note into frontmatter + body without interpreting the YAML. */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const eol = detectEol(text);
  const none: FrontmatterSplit = { present: false, raw: '', bodyOffset: 0, bodyLine: 0, eol };
  // Tolerate a UTF-8 BOM.
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstEol = text.indexOf('\n', start);
  const firstLine = (firstEol === -1 ? text.slice(start) : text.slice(start, firstEol)).replace(
    /\r$/,
    '',
  );
  if (!OPEN.test(firstLine) || firstEol === -1) return none;

  let pos = firstEol + 1;
  let line = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const rawLine = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    const content = rawLine.replace(/\r$/, '');
    if (CLOSE.test(content)) {
      const bodyOffset = nl === -1 ? text.length : nl + 1;
      return {
        present: true,
        raw: text.slice(firstEol + 1, pos),
        bodyOffset,
        bodyLine: line + 1,
        eol,
      };
    }
    if (nl === -1) break;
    pos = nl + 1;
    line++;
  }
  return none; // unterminated → treated as body text
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const split = splitFrontmatter(text);
  if (!split.present) return { ...split, data: {}, error: null };
  try {
    const value: unknown = parseYaml(split.raw, { schema: 'core', uniqueKeys: false });
    if (value === null || value === undefined) return { ...split, data: {}, error: null };
    if (typeof value !== 'object' || Array.isArray(value)) {
      return { ...split, data: {}, error: 'frontmatter is not a mapping' };
    }
    return { ...split, data: value as Record<string, unknown>, error: null };
  } catch (e) {
    return { ...split, data: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Line-level patching
// ---------------------------------------------------------------------------

const KEY_LINE = /^(?:"([^"]*)"|'([^']*)'|([^\s#'"][^:]*?))\s*:(?:\s|$)/;

function keyOfLine(line: string): string | null {
  const m = KEY_LINE.exec(line);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

interface KeyRange {
  key: string;
  start: number; // inclusive line index within raw block
  end: number; // exclusive
}

/** Locate top-level keys and the line ranges they own. */
function keyRanges(rawLines: string[]): KeyRange[] {
  const ranges: KeyRange[] = [];
  let current: KeyRange | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] as string;
    const isTop =
      line.length > 0 && !/^\s/.test(line) && !line.startsWith('#') && !line.startsWith('- ');
    const key = isTop ? keyOfLine(line) : null;
    if (key !== null) {
      if (current) current.end = i;
      current = { key, start: i, end: i + 1 };
      ranges.push(current);
    } else if (current && !line.startsWith('#') && line.trim() !== '') {
      current.end = i + 1; // continuation (indented, or top-level `- item`)
    } else if (current && line.trim() === '') {
      // blank line: belongs to current key only if followed by a continuation
      let j = i + 1;
      while (j < rawLines.length && (rawLines[j] as string).trim() === '') j++;
      const next = rawLines[j];
      if (next !== undefined && /^\s/.test(next)) current.end = i + 1;
    }
  }
  return ranges;
}

function renderKey(key: string, value: unknown): string {
  const out = stringifyYaml({ [key]: value }, { lineWidth: 0, schema: 'core' });
  return out.replace(/\n$/, '');
}

function rebuild(text: string, split: FrontmatterSplit, rawLines: string[]): string {
  const eol = split.eol;
  const head = `---${eol}`;
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const block = rawLines.length ? rawLines.join(eol) + eol : '';
  return `${bom}${head}${block}---${eol}${text.slice(split.bodyOffset)}`;
}

function rawToLines(raw: string, eol: Eol): string[] {
  if (raw === '') return [];
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  // eol is applied on rebuild
  void eol;
}

/**
 * Set a top-level frontmatter key, creating the block if needed.
 * `position: 'start'` inserts new keys first (used for `id`), otherwise last.
 */
export function setFrontmatterKey(
  text: string,
  key: string,
  value: unknown,
  opts: { position?: 'start' | 'end' } = {},
): string {
  const split = splitFrontmatter(text);
  const rendered = renderKey(key, value).split('\n');
  if (!split.present) {
    const eol = split.eol;
    const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const body = bom ? text.slice(1) : text;
    return `${bom}---${eol}${rendered.join(eol)}${eol}---${eol}${body}`;
  }
  const lines = rawToLines(split.raw, split.eol);
  const ranges = keyRanges(lines);
  const existing = ranges.find((r) => r.key === key);
  if (existing) {
    lines.splice(existing.start, existing.end - existing.start, ...rendered);
  } else if (opts.position === 'start') {
    lines.unshift(...rendered);
  } else {
    lines.push(...rendered);
  }
  return rebuild(text, split, lines);
}

export function deleteFrontmatterKey(text: string, key: string): string {
  const split = splitFrontmatter(text);
  if (!split.present) return text;
  const lines = rawToLines(split.raw, split.eol);
  const existing = keyRanges(lines).find((r) => r.key === key);
  if (!existing) return text;
  lines.splice(existing.start, existing.end - existing.start);
  return rebuild(text, split, lines);
}

/** Convenience: apply several key updates (undefined deletes). */
export function patchFrontmatter(text: string, patch: Record<string, unknown>): string {
  let out = text;
  for (const [k, v] of Object.entries(patch)) {
    out = v === undefined ? deleteFrontmatterKey(out, k) : setFrontmatterKey(out, k, v);
  }
  return out;
}
