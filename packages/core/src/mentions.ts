/**
 * Unlinked mentions: places where a note's title (or alias) appears as plain
 * text, so it can be turned into a [[link]]. Whole words, case-insensitive,
 * never inside frontmatter, code fences, inline code, existing wikilinks,
 * markdown link syntax or URLs.
 */
import { splitFrontmatter } from './frontmatter.ts';

export interface Mention {
  name: string;
  /** offset of the matched text in the whole document */
  index: number;
  length: number;
  line: number;
  lineText: string;
}

const FENCE = /^\s*(`{3,}|~{3,})/;

const escapeRegExp = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ranges of a line that must not be touched: inline code, wikilinks, md links, URLs. */
function protectedRanges(line: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /`[^`]*`|\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|<[^>]+>/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push([m.index, m.index + m[0].length]);
  return out;
}

export function findMentions(text: string, names: string[], limit = 50): Mention[] {
  const wanted = names.map((n) => n.trim()).filter((n) => n.length >= 2);
  if (!wanted.length) return [];
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${wanted.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu',
  );
  const split = splitFrontmatter(text);
  const out: Mention[] = [];
  let pos = 0;
  let inFence = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i] as string;
    const lineStart = pos;
    pos += line.length + 1;
    if (lineStart < split.bodyOffset) continue;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const skip = protectedRanges(line);
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const at = m.index;
      if (skip.some(([a, b]) => at >= a && at < b)) continue;
      out.push({
        name: m[1] as string,
        index: lineStart + at,
        length: m[0].length,
        line: i + 1,
        lineText: line,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Wrap one mention as a wikilink, keeping the text as written when its case differs. */
export function linkMention(text: string, mention: Mention, canonical: string): string {
  const shown = text.slice(mention.index, mention.index + mention.length);
  const link = shown === canonical ? `[[${canonical}]]` : `[[${canonical}|${shown}]]`;
  return text.slice(0, mention.index) + link + text.slice(mention.index + mention.length);
}
