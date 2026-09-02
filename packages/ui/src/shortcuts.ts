/**
 * One keyboard model for the whole app.
 *
 * - Chords like `Mod+F` fire everywhere, including inside inputs and the
 *   editor (the editor's own keymap gets first pick and forwards what it
 *   does not use).
 * - Bare keys (`?`) and `g`-sequences (`g p` = go to Planning) only fire when
 *   nothing is being typed, so they never eat text.
 * - Every binding lives in one list with a label and a scope, and the help
 *   overlay (`?` / Ctrl+/) is rendered from that list — nothing is documented
 *   by hand.
 */
export type ShortcutScope = 'global' | 'navigate' | 'notes' | 'editor' | 'finder' | 'lists';

export interface Shortcut {
  id: string;
  /** 'Mod+F', 'Alt+ArrowLeft', 'g p' (sequence), '?' */
  keys: string;
  label: string;
  scope: ShortcutScope;
  /** fire even while typing in an input/editor (only sensible for modifier chords) */
  inInputs?: boolean;
  /** documented only: handled elsewhere (CodeMirror keymap) */
  passive?: boolean;
  when?: () => boolean;
  run?: (e: KeyboardEvent) => void;
}

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Human label for the help overlay and hints: Mod → ⌘ or Ctrl. */
export function keyLabel(keys: string): string {
  return keys
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((k) =>
          k === 'Mod'
            ? isMac
              ? '⌘'
              : 'Ctrl'
            : k === 'Alt'
              ? isMac
                ? '⌥'
                : 'Alt'
              : k === 'Shift'
                ? '⇧'
                : k === 'ArrowLeft'
                  ? '←'
                  : k === 'ArrowRight'
                    ? '→'
                    : k === 'ArrowUp'
                      ? '↑'
                      : k === 'ArrowDown'
                        ? '↓'
                        : k.length === 1
                          ? k.toUpperCase()
                          : k,
        )
        .join(isMac ? '' : '+'),
    )
    .join(' then ');
}

/** Does this keydown match a single chord like 'Mod+Shift+F'? */
export function matchesChord(e: KeyboardEvent, chord: string): boolean {
  const parts = chord.split('+');
  const key = parts[parts.length - 1] as string;
  const want = {
    mod: parts.includes('Mod'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
  };
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod !== want.mod || e.altKey !== want.alt) return false;
  // Shift is significant for letters; for symbols like '?' it is part of the key itself
  if (key.length === 1 && /[a-z]/i.test(key)) {
    if (e.shiftKey !== want.shift) return false;
    return e.key.toLowerCase() === key.toLowerCase();
  }
  return e.key === key || e.key === key.replace('Arrow', '');
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable ||
    el.closest('.cm-editor') !== null
  );
}

/**
 * Install the global dispatcher. Returns the uninstall function. Sequences
 * ('g p') keep a pending first key for 900 ms; the help overlay shows the
 * pending state through `onPending`.
 */
export function installShortcuts(
  get: () => Shortcut[],
  onPending?: (key: string | null) => void,
): () => void {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearPending = () => {
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
    onPending?.(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const typing = isTypingTarget(e.target);
    const list = get().filter((s) => !s.passive && s.run && (!s.when || s.when()));
    // second key of a sequence
    if (pending && !typing) {
      const seq = `${pending} ${e.key.toLowerCase()}`;
      clearPending();
      const hit = list.find((s) => s.keys.includes(' ') && s.keys === seq);
      if (hit) {
        e.preventDefault();
        hit.run?.(e);
      }
      return;
    }
    for (const s of list) {
      if (s.keys.includes(' ')) {
        // sequence start: a bare key while not typing
        const first = s.keys.split(' ')[0] as string;
        if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === first) {
          e.preventDefault();
          pending = first;
          onPending?.(first);
          timer = setTimeout(clearPending, 900);
          return;
        }
        continue;
      }
      const chord = s.keys.includes('+');
      if (typing && !s.inInputs) continue;
      if (!chord && (e.ctrlKey || e.metaKey || e.altKey)) continue;
      if (matchesChord(e, s.keys)) {
        e.preventDefault();
        e.stopPropagation();
        s.run?.(e);
        return;
      }
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    clearPending();
  };
}
