import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * In-app confirm / prompt / toast, replacing window.confirm & friends so
 * every dialog looks like the rest of the app and is keyboard-first:
 * Enter confirms, Esc cancels, the input or the primary button has focus.
 */
export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** red primary button for irreversible things */
  danger?: boolean;
}

export interface PromptOptions {
  title?: string;
  message?: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
}

export interface ToastOptions {
  message: string;
  kind?: 'info' | 'error' | 'success';
  /** one optional action, e.g. Undo */
  action?: { label: string; run: () => void | Promise<void> };
  /** ms; default 6 s, errors 10 s */
  ttl?: number;
}

export interface Dialogs {
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
  prompt: (opts: PromptOptions | string) => Promise<string | null>;
  /** non-blocking notice; errors stay longer */
  toast: (opts: ToastOptions | string) => void;
  /** alert-style: an error toast */
  alert: (message: string) => void;
}

const Ctx = createContext<Dialogs | null>(null);

type Pending =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

interface Toast extends ToastOptions {
  id: number;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const confirm = useCallback(
    (o: ConfirmOptions | string) =>
      new Promise<boolean>((resolve) =>
        setPending({ kind: 'confirm', opts: typeof o === 'string' ? { message: o } : o, resolve }),
      ),
    [],
  );
  const prompt = useCallback(
    (o: PromptOptions | string) =>
      new Promise<string | null>((resolve) =>
        setPending({ kind: 'prompt', opts: typeof o === 'string' ? { message: o } : o, resolve }),
      ),
    [],
  );
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (o: ToastOptions | string) => {
      const opts = typeof o === 'string' ? { message: o } : o;
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-4), { ...opts, id }]);
      const ttl = opts.ttl ?? (opts.kind === 'error' ? 10_000 : 6_000);
      setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );
  const alert = useCallback((message: string) => toast({ message, kind: 'error' }), [toast]);

  const value = useMemo<Dialogs>(
    () => ({ confirm, prompt, toast, alert }),
    [confirm, prompt, toast, alert],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {pending && <DialogHost pending={pending} onDone={() => setPending(null)} />}
      {toasts.length > 0 && (
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind ?? 'info'}`}>
              <span>{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    dismiss(t.id);
                    void t.action?.run();
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}

function DialogHost({ pending, onDone }: { pending: Pending; onDone: () => void }) {
  const [value, setValue] = useState(pending.kind === 'prompt' ? (pending.opts.initial ?? '') : '');
  const focusRef = useRef<HTMLInputElement & HTMLButtonElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      focusRef.current?.focus();
      if (focusRef.current instanceof HTMLInputElement) focusRef.current.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const cancel = () => {
    if (pending.kind === 'confirm') pending.resolve(false);
    else pending.resolve(null);
    onDone();
  };
  const ok = () => {
    if (pending.kind === 'confirm') pending.resolve(true);
    else pending.resolve(value);
    onDone();
  };
  const opts = pending.opts;
  const danger = pending.kind === 'confirm' && pending.opts.danger;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click cancels; keys are on the dialog
    <div
      className="finder-backdrop dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={opts.title ?? opts.message ?? 'Dialog'}
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
      >
        {opts.title && <div className="dialog-title">{opts.title}</div>}
        {opts.message && <div className="dialog-message">{opts.message}</div>}
        {pending.kind === 'prompt' && (
          <label className="dialog-field">
            {pending.opts.label && <span>{pending.opts.label}</span>}
            <input
              ref={focusRef}
              value={value}
              placeholder={pending.opts.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="plan-btn ghost" onClick={cancel}>
            {pending.kind === 'confirm' ? (pending.opts.cancelLabel ?? 'Cancel') : 'Cancel'}
          </button>
          <button
            type="submit"
            ref={pending.kind === 'confirm' ? focusRef : undefined}
            className={`plan-btn${danger ? ' danger' : ''}`}
          >
            {opts.confirmLabel ?? (pending.kind === 'confirm' ? 'OK' : 'Save')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function useDialogs(): Dialogs {
  const d = useContext(Ctx);
  if (!d) throw new Error('useDialogs outside DialogProvider');
  return d;
}
