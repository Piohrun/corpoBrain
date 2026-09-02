import type { SyntaxNode, Tree } from '@lezer/common';
import { GFM, parser } from '@lezer/markdown';

export interface ExternalLink {
  /** Full Markdown span (`[label](url)`, `<url>`, or the bare URL). */
  from: number;
  to: number;
  /** Text shown while live preview is active. */
  labelFrom: number;
  labelTo: number;
  href: string;
  kind: 'markdown' | 'autolink' | 'bare';
}

const externalMarkdownParser = parser.configure(GFM);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Turn a Markdown URL token into a browser-safe external href. Deliberately
 * allow only protocols that represent links users expect notes to open.
 */
export function normalizeExternalHref(raw: string): string | null {
  let href = raw.trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim();
  href = href.replace(/\\([\\()[\]<>])/g, '$1');

  if (/^www\./i.test(href)) href = `https://${href}`;
  else if (EMAIL.test(href)) href = `mailto:${href}`;

  try {
    const parsed = new URL(href);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) children.push(child);
  }
  return children;
}

/** Extract external links from an existing Markdown syntax tree. */
export function externalLinksInTree(
  tree: Tree,
  read: (from: number, to: number) => string,
  from = 0,
  to = tree.length,
): ExternalLink[] {
  const links: ExternalLink[] = [];

  tree.iterate({
    from,
    to,
    enter(ref) {
      const node = ref.node;

      // Images and link definitions contain URL nodes, but neither is an
      // external hyperlink at its source position. Code is always literal.
      if (
        node.name === 'Image' ||
        node.name === 'LinkReference' ||
        node.name === 'InlineCode' ||
        node.name === 'FencedCode' ||
        node.name === 'CodeBlock'
      ) {
        return false;
      }

      if (node.name === 'Link') {
        const urlNode = node.getChild('URL');
        const href = urlNode ? normalizeExternalHref(read(urlNode.from, urlNode.to)) : null;
        const marks = directChildren(node, 'LinkMark');
        if (href && marks.length >= 2) {
          links.push({
            from: node.from,
            to: node.to,
            labelFrom: marks[0]?.to ?? node.from,
            labelTo: marks[1]?.from ?? node.to,
            href,
            kind: 'markdown',
          });
        }
        // A URL-looking label still follows this link's own destination.
        return false;
      }

      if (node.name === 'Autolink') {
        const urlNode = node.getChild('URL');
        const href = urlNode ? normalizeExternalHref(read(urlNode.from, urlNode.to)) : null;
        if (href && urlNode) {
          links.push({
            from: node.from,
            to: node.to,
            labelFrom: urlNode.from,
            labelTo: urlNode.to,
            href,
            kind: 'autolink',
          });
        }
        return false;
      }

      // Under GFM, ordinary http(s), www, and email text gets a bare URL
      // node. Structured URL nodes above were pruned before reaching here.
      if (node.name === 'URL') {
        const href = normalizeExternalHref(read(node.from, node.to));
        if (href) {
          links.push({
            from: node.from,
            to: node.to,
            labelFrom: node.from,
            labelTo: node.to,
            href,
            kind: 'bare',
          });
        }
      }
    },
  });

  return links;
}

/** Parse a self-contained Markdown fragment, used by rendered table cells. */
export function externalLinksInText(text: string): ExternalLink[] {
  return externalLinksInTree(externalMarkdownParser.parse(text), (from, to) =>
    text.slice(from, to),
  );
}
