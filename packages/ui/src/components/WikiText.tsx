import type React from 'react';
import { api } from '../api.ts';

interface Props {
  text: string;
  className?: string;
  onOpen: (path: string) => void;
}

const WIKILINK = /\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g;

/** Render plain text with [[wikilinks]] as clickable links (alias-aware). */
export function WikiText({ text, className, onOpen }: Props) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  WIKILINK.lastIndex = 0;
  for (let m = WIKILINK.exec(text); m; m = WIKILINK.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const target = ((m[1] ?? '') + (m[2] ?? '')).trim();
    const label = (m[3] ?? m[1] ?? '').trim() || target;
    const bare = (m[1] ?? '').trim();
    if (!bare) {
      parts.push(m[0]); // [[#fragment-only]] links have no target note here
    } else {
      parts.push(
        <button
          type="button"
          key={`${m.index}:${target}`}
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
  if (last < text.length) parts.push(text.slice(last));
  return <span className={className}>{parts}</span>;
}
