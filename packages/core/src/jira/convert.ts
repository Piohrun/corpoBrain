/**
 * Convert Jira text to Markdown.
 * - Data Center: Jira wiki markup (string)
 * - Cloud: ADF (Atlassian Document Format, JSON)
 * On any failure the caller falls back to fencing the raw text.
 */

export function jiraTextToMarkdown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return wikiToMarkdown(value);
  if (typeof value === 'object') {
    try {
      return adfToMarkdown(value as AdfNode).trim();
    } catch {
      return fence(JSON.stringify(value, null, 2));
    }
  }
  return String(value);
}

export function fence(text: string): string {
  return `\`\`\`text\n${text.replace(/```/g, '\\`\\`\\`')}\n\`\`\``;
}

// ------------------------------------------------------------------ wiki

export function wikiToMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inCode = false;
  for (let line of lines) {
    // {code} / {noformat} blocks
    const codeToggle = /\{(code(?::[^}]*)?|noformat)\}/;
    if (codeToggle.test(line)) {
      const parts = line.split(codeToggle);
      let text = '';
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          text += inCode ? '\n```' : `\n\`\`\`${langOf(parts[i] as string)}`;
          inCode = !inCode;
        } else if (parts[i]) {
          text += (text.endsWith('```') || text.endsWith('\n') ? '\n' : '') + (parts[i] as string);
        }
      }
      out.push(...text.replace(/^\n/, '').split('\n'));
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    // headings
    const h = /^h([1-6])\.\s+(.*)$/.exec(line);
    if (h) {
      out.push(`${'#'.repeat(Number(h[1]))} ${h[2]}`);
      continue;
    }
    // quotes
    line = line.replace(/^bq\.\s+/, '> ');
    // lists: *, **, #, ## …
    const list = /^([*#]+)\s+(.*)$/.exec(line);
    if (list) {
      const depth = (list[1] as string).length - 1;
      const ordered = (list[1] as string).endsWith('#');
      line = `${'  '.repeat(depth)}${ordered ? '1.' : '-'} ${list[2]}`;
    }
    line = inlineWiki(line);
    out.push(line);
  }
  return out.join('\n').trim();
}

function langOf(tag: string): string {
  const m = /:([a-zA-Z0-9+#-]+)/.exec(tag);
  return m ? (m[1] as string) : '';
}

function inlineWiki(line: string): string {
  return (
    line
      // links [text|url] / [url]
      .replace(/\[([^|\]]+)\|(https?:[^\]]+)\]/g, '[$1]($2)')
      .replace(/\[(https?:[^\]]+)\]/g, '<$1>')
      // bold *text* → **text**
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1**$2**')
      // italic _text_
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1*$2*')
      // monospace {{text}}
      .replace(/\{\{([^}]+)\}\}/g, '`$1`')
      // strikethrough -text- (conservative: only when spaced)
      .replace(/(^|\s)-([^-\n]+)-(?=\s|$)/g, '$1~~$2~~')
  );
}

// ------------------------------------------------------------------- ADF

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

function adfToMarkdown(node: AdfNode): string {
  return blocks(node.content ?? []).join('\n\n');
}

function blocks(nodes: AdfNode[], indent = ''): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push(indent + inline(n.content ?? []));
        break;
      case 'heading':
        out.push(`${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inline(n.content ?? [])}`);
        break;
      case 'codeBlock':
        out.push(`\`\`\`${(n.attrs?.language as string) ?? ''}\n${textOf(n)}\n\`\`\``);
        break;
      case 'blockquote':
        out.push(
          blocks(n.content ?? [])
            .join('\n\n')
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'bulletList':
      case 'orderedList': {
        const marker = n.type === 'bulletList' ? '-' : '1.';
        for (const item of n.content ?? []) {
          const inner = blocks(item.content ?? []).join('\n');
          const [first = '', ...rest] = inner.split('\n');
          out.push(
            [`${indent}${marker} ${first}`, ...rest.map((l) => `${indent}  ${l}`)].join('\n'),
          );
        }
        break;
      }
      case 'rule':
        out.push('---');
        break;
      case 'table': {
        const rows = (n.content ?? []).map((row) =>
          (row.content ?? []).map((cell) => inline(flattenCells(cell)).replace(/\|/g, '\\|')),
        );
        if (rows.length) {
          const header = rows[0] as string[];
          out.push(
            [
              `| ${header.join(' | ')} |`,
              `| ${header.map(() => '---').join(' | ')} |`,
              ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
            ].join('\n'),
          );
        }
        break;
      }
      case 'mediaGroup':
      case 'mediaSingle':
        out.push('*(attachment)*');
        break;
      default:
        if (n.content) out.push(blocks(n.content, indent).join('\n\n'));
        else if (n.text) out.push(inline([n]));
    }
  }
  return out;
}

function flattenCells(cell: AdfNode): AdfNode[] {
  const acc: AdfNode[] = [];
  for (const p of cell.content ?? []) acc.push(...(p.content ?? []));
  return acc;
}

function textOf(n: AdfNode): string {
  if (n.text) return n.text;
  return (n.content ?? []).map(textOf).join('');
}

function inline(nodes: AdfNode[]): string {
  let s = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text': {
        let t = n.text ?? '';
        for (const mark of n.marks ?? []) {
          if (mark.type === 'strong') t = `**${t}**`;
          else if (mark.type === 'em') t = `*${t}*`;
          else if (mark.type === 'code') t = `\`${t}\``;
          else if (mark.type === 'strike') t = `~~${t}~~`;
          else if (mark.type === 'link') t = `[${t}](${(mark.attrs?.href as string) ?? ''})`;
        }
        s += t;
        break;
      }
      case 'hardBreak':
        s += '\n';
        break;
      case 'mention':
        s += `@${(n.attrs?.text as string)?.replace(/^@/, '') ?? 'user'}`;
        break;
      case 'emoji':
        s += (n.attrs?.shortName as string) ?? '';
        break;
      case 'inlineCard':
        s += `<${(n.attrs?.url as string) ?? ''}>`;
        break;
      case 'status':
        s += `\`${(n.attrs?.text as string) ?? ''}\``;
        break;
      default:
        s += inline(n.content ?? []);
    }
  }
  return s;
}
