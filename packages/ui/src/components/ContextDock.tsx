import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type NoteResponse } from '../api.ts';
import { statusColor } from '../colors.ts';
import { livePreview } from '../editor/livePreview.ts';
import { notifyVaultChanges, useVaultEvents } from '../hooks.ts';
import {
  type PreviewAction,
  type PreviewState,
  previewBody,
  previewPath,
} from '../preview-state.ts';
import { Icon } from './Icon.tsx';
import { PersonPanel } from './PersonPanel.tsx';

function PreviewDocument({
  note,
  onResolve,
}: {
  note: NoteResponse;
  onResolve: (target: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const navigate = useRef(onResolve);
  navigate.current = onResolve;
  useEffect(() => {
    if (!host.current) return;
    const links = new Map(note.links.map((link) => [link.target.toLowerCase(), link.resolved]));
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: previewBody(note.content, note.meta?.title),
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
          EditorView.contentAttributes.of({ 'aria-label': 'Note preview' }),
          markdown({ base: markdownLanguage }),
          livePreview({
            onNavigate: (target) => navigate.current(target),
            onOpenExternal: (href) => window.open(href, '_blank', 'noopener,noreferrer'),
            isResolved: (target) => links.get(target.toLowerCase()),
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [note]);
  return <div className="preview-document" ref={host} />;
}

interface Draft {
  text: string;
  due: string;
}
interface Props {
  state: PreviewState;
  dispatch: Dispatch<PreviewAction>;
  onOpen: (path: string) => void;
  onPreview: (path: string) => void;
  onResolve: (target: string) => void;
  onChanged: () => void;
  onProtected: () => void;
}

export function ContextDock({
  state,
  dispatch,
  onOpen,
  onPreview,
  onResolve,
  onChanged,
  onProtected,
}: Props) {
  const current = previewPath(state);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const dock = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = !!(current || state.pinned);
  useEffect(() => {
    const showing = !!(current || state.pinned);
    if (showing) {
      if (!wasOpen.current)
        returnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dock.current?.querySelector<HTMLButtonElement>('.preview-close')?.focus();
    }
    if (!showing && wasOpen.current && returnFocus.current?.isConnected)
      returnFocus.current.focus();
    wasOpen.current = showing;
  }, [current, state.pinned]);
  const updateDraft = (path: string, draft: Draft) =>
    setDrafts((previous) => ({ ...previous, [path]: draft }));
  // Keep drafts in memory when the panel closes, never in browser storage.
  if (!open) return null;
  const paths = [state.pinned, current].filter((path): path is string => !!path);
  return (
    <aside
      ref={dock}
      className={`context-dock${paths.length === 2 ? ' comparing' : ''}`}
      aria-label="Context previews"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          dispatch({ type: 'close' });
        }
      }}
    >
      <header className="context-dock-header">
        <div>
          <Icon name="panel" />
          <strong>In context</strong>
          <span>{paths.length === 2 ? 'Compare' : 'Preview'}</span>
        </div>
        <button
          type="button"
          className="icon-button preview-close"
          aria-label="Close previews"
          title="Close previews (Esc)"
          onClick={() => dispatch({ type: 'close' })}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="context-previews">
        {paths.map((path) => (
          <PreviewCard
            key={path}
            path={path}
            pinned={state.pinned === path}
            canPin={!state.pinned}
            canBack={state.pinned !== path && state.index > 0}
            canForward={state.pinned !== path && state.index < state.history.length - 1}
            dispatch={dispatch}
            onOpen={onOpen}
            onPreview={onPreview}
            onResolve={onResolve}
            onChanged={onChanged}
            onProtected={onProtected}
            draft={drafts[path] ?? { text: '', due: '' }}
            onDraft={(draft) => updateDraft(path, draft)}
          />
        ))}
      </div>
    </aside>
  );
}

function PreviewCard({
  path,
  pinned,
  canPin,
  canBack,
  canForward,
  dispatch,
  onOpen,
  onPreview,
  onResolve,
  onChanged,
  onProtected,
  draft,
  onDraft,
}: Omit<Props, 'state'> & {
  path: string;
  pinned: boolean;
  canPin: boolean;
  canBack: boolean;
  canForward: boolean;
  draft: Draft;
  onDraft: (draft: Draft) => void;
}) {
  const [note, setNote] = useState<NoteResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const followUpField = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useVaultEvents(
    useCallback(
      (paths) => {
        if (paths.includes(path)) refresh();
      },
      [path, refresh],
    ),
  );
  useEffect(() => {
    let cancelled = false;
    void revision;
    api
      .note(path, true)
      .then((fresh) => {
        if (!cancelled) {
          setNote(fresh);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setNote(null);
          setError(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, revision]);

  const title = note?.meta?.title ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path;
  const fm = note?.meta?.frontmatter ?? {};
  const status = typeof fm.status === 'string' ? fm.status : null;
  const category = typeof fm.status_category === 'string' ? fm.status_category : null;
  const summary = typeof fm.summary === 'string' && !title.includes(fm.summary) ? fm.summary : null;
  const isPerson = note?.meta?.type === 'person' || path.startsWith('people/');
  const missing = error instanceof ApiError && error.status === 404;
  const protectedNote = error instanceof ApiError && error.status === 403;
  const outgoing = [
    ...new Map((note?.links ?? []).map((link) => [link.path ?? link.target, link])).values(),
  ];
  const outgoingPaths = new Set(outgoing.map((link) => link.path));
  const incoming = [
    ...new Map((note?.backlinks ?? []).map((link) => [link.srcPath, link])).values(),
  ].filter((link) => !outgoingPaths.has(link.srcPath));
  const capture = async () => {
    if (savingRef.current || !draft.text.trim()) return;
    savingRef.current = true;
    setSaving(true);
    setCaptureError(null);
    setCaptured(null);
    try {
      const result = await api.captureFollowUp(path, draft.text, draft.due);
      setCaptured(result.path);
      onDraft({ text: '', due: '' });
      notifyVaultChanges([result.path]);
      onChanged();
      refresh();
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : 'Could not save follow-up');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <section className="context-preview" aria-label={`${pinned ? 'Pinned: ' : ''}${title}`}>
      <div className="preview-toolbar">
        {!pinned && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label="Previous preview"
              disabled={!canBack}
              onClick={() => dispatch({ type: 'back' })}
            >
              <Icon name="back" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Next preview"
              disabled={!canForward}
              onClick={() => dispatch({ type: 'forward' })}
            >
              <Icon name="forward" />
            </button>
          </>
        )}
        <span className="spacer" />
        {note && (
          <button
            type="button"
            className="icon-button"
            aria-label="Capture a follow-up"
            title="Capture a follow-up"
            onClick={() => {
              followUpField.current?.scrollIntoView({ block: 'center' });
              followUpField.current?.focus();
            }}
          >
            <Icon name="plus" />
          </button>
        )}
        {(pinned || canPin) && (
          <button
            type="button"
            className={`preview-action${pinned ? ' selected' : ''}`}
            aria-pressed={pinned}
            title={pinned ? 'Unpin this reference' : 'Keep this beside the next preview'}
            onClick={() => dispatch({ type: pinned ? 'unpin' : 'pin' })}
          >
            <Icon name="pin" />
            {pinned ? 'Pinned' : 'Pin'}
          </button>
        )}
        {note && (
          <button type="button" className="preview-action" onClick={() => onOpen(path)}>
            <Icon name="expand" />
            Open note
          </button>
        )}
        {pinned && (
          <button
            type="button"
            className="icon-button"
            aria-label="Remove pinned reference"
            onClick={() => dispatch({ type: 'close-pinned' })}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="preview-scroll">
        <div className="preview-heading">
          <span className="preview-kind">
            {note?.meta?.type ?? 'Note'}
            {pinned && ' · Reference'}
          </span>
          <h2>{title}</h2>
          {summary && <p className="preview-summary">{summary}</p>}
          <div className="preview-path">{path}</div>
          {status && (
            <span className="preview-status">
              <span className="status-dot" style={{ background: statusColor(status, category) }} />
              {status}
            </span>
          )}
        </div>
        {!note && !error && (
          <p className="preview-message" role="status">
            Loading note…
          </p>
        )}
        {error && (
          <div className="preview-message" role="alert">
            <p>
              {missing
                ? 'This note does not exist yet.'
                : protectedNote
                  ? 'Open Protected notes to unlock this content.'
                  : error.message}
            </p>
            {missing ? (
              <button
                type="button"
                className="plan-btn"
                disabled={creating}
                onClick={() => {
                  setCreating(true);
                  api
                    .create(path, title)
                    .then(() => {
                      onChanged();
                      refresh();
                    })
                    .catch(setError)
                    .finally(() => setCreating(false));
                }}
              >
                {creating ? 'Creating…' : 'Create note'}
              </button>
            ) : protectedNote ? (
              <button type="button" className="plan-btn" onClick={onProtected}>
                Open Protected notes
              </button>
            ) : (
              <button type="button" className="plan-btn" onClick={refresh}>
                Try again
              </button>
            )}
          </div>
        )}
        {note && (
          <>
            {isPerson && <PersonPanel path={path} onOpen={onPreview} />}
            <PreviewDocument note={note} onResolve={onResolve} />
            {(note.links.length > 0 || note.backlinks.length > 0) && (
              <details className="preview-related" open>
                <summary>
                  Related notes <span>{outgoing.length + incoming.length}</span>
                </summary>
                {outgoing.map((link) => (
                  <button
                    key={link.target}
                    type="button"
                    className="preview-related-link"
                    onClick={() => onResolve(link.target)}
                  >
                    <Icon name="notes" />
                    <span>
                      {link.target}
                      {!link.resolved && <small>Not created yet</small>}
                      {note.backlinks.some((backlink) => backlink.srcPath === link.path) && (
                        <small>Also mentions this note</small>
                      )}
                    </span>
                  </button>
                ))}
                {incoming.map((link) => (
                  <button
                    key={link.srcPath}
                    type="button"
                    className="preview-related-link"
                    onClick={() => onPreview(link.srcPath)}
                  >
                    <Icon name="back" />
                    <span>
                      {link.srcTitle}
                      <small>Mentions this note</small>
                    </span>
                  </button>
                ))}
              </details>
            )}
            <form
              className="preview-followup"
              onSubmit={(event) => {
                event.preventDefault();
                void capture();
              }}
            >
              <label>
                Capture a follow-up
                <textarea
                  ref={followUpField}
                  aria-label={`Follow-up for ${title}`}
                  placeholder="What needs to happen next?"
                  value={draft.text}
                  maxLength={2000}
                  disabled={saving}
                  onChange={(e) => {
                    onDraft({ ...draft, text: e.target.value });
                    setCaptured(null);
                  }}
                />
              </label>
              <div className="preview-followup-actions">
                <label>
                  Due{' '}
                  <input
                    type="date"
                    aria-label="Follow-up due date"
                    value={draft.due}
                    disabled={saving}
                    onChange={(e) => onDraft({ ...draft, due: e.target.value })}
                  />
                </label>
                <button type="submit" className="plan-btn" disabled={saving || !draft.text.trim()}>
                  {saving ? 'Saving…' : 'Add follow-up'}
                </button>
              </div>
              <p className="preview-hint">Appears in Tasks, linked to this note.</p>
              {captureError && (
                <p className="preview-error" role="alert">
                  {captureError}
                </p>
              )}
              {captured && (
                <p className="preview-saved" role="status">
                  <Icon name="check" />
                  Added to Tasks.
                  <button type="button" onClick={() => onPreview(captured)}>
                    View follow-up
                  </button>
                </p>
              )}
            </form>
          </>
        )}
      </div>
    </section>
  );
}
