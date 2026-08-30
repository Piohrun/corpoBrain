import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteListItem } from '../api.ts';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  notes: NoteListItem[];
  commands: PaletteCommand[];
  onOpen: (path: string) => void;
  onClose: () => void;
  onCreate: (title: string) => void;
}

export function CommandPalette({ open, notes, commands, onOpen, onClose, onCreate }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const isCommand = q.startsWith('>');
    if (isCommand) {
      const cq = q.slice(1).trim();
      return commands
        .filter((c) => c.label.toLowerCase().includes(cq))
        .map((c) => ({
          key: `cmd:${c.id}`,
          label: `> ${c.label}`,
          hint: c.hint ?? '',
          run: c.run,
        }));
    }
    const matches = notes
      .filter((n) => !n.protected)
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      .slice(0, 12)
      .map((n) => ({
        key: n.path,
        label: n.title,
        hint: n.path,
        run: () => onOpen(n.path),
      }));
    if (q && !matches.some((m) => m.label.toLowerCase() === q)) {
      matches.push({
        key: '::create::',
        label: `Create "${query.trim()}"`,
        hint: 'new note',
        run: () => onCreate(query.trim()),
      });
    }
    return matches;
  }, [query, notes, commands, onOpen, onCreate]);

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; Escape handled on the input
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette">
        <input
          ref={inputRef}
          value={query}
          placeholder="Open note… (start with > for commands)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              const item = items[selected];
              if (item) {
                onClose();
                item.run();
              }
            }
          }}
        />
        <div className="palette-list">
          {items.map((item, i) => (
            <button
              type="button"
              key={item.key}
              className={`palette-item${i === selected ? ' selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => {
                onClose();
                item.run();
              }}
            >
              {item.label}
              <span className="muted">{item.hint}</span>
            </button>
          ))}
          {items.length === 0 && <div className="palette-item muted">Nothing found</div>}
        </div>
      </div>
    </div>
  );
}
