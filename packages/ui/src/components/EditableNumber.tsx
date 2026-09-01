import { useState } from 'react';

export function EditableNumber({
  value,
  fallback,
  placeholder,
  title,
  dimmed,
  variant = 'cap',
  onCommit,
}: {
  value: number | null;
  /** shown and used as the starting input value when `value` is null */
  fallback?: number;
  placeholder?: string;
  title?: string;
  dimmed?: boolean;
  variant?: 'cap' | 'load';
  onCommit: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    if (variant === 'load') {
      return (
        <button
          type="button"
          className={`load-edit${value !== null ? ' load-overridden' : ''}`}
          title={title}
          onClick={() => setEditing(true)}
        >
          <b className="load-planned">{value ?? fallback}</b>
          {value !== null && <span className="load-pencil">✎</span>}
        </button>
      );
    }
    return (
      <button
        type="button"
        className={`cap-value${dimmed ? ' inherited' : ''}`}
        title={title ?? 'Click to edit'}
        onClick={() => setEditing(true)}
      >
        {value ?? placeholder ?? '—'}
      </button>
    );
  }
  return (
    <input
      className="cap-input"
      type="number"
      step="0.5"
      aria-label={title ?? 'value'}
      ref={(el) => {
        el?.focus();
        el?.select();
      }}
      defaultValue={value ?? fallback ?? ''}
      placeholder={placeholder}
      onBlur={(e) => {
        setEditing(false);
        const v = e.target.value === '' ? null : Number(e.target.value);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}
