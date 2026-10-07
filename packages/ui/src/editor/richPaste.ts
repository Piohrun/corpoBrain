/**
 * Rich paste: HTML from Outlook, Word, Confluence or a web page → Markdown,
 * keeping what notes can hold — headings, paragraphs, lists (including
 * Word's paragraph-based ones), bold/italic/strikethrough, links, quotes,
 * code, tables, highlights and coloured text (as the safe HTML set).
 * Everything else is reduced to its text. The HTML is only parsed, never
 * inserted into the page.
 */
import { htmlTableToMarkdown } from './tables.ts';

/** colours that are just "normal text" in mail and Office HTML */
const PLAIN_COLORS =
  /^(black|windowtext|inherit|initial|currentcolor|#0{3}|#0{6}|#1[0-9a-f]{5}|#2[0-9a-f]{5}|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)|#212121|#242424|#323130)$/i;
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i;
const HIGHLIGHT_BG =
  /^(yellow|#ff0|#ffff00|#ffff99|#fff2cc|#ffeb9c|rgb\(\s*255\s*,\s*255\s*,\s*0\s*\))$/i;

const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'hr',
  'dl',
  'dt',
  'dd',
  'center',
  'address',
]);
const DROP = new Set([
  'script',
  'style',
  'head',
  'title',
  'meta',
  'link',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'button',
  'input',
  'select',
  'textarea',
  'xml',
]);

/** `rgb(192, 0, 0)` → `#c00000` (browsers report colours as rgb; notes read better with hex) */
function hexColor(color: string): string {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (!m || (m[4] !== undefined && Number(m[4]) < 1)) return color.toLowerCase();
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
}

const styleOf = (el: Element, prop: string): string =>
  ((el as HTMLElement).style?.getPropertyValue(prop) ?? '').trim().toLowerCase();

/** escape what would turn plain text into Markdown syntax */
function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]])/g, '\\$1').replace(/==/g, '\\==');
}

function wrap(inner: string, mark: string): string {
  // keep the spaces outside the marks: `** bold **` is not bold
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) as RegExpExecArray;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

interface Ctx {
  pre: boolean;
}

/** Inline content of a node as Markdown (newlines only from <br>). */
function inline(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) {
    const text = node.nodeValue ?? '';
    return ctx.pre ? text : escapeText(text.replace(/[\s\u00a0]+/g, ' '));
  }
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag) || tag.includes(':')) {
    // Office's <o:p> and friends: keep their text, drop the tag
    return tag.includes(':') ? [...el.childNodes].map((c) => inline(c, ctx)).join('') : '';
  }
  // Word's list bullets live in a span marked mso-list:Ignore
  if (/mso-list\s*:\s*ignore/i.test(el.getAttribute('style') ?? '')) return '';
  if (tag === 'br') return '\n';
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const alt = escapeText(el.getAttribute('alt') ?? '');
    return /^https?:\/\//i.test(src) ? `![${alt}](${src})` : alt;
  }
  const inner = [...el.childNodes].map((c) => inline(c, ctx)).join('');
  if (!inner.trim()) return inner.replace(/\n/g, ' ');
  if (ctx.pre) return inner;

  let out = inner;
  const weight = styleOf(el, 'font-weight');
  const bold = tag === 'b' || tag === 'strong' || weight === 'bold' || Number(weight) >= 600;
  const italic = tag === 'i' || tag === 'em' || styleOf(el, 'font-style') === 'italic';
  const strike =
    tag === 's' ||
    tag === 'del' ||
    tag === 'strike' ||
    /line-through/.test(styleOf(el, 'text-decoration'));
  const underline =
    tag === 'u' || (tag !== 'a' && /underline/.test(styleOf(el, 'text-decoration')));
  const mono =
    tag === 'code' ||
    tag === 'tt' ||
    tag === 'kbd' ||
    /consolas|courier|monospace/.test(styleOf(el, 'font-family'));

  if (mono) out = `\`${inner.replace(/\\([\\`*_[\]])/g, '$1').replace(/`/g, '')}\``;
  if (strike) out = wrap(out, '~~');
  if (italic) out = wrap(out, '*');
  if (bold && !/^h[1-6]$/.test(tag)) out = wrap(out, '**');
  if (underline) out = `<u>${out}</u>`;
  if (tag === 'sup' || tag === 'sub') out = `<${tag}>${out}</${tag}>`;

  const color = hexColor((el.getAttribute('color') ?? styleOf(el, 'color')).trim());
  const bg = hexColor(styleOf(el, 'background-color') || styleOf(el, 'background'));
  if (tag === 'mark' || HIGHLIGHT_BG.test(bg)) out = wrap(out, '==');
  else if (color && SAFE_COLOR.test(color) && !PLAIN_COLORS.test(color) && !out.includes('\n'))
    out = `<span style="color: ${color}">${out}</span>`;

  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    if (/^(https?:|mailto:)/i.test(href)) {
      const label = out.trim();
      return label === escapeText(href) || label === href
        ? `<${href}>`
        : `[${label}](${href.replace(/\)/g, '%29')})`;
    }
  }
  return out;
}

/** Word marks list paragraphs with `mso-list: l0 level2 lfo1` */
function wordListLevel(el: Element): { level: number; ordered: boolean } | null {
  const style = el.getAttribute('style') ?? '';
  const m = /mso-list\s*:\s*l\d+\s+level(\d+)/i.exec(style);
  if (!m && !/MsoListParagraph/i.test(el.getAttribute('class') ?? '')) return null;
  const ignore = el.querySelector('[style*="mso-list"]');
  const bullet = (ignore?.textContent ?? '').trim();
  return { level: m ? Number(m[1]) : 1, ordered: /^[\w]{1,3}[.)]$/.test(bullet) };
}

/** Block content as Markdown lines. */
function blocks(node: Node, ctx: Ctx, out: string[], indent = ''): void {
  const flush = (text: string) => {
    const lines = text.replace(/[ \t]+\n/g, '\n').split('\n');
    const trimmed = lines.map((l) => l.trim());
    if (trimmed.some(Boolean)) out.push(...trimmed.map((l) => (l ? indent + l : '')));
  };
  let run = '';
  // after Word's list paragraphs a blank line, or the next paragraph would join the last item
  let wordList = false;
  const endList = () => {
    if (wordList) out.push('');
    wordList = false;
  };
  const endRun = () => {
    if (run.trim()) {
      endList();
      flush(run);
      out.push('');
    }
    run = '';
  };
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== 1) {
      run += inline(child, ctx);
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) continue;
    if (!BLOCK.has(tag)) {
      run += inline(el, ctx);
      continue;
    }
    endRun();
    const word = tag === 'p' ? wordListLevel(el) : null;
    if (word) {
      const pad = '  '.repeat(word.level - 1);
      out.push(`${indent}${pad}${word.ordered ? '1.' : '-'} ${inline(el, ctx).trim()}`);
      wordList = true;
      continue;
    }
    endList();
    if (/^h[1-6]$/.test(tag)) {
      const text = inline(el, ctx).replace(/\s+/g, ' ').trim();
      if (text) out.push(`${indent}${'#'.repeat(Number(tag[1]))} ${text}`, '');
    } else if (tag === 'hr') out.push(`${indent}---`, '');
    else if (tag === 'pre') {
      const code = inline(el, { pre: true }).replace(/\n+$/, '');
      out.push(
        `${indent}\`\`\``,
        ...code.split('\n').map((l) => indent + l),
        `${indent}\`\`\``,
        '',
      );
    } else if (tag === 'blockquote') {
      const inner: string[] = [];
      blocks(el, ctx, inner);
      while (inner.at(-1) === '') inner.pop();
      out.push(...inner.map((l) => `${indent}>${l ? ` ${l}` : ''}`), '');
    } else if (tag === 'ul' || tag === 'ol') {
      let n = 1;
      for (const li of [...el.children]) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const marker = tag === 'ol' ? `${n++}.` : '-';
        // the item's own text, then any nested lists indented under it
        const own = [...li.childNodes].filter(
          (c) => !(c.nodeType === 1 && ['ul', 'ol'].includes((c as Element).tagName.toLowerCase())),
        );
        const text = own
          .map((c) => inline(c, ctx))
          .join('')
          .replace(/\s*\n\s*/g, ' ')
          .trim();
        out.push(`${indent}${marker} ${text}`);
        for (const c of li.children) {
          const t = c.tagName.toLowerCase();
          if (t === 'ul' || t === 'ol') {
            const nested: string[] = [];
            blocks(
              { childNodes: [c] } as unknown as Node,
              ctx,
              nested,
              `${indent}${' '.repeat(marker.length + 1)}`,
            );
            out.push(...nested.filter(Boolean));
          }
        }
      }
      out.push('');
    } else if (tag === 'table') {
      const md = htmlTableToMarkdown(el.outerHTML);
      if (md) out.push(...md.split('\n').map((l) => indent + l), '');
      else flush(el.textContent ?? '');
    } else if (tag === 'li') {
      out.push(
        `${indent}- ${inline(el, ctx)
          .replace(/\s*\n\s*/g, ' ')
          .trim()}`,
      );
    } else {
      blocks(el, ctx, out, indent);
    }
  }
  endRun();
  endList();
}

/**
 * Pasted HTML → Markdown, or null when it carries no formatting worth
 * keeping (the plain-text paste is then just as good).
 */
export function htmlToMarkdown(html: string | null | undefined): string | null {
  if (!html || !/<[a-z]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  blocks(doc.body, { pre: false }, out);
  const md = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  if (!md) return null;
  // nothing but text: let the editor's own plain paste handle it
  const plain = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (
    md
      .replace(/\\([\\`*_[\]=])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim() === plain
  )
    return null;
  return md;
}
