import { useEffect, useRef, useState } from 'react';
import type { TrackKind } from '../api.ts';

const KINDS: {
  kind: TrackKind;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    kind: 'commitment',
    label: 'Commitment',
    icon: '✓',
    description: 'Something someone agreed to do',
  },
  {
    kind: 'decision',
    label: 'Decision',
    icon: '◆',
    description: 'A choice worth preserving',
  },
  {
    kind: 'risk',
    label: 'Risk',
    icon: '▲',
    description: 'Something that could derail the plan',
  },
  {
    kind: 'assumption',
    label: 'Assumption',
    icon: '≈',
    description: 'A belief that still needs testing',
  },
];

export interface TrackDialogValue {
  kind: TrackKind;
  statement: string;
  owner: string;
  date: string;
}

interface Props {
  excerpt: string;
  sourcePath: string;
  sourceLine: number;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (value: TrackDialogValue) => void;
}

export function TrackDialog({
  excerpt,
  sourcePath,
  sourceLine,
  saving,
  error,
  onClose,
  onSubmit,
}: Props) {
  const [kind, setKind] = useState<TrackKind>('commitment');
  const [statement, setStatement] = useState(excerpt.replace(/\s+/g, ' ').trim());
  const [owner, setOwner] = useState('');
  const [date, setDate] = useState('');
  const statementRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    statementRef.current?.focus();
    statementRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const dateLabel = kind === 'commitment' ? 'Due date' : 'Review date';
  const ownerPlaceholder =
    kind === 'commitment'
      ? 'Who made the commitment?'
      : kind === 'decision'
        ? 'Decision owner (optional)'
        : 'Who will follow this up?';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the dialog
    <div
      className="palette-backdrop track-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="track-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="track-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (statement.trim() && !saving) {
            onSubmit({ kind, statement: statement.trim(), owner: owner.trim(), date });
          }
        }}
      >
        <div className="track-dialog-head">
          <div>
            <h2 id="track-dialog-title">Track as…</h2>
            <p>
              Evidence from {sourcePath}:{sourceLine}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} disabled={saving}>
            ×
          </button>
        </div>

        <div className="track-kind-grid">
          {KINDS.map((item) => (
            <button
              type="button"
              key={item.kind}
              className={`track-kind${kind === item.kind ? ' active' : ''}`}
              onClick={() => setKind(item.kind)}
            >
              <span className={`track-kind-icon ${item.kind}`}>{item.icon}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </div>

        <label className="track-field">
          Statement
          <textarea
            ref={statementRef}
            value={statement}
            rows={3}
            maxLength={2_000}
            onChange={(event) => setStatement(event.target.value)}
          />
        </label>

        <div className="track-fields-row">
          <label className="track-field">
            Owner <span>optional</span>
            <input
              value={owner}
              maxLength={200}
              placeholder={ownerPlaceholder}
              onChange={(event) => setOwner(event.target.value)}
            />
          </label>
          <label className="track-field date">
            {dateLabel} <span>optional</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        </div>

        <div className="track-evidence">
          <span>Original evidence</span>
          <blockquote>{excerpt}</blockquote>
        </div>

        <div className="track-dialog-foot">
          {error && <span className="plan-error">{error}</span>}
          <span className="spacer" />
          <button type="button" className="track-cancel" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="plan-btn" disabled={!statement.trim() || saving}>
            {saving ? 'Tracking…' : `Track ${kind}`}
          </button>
        </div>
      </form>
    </div>
  );
}
