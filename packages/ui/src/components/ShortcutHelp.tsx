import { keyLabel, type Shortcut, type ShortcutScope } from '../shortcuts.ts';

const SCOPE_LABEL: Record<ShortcutScope, string> = {
  global: 'Anywhere',
  navigate: 'Go to (press g, then a letter)',
  notes: 'Notes',
  editor: 'In the editor',
  finder: 'In the Finder',
  lists: 'In lists and trees',
};

/**
 * One row per thing a key does: several bindings of the same action (Ctrl+F,
 * Ctrl+P and Ctrl+K all open Find) share a row instead of repeating it.
 */
export function mergeByLabel(
  shortcuts: readonly Shortcut[],
): { id: string; label: string; keys: string[] }[] {
  const rows = new Map<string, { id: string; label: string; keys: string[] }>();
  for (const k of shortcuts) {
    const row = rows.get(k.label);
    if (row) row.keys.push(k.keys);
    else rows.set(k.label, { id: k.id, label: k.label, keys: [k.keys] });
  }
  return [...rows.values()];
}

/** Rendered from the shortcut registry, so it can never drift from the bindings. */
export function ShortcutHelp({
  shortcuts,
  onClose,
}: {
  shortcuts: Shortcut[];
  onClose: () => void;
}) {
  const scopes = (Object.keys(SCOPE_LABEL) as ShortcutScope[]).filter((s) =>
    shortcuts.some((k) => k.scope === s),
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; Escape is a global shortcut
    <div
      className="finder-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="finder help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="help-head">
          <b>Keyboard shortcuts</b>
          <span className="spacer" />
          <button type="button" className="row-del" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="help-cols">
          {scopes.map((scope) => (
            <section key={scope} className="help-scope">
              <h3>{SCOPE_LABEL[scope]}</h3>
              {mergeByLabel(shortcuts.filter((k) => k.scope === scope)).map((row) => (
                <div key={row.id} className="help-row">
                  <span>{row.label}</span>
                  <span className="help-keys">
                    {row.keys.map((keys) => (
                      <kbd key={keys}>{keyLabel(keys)}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="finder-foot">
          <span>
            <kbd>?</kbd> or <kbd>{keyLabel('Mod+/')}</kbd> toggles this list · bare keys only work
            when you are not typing
          </span>
        </div>
      </div>
    </div>
  );
}
