/**
 * Markdown body scanner per docs/SPEC.md §3.3 and §5.1.
 *
 * Line-based, fence-aware. Nothing inside fenced code blocks or inline code
 * spans is extracted. Lines/columns are 1-based line, 0-based column.
 */
import { splitFrontmatter } from './frontmatter.ts';

export type LinkKind = 'link' | 'embed' | 'md' | 'mention';

export interface LinkRef {
  kind: LinkKind;
  /** raw target as written (trimmed); empty string for `[[#heading]]` */
  target: string;
  fragment: string | null; // "^blockid" keeps the caret; heading text otherwise
  alias: string | null;
  line: number;
  col: number;
}

export interface TaskRef {
  line: number;
  text: string;
  done: boolean;
  blockId: string | null;
  due: string | null; // YYYY-MM-DD
}

export interface HeadingRef {
  level: number;
  text: string;
  line: number;
}

export interface ScanResult {
  links: LinkRef[];
  tags: string[]; // lowercased, deduped, in order of first appearance
  tasks: TaskRef[];
  headings: HeadingRef[];
  blocks: { blockId: string; line: number }[];
}

export interface ScanOptions {
  /**
   * Project keys for bare Jira mentions (`EXEC-123` → mention link).
   * Empty array disables mention scanning.
   */
  jiraProjectKeys?: string[];
  /**
   * When set, body lines up to and including the first line equal to this
   * marker are skipped (used for the generated region of jira/ files).
   */
  skipUntilMarker?: string;
}

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const WIKILINK = /(!?)\[\[([^[\]|#]*)(?:#([^[\]|]*))?(?:\|([^[\]]*))?\]\]/g;
const MD_LINK = /\[[^\]]*\]\(([^()\s]+?\.md)(?:#[^()\s]*)?\)/g;
const TAG = /(^|[\s(,;])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;
const TASK = /^\s*[-*+] \[( |x|X)\] (.*)$/;
const BLOCK_ID = /\s\^([A-Za-z0-9-]+)\s*$/;
const HEADING = /^(#{1,6}) (.*)$/;
const DUE = /📅\s*(\d{4}-\d{2}-\d{2})|@due\((\d{4}-\d{2}-\d{2})\)/;

/** Replace inline code spans with spaces of equal length so offsets hold. */
export function maskInlineCode(line: string): string {
  return line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => ' '.repeat(m.length));
}

function maskRegions(line: string, regions: [number, number][]): string {
  if (!regions.length) return line;
  let out = line;
  for (const [start, end] of regions) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

export function scanMarkdown(text: string, opts: ScanOptions = {}): ScanResult {
  const split = splitFrontmatter(text);
  const body = text.slice(split.bodyOffset);
  const lines = body.split(/\r?\n/);
  const result: ScanResult = { links: [], tags: [], tasks: [], headings: [], blocks: [] };
  const seenTags = new Set<string>();

  const mentionRe = opts.jiraProjectKeys?.length
    ? new RegExp(`\\b(${opts.jiraProjectKeys.join('|')})-(\\d+)\\b`, 'g')
    : null;

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let skipping = Boolean(opts.skipUntilMarker);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] as string;
    const lineNo = split.bodyLine + i + 1; // 1-based within the whole file

    if (skipping) {
      if (rawLine.trim() === opts.skipUntilMarker) skipping = false;
      continue;
    }

    const fence = FENCE.exec(rawLine);
    if (fence) {
      const marker = fence[2] as string;
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0] as string;
        fenceLen = marker.length;
        continue;
      }
      if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false;
        continue;
      }
    }
    if (inFence) continue;

    const line = maskInlineCode(rawLine);

    const heading = HEADING.exec(line);
    if (heading) {
      result.headings.push({
        level: (heading[1] as string).length,
        text: (heading[2] as string).replace(BLOCK_ID, '').trim(),
        line: lineNo,
      });
    }

    const blockId = BLOCK_ID.exec(line);
    if (blockId) result.blocks.push({ blockId: blockId[1] as string, line: lineNo });

    // Wikilinks + embeds. Record their spans to exclude from later passes.
    const wikiSpans: [number, number][] = [];
    WIKILINK.lastIndex = 0;
    for (let m = WIKILINK.exec(line); m; m = WIKILINK.exec(line)) {
      wikiSpans.push([m.index, m.index + m[0].length]);
      const target = (m[2] as string).trim();
      const fragment = m[3] !== undefined ? (m[3] as string).trim() : null;
      if (!target && !fragment) continue; // [[]] is not a link
      result.links.push({
        kind: m[1] ? 'embed' : 'link',
        target,
        fragment,
        alias: m[4] !== undefined ? (m[4] as string).trim() : null,
        line: lineNo,
        col: m.index,
      });
    }
    const masked = maskRegions(line, wikiSpans);

    MD_LINK.lastIndex = 0;
    for (let m = MD_LINK.exec(masked); m; m = MD_LINK.exec(masked)) {
      const href = m[1] as string;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // absolute URL
      result.links.push({
        kind: 'md',
        target: decodeURIComponent(href.replace(/\.md$/, '')),
        fragment: null,
        alias: null,
        line: lineNo,
        col: m.index,
      });
    }

    if (mentionRe) {
      mentionRe.lastIndex = 0;
      for (let m = mentionRe.exec(masked); m; m = mentionRe.exec(masked)) {
        result.links.push({
          kind: 'mention',
          target: m[0],
          fragment: null,
          alias: null,
          line: lineNo,
          col: m.index,
        });
      }
    }

    TAG.lastIndex = 0;
    for (let m = TAG.exec(masked); m; m = TAG.exec(masked)) {
      // Note: an ATX heading marker (`# `) cannot match TAG since the tag
      // must directly follow `#` with no space, so headings are safe here.
      const tag = (m[2] as string).toLowerCase().replace(/\/+$/, '');
      if (tag && !seenTags.has(tag)) {
        seenTags.add(tag);
        result.tags.push(tag);
      }
    }

    const task = TASK.exec(line);
    if (task) {
      const rawText = task[2] as string;
      const due = DUE.exec(rawText);
      result.tasks.push({
        line: lineNo,
        text: rawText.replace(BLOCK_ID, '').replace(DUE, '').replace(/\s+/g, ' ').trim(),
        done: task[1] !== ' ',
        blockId: blockId ? (blockId[1] as string) : null,
        due: due ? ((due[1] ?? due[2]) as string) : null,
      });
    }
  }
  return result;
}
