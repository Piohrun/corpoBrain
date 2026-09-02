import type React from 'react';
import { api } from '../api.ts';
import { type ExternalLink, externalLinksInText } from '../editor/externalLinks.ts';

interface Props {
  text: string;
  className?: string;
  onOpen: (path: string) => void;
  onTag?: (tag: string) => void;
}

const WIKILINK = /\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;
// keep identical to the indexer's tag grammar (core scan.ts)
const TAG = /(^|[\s(,;])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

interface LinkToken {
  from: number;
  to: number;
  wiki?: RegExpExecArray;
  external?: ExternalLink;
}

/** Render plain text with wiki/external links and #tags as interactive elements. */
export function WikiText({ text, className, onOpen, onTag }: Props) {
  const parts: React.ReactNode[] = [];
  const tokens: LinkToken[] = externalLinksInText(text).map((external) => ({
    from: external.from,
    to: external.to,
    external,
  }));
  WIKILINK.lastIndex = 0;
  for (let wiki = WIKILINK.exec(text); wiki; wiki = WIKILINK.exec(text)) {
    tokens.push({ from: wiki.index, to: wiki.index + wiki[0].length, wiki });
  }
  // A containing wikilink wins over URL-looking text inside its target.
  tokens.sort((a, b) => a.from - b.from || b.to - a.to);

  let last = 0;
  for (const token of tokens) {
    if (token.from < last) continue;
    if (token.from > last) {
      parts.push(...renderTags(text.slice(last, token.from), last, onTag));
    }
    const m = token.wiki;
    if (m) {
      const target = ((m[1] ?? '') + (m[2] ?? '')).trim();
      const label = (m[3] ?? m[1] ?? '').trim() || target;
      const bare = (m[1] ?? '').trim();
      if (!bare) {
        parts.push(m[0]);
      } else {
        parts.push(
          <button
            type="button"
            key={`w${token.from}`}
            className="wiki-inline"
            title={target}
            onClick={(e) => {
              e.stopPropagation();
              api
                .resolveOrCreate(bare)
                .then((r) => onOpen(r.path))
                .catch(() => {});
            }}
          >
            {label}
          </button>,
        );
      }
    } else if (token.external) {
      const external = token.external;
      parts.push(
        <a
          key={`e${token.from}`}
          className="cm-cb-external-link"
          href={external.href}
          target="_blank"
          rel="noopener noreferrer"
          title={external.href}
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {text.slice(external.labelFrom, external.labelTo)}
        </a>,
      );
    }
    last = token.to;
  }
  if (last < text.length) parts.push(...renderTags(text.slice(last), last, onTag));
  return <span className={className}>{parts}</span>;
}

function renderTags(
  chunk: string,
  offset: number,
  onTag: ((tag: string) => void) | undefined,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(chunk); m; m = TAG.exec(chunk)) {
    const prefix = m[1] ?? '';
    if (m.index + prefix.length > last) parts.push(chunk.slice(last, m.index + prefix.length));
    const tag = (m[2] ?? '').toLowerCase();
    parts.push(
      onTag ? (
        <button
          type="button"
          key={`t${offset}:${m.index}`}
          className="tag-row clickable"
          onClick={(e) => {
            e.stopPropagation();
            onTag(tag);
          }}
        >
          #{m[2]}
        </button>
      ) : (
        <span key={`t${offset}:${m.index}`} className="tag-row" title="display only">
          #{m[2]}
        </span>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < chunk.length) parts.push(chunk.slice(last));
  return parts;
}
