import type React from 'react';
import { api } from '../api.ts';

interface Props {
  text: string;
  className?: string;
  onOpen: (path: string) => void;
  onTag?: (tag: string) => void;
}

const WIKILINK = /\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;
// keep identical to the indexer's tag grammar (core scan.ts)
const TAG = /(^|[\s(,;])#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;

/** Render plain text with [[wikilinks]] and #tags as interactive elements. */
export function WikiText({ text, className, onOpen, onTag }: Props) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  WIKILINK.lastIndex = 0;
  for (let m = WIKILINK.exec(text); m; m = WIKILINK.exec(text)) {
    if (m.index > last) parts.push(...renderTags(text.slice(last, m.index), last, onTag));
    const target = ((m[1] ?? '') + (m[2] ?? '')).trim();
    const label = (m[3] ?? m[1] ?? '').trim() || target;
    const bare = (m[1] ?? '').trim();
    if (!bare) {
      parts.push(m[0]);
    } else {
      parts.push(
        <button
          type="button"
          key={`w${m.index}`}
          className="wiki-inline"
          title={target}
          onClick={(e) => {
            e.stopPropagation();
            api
              .resolve(bare)
              .then(async (r) => {
                if (!r.exists) await api.create(r.path, bare);
                onOpen(r.path);
              })
              .catch(() => {});
          }}
        >
          {label}
        </button>,
      );
    }
    last = m.index + m[0].length;
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
