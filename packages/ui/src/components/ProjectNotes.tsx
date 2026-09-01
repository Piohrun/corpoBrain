import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { useVaultEvents } from '../hooks.ts';
import { WikiText } from './WikiText.tsx';

const KEY = 'cb.proj.notes';
function loadOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'closed';
  } catch {
    return true;
  }
}

/**
 * The project note's own text (goal, decisions, links), read-only, right
 * above the calendar — so the "why" sits next to the "when". Headings, lists
 * and paragraphs are enough here; the full editor is one click away.
 */
export function ProjectNotes({
  path,
  onOpenNote,
}: {
  path: string;
  onOpenNote: (path: string) => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [open, setOpen] = useState(loadOpen);

  const load = () => {
    api
      .note(path)
      .then((n) => setBody(stripFrontmatter(n.content)))
      .catch(() => setBody(null));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project changes
  useEffect(load, [path]);
  useVaultEvents((paths) => {
    if (paths.includes(path)) load();
  });

  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY, o ? 'closed' : 'open');
      } catch {
        /* not persisted */
      }
      return !o;
    });
  };

  const blocks = body === null ? [] : toBlocks(body);
  const empty = blocks.every((b) => b.kind === 'p' && !b.text.trim());

  return (
    <section className="proj-notes">
      <div className="proj-notes-head">
        <button type="button" className="group-toggle" onClick={toggle}>
          {open ? '▾' : '▸'} Notes
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="plan-btn small"
          onClick={() => onOpenNote(path)}
          title="Open the project note in the editor"
        >
          edit
        </button>
      </div>
      {open && (
        <div className="proj-notes-body">
          {body === null && <span className="muted small">loading…</span>}
          {body !== null && empty && (
            <span className="muted small">Nothing written yet — click edit to add the goal.</span>
          )}
          {blocks.map((b, i) => {
            const key = `${i}:${b.kind}`;
            if (b.kind === 'h')
              return (
                <div key={key} className={`pn-h pn-h${b.level}`}>
                  <WikiText text={b.text} onOpen={onOpenNote} />
                </div>
              );
            if (b.kind === 'li')
              return (
                <div key={key} className="pn-li" style={{ paddingLeft: 12 + b.level * 14 }}>
                  <span className="pn-bullet">{b.done === null ? '•' : b.done ? '☑' : '☐'}</span>
                  <WikiText text={b.text} onOpen={onOpenNote} className={b.done ? 'pn-done' : ''} />
                </div>
              );
            if (!b.text.trim()) return null;
            return (
              <p key={key} className="pn-p">
                <WikiText text={b.text} onOpen={onOpenNote} />
              </p>
            );
          })}
        </div>
      )}
    </section>
  );
}

function stripFrontmatter(text: string): string {
  if (!/^---[ \t]*\r?\n/.test(text)) return text;
  const end = /\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text.slice(3));
  return end ? text.slice(3 + end.index + end[0].length) : text;
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'li'; level: number; done: boolean | null; text: string }
  | { kind: 'p'; text: string };

/** Line-based markdown-lite: enough to read a project page, never to edit it. */
function toBlocks(md: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let inFence = false;
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      flush();
      out.push({ kind: 'h', level: (h[1] as string).length, text: (h[2] as string).trim() });
      continue;
    }
    const li = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(raw);
    if (li) {
      flush();
      const box = li[2];
      out.push({
        kind: 'li',
        level: Math.floor((li[1] as string).length / 2),
        done: box === undefined ? null : box !== ' ',
        text: (li[3] as string).trim(),
      });
      continue;
    }
    if (!raw.trim()) {
      flush();
      continue;
    }
    para.push(raw.trim());
  }
  flush();
  return out;
}
