/**
 * The small set of inline HTML a note may use where Markdown has no syntax:
 * <u>, <sup>, <sub>, <kbd>, <mark>, <s>, <small>, and coloured text as
 * <span style="color: …; background-color: …">. Nothing here ever becomes
 * HTML in the page: a tag only turns into a styled range (live preview) or
 * a freshly created element with textContent (tables), and only colour
 * properties with plain colour values survive.
 */

export const SIMPLE_TAGS = ['u', 'sup', 'sub', 'kbd', 'mark', 's', 'small'] as const;
export type SimpleTag = (typeof SIMPLE_TAGS)[number];

export interface HtmlSpan {
  /** offsets in the scanned text */
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
  /** a simple tag, or 'span' for coloured text */
  tag: SimpleTag | 'span';
  /** sanitized CSS for 'span' (color / background-color only) */
  style: string | null;
}

const SPAN = new RegExp(
  `<(${SIMPLE_TAGS.join('|')})>([^<>]*?)</\\1>|<span\\s+style\\s*=\\s*"([^"<>]*)"\\s*>([^<>]*?)</span>`,
  'gi',
);
const COLOR_VALUE =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+\s*)?\)|[a-z]{3,20})$/i;

/** `color: red; background: #ff0` → `color:red;background-color:#ff0`; anything else is dropped. */
export function safeStyle(attr: string): string | null {
  const out: string[] = [];
  for (const decl of attr.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!COLOR_VALUE.test(value) || /^(inherit|initial|unset|revert|var)$/i.test(value)) continue;
    if (prop === 'color') out.push(`color:${value}`);
    else if (prop === 'background-color' || prop === 'background')
      out.push(`background-color:${value}`);
  }
  return out.length ? out.join(';') : null;
}

/** Inline HTML spans in one line of text (not nested; tags must close on the line). */
export function inlineHtml(text: string): HtmlSpan[] {
  const out: HtmlSpan[] = [];
  SPAN.lastIndex = 0;
  for (let m = SPAN.exec(text); m; m = SPAN.exec(text)) {
    const whole = m[0];
    if (m[1]) {
      const open = `<${m[1]}>`.length;
      out.push({
        from: m.index,
        to: m.index + whole.length,
        innerFrom: m.index + open,
        innerTo: m.index + open + (m[2] as string).length,
        tag: (m[1] as string).toLowerCase() as SimpleTag,
        style: null,
      });
    } else {
      const style = safeStyle(m[3] as string);
      if (!style) continue; // a span that only carries unsupported styling stays text
      const inner = m[4] as string;
      const innerFrom = m.index + whole.length - '</span>'.length - inner.length;
      out.push({
        from: m.index,
        to: m.index + whole.length,
        innerFrom,
        innerTo: innerFrom + inner.length,
        tag: 'span',
        style,
      });
    }
  }
  return out;
}

/** the colours offered for "text colour…": readable on light and dark backgrounds */
export const TEXT_COLORS = [
  { name: 'red', value: '#c00000' },
  { name: 'orange', value: '#c55a11' },
  { name: 'green', value: '#2e7d32' },
  { name: 'blue', value: '#2563eb' },
  { name: 'purple', value: '#7030a0' },
  { name: 'grey', value: '#6b7280' },
] as const;

/** Colour each non-empty line of `text` (a span cannot cross lines). */
export function toColored(text: string, color: string): string {
  return text
    .split('\n')
    .map((l) => {
      const m = /^(\s*)(.*?)(\s*)$/.exec(l) as RegExpExecArray;
      return m[2] ? `${m[1]}<span style="color: ${color}">${m[2]}</span>${m[3]}` : l;
    })
    .join('\n');
}
