import { useCallback, useEffect, useRef, useState } from 'react';
import { type PrivateStatus, privateApi } from '../api.ts';

export function PrivatePage() {
  const [status, setStatus] = useState<PrivateStatus | null>(null);
  const [notes, setNotes] = useState<{ file: string; title: string }[]>([]);
  const [current, setCurrent] = useState<{ file: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(() => {
    privateApi
      .status()
      .then((s) => {
        setStatus(s);
        if (s.unlocked)
          privateApi
            .list()
            .then(setNotes)
            .catch(() => {});
        else {
          setNotes([]);
          setCurrent(null);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const act = useCallback(
    (fn: () => Promise<unknown>) => {
      setError(null);
      fn()
        .then(refresh)
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const save = useCallback(() => {
    if (!current || !textRef.current) return;
    const content = textRef.current.value;
    privateApi
      .write(current.file, content)
      .then(() => {
        setDirty(false);
        refresh();
      })
      .catch((e: Error) => setError(e.message));
  }, [current, refresh]);

  if (!status)
    return (
      <div className="planning">
        <div className="empty-state">Loading…</div>
      </div>
    );

  if (!status.unlocked) {
    return (
      <div className="planning">
        <div className="empty-state">
          <form
            className="unlock-box"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem('pass') as HTMLInputElement).value;
              act(() => (status.initialized ? privateApi.unlock(input) : privateApi.init(input)));
            }}
          >
            <h2>🔒 Protected notes</h2>
            <p className="muted">
              {status.initialized
                ? 'Encrypted with your passphrase. Locked notes are invisible to search and agents.'
                : 'Set a passphrase (min 8 chars) to create your encrypted space. There is no recovery if you forget it.'}
            </p>
            <input name="pass" type="password" placeholder="Passphrase" />
            <button type="submit" className="plan-btn">
              {status.initialized ? 'Unlock' : 'Create'}
            </button>
            {error && <p className="plan-error">{error}</p>}
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="planning">
      <div className="planning-header">
        <span className="title">🔓 Protected notes</span>
        <span className="muted small">
          auto-locks after {status.lockAfterMinutes} min idle · plaintext never touches disk
        </span>
        <span className="spacer" />
        {error && <span className="plan-error">{error}</span>}
        <button
          type="button"
          className="plan-btn"
          onClick={() =>
            act(async () => {
              const r = await privateApi.write(null, '---\ntitle: Untitled\n---\n\n');
              const note = await privateApi.read(r.file);
              setCurrent({ file: note.file, content: note.content });
              setDirty(false);
            })
          }
        >
          + New
        </button>
        <button
          type="button"
          className="plan-btn lock"
          onClick={() => act(() => privateApi.lock())}
        >
          Lock now
        </button>
      </div>
      <div className="private-body">
        <div className="private-list">
          {notes.map((n) => (
            <button
              type="button"
              key={n.file}
              className={`tree-item${current?.file === n.file ? ' active' : ''}`}
              onClick={() =>
                act(async () => {
                  const note = await privateApi.read(n.file);
                  setCurrent({ file: note.file, content: note.content });
                  setDirty(false);
                })
              }
            >
              {n.title}
            </button>
          ))}
          {notes.length === 0 && <div className="tree-item muted">Nothing here yet</div>}
        </div>
        <div className="private-editor">
          {current ? (
            <>
              <textarea
                ref={textRef}
                key={current.file}
                defaultValue={current.content}
                onChange={() => setDirty(true)}
                spellCheck={false}
              />
              <div className="private-editor-bar">
                <span className="muted small">{dirty ? 'unsaved changes' : 'saved'}</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="key-link"
                  onClick={() => {
                    if (window.confirm('Delete this protected note permanently?'))
                      act(async () => {
                        await privateApi.remove(current.file);
                        setCurrent(null);
                      });
                  }}
                >
                  delete
                </button>
                <button type="button" className="plan-btn" onClick={save} disabled={!dirty}>
                  Save
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">Select or create a note</div>
          )}
        </div>
      </div>
    </div>
  );
}
