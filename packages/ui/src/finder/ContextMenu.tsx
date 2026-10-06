/**
 * Context menu: right-click (or the Menu key / Shift+F10) on anything shows the
 * actions the Finder already offers for it. There is no second list of
 * commands — a target names a Finder section and an item, and the menu runs
 * that section's actions, so right-click and Ctrl+K always agree.
 *
 * Targets come from:
 * - elements carrying `data-ctx-section` + `data-ctx-id` (any section with a
 *   `resolve`), and `data-path` / `data-quick-path` rows (notes);
 * - the editor, which hands over ready-made items for the link, selection,
 *   task line or table under the cursor (see Editor.tsx).
 * Shift+right-click keeps the browser's own menu (spellcheck, paste).
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { keyLabel } from '../shortcuts.ts';
import { useFinderActions, useFinderRegistry } from './registry.tsx';
import type { FinderAction, FinderItem, FinderSection } from './types.ts';

/** A thing to act on: a section plus either an id it can resolve or the item itself. */
export interface ContextTarget {
  section: string;
  id?: string;
  item?: FinderItem;
}

/** Supplies targets for a region the DOM attributes cannot describe (the editor). */
export type ContextProvider = (where: {
  event?: MouseEvent;
  keyboard?: boolean;
}) => { targets: ContextTarget[]; x: number; y: number } | null;

interface Group {
  key: string;
  title: string;
  section: FinderSection;
  item: FinderItem;
  actions: FinderAction[];
}

interface MenuState {
  x: number;
  y: number;
  groups: Group[];
  /** focus goes back here when the menu closes without running anything */
  returnFocus: HTMLElement | null;
}

interface Api {
  /** show the menu for these targets at a viewport point */
  openAt: (x: number, y: number, targets: ContextTarget[]) => boolean;
  /** register a provider for a DOM subtree (matched with `contains`) */
  provide: (root: HTMLElement, provider: ContextProvider) => () => void;
}

const Ctx = createContext<Api | null>(null);

export function useContextMenu(): Api {
  const api = useContext(Ctx);
  if (!api) throw new Error('useContextMenu outside ContextMenuProvider');
  return api;
}

/** Attributes that make an element a context-menu target. */
export function ctxTarget(section: string, id: string): Record<string, string> {
  return { 'data-ctx-section': section, 'data-ctx-id': id };
}

/** Targets described by the element under the pointer and its ancestors, innermost first. */
function domTargets(start: Element | null): ContextTarget[] {
  const out: ContextTarget[] = [];
  const seen = new Set<string>();
  for (let el: Element | null = start; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const { ctxSection, ctxId, path, quickPath } = el.dataset;
    const pairs: [string, string | undefined][] = [
      [ctxSection ?? '', ctxId],
      ['notes', path ?? quickPath],
    ];
    for (const [section, id] of pairs) {
      if (!section || !id) continue;
      const key = `${section}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ section, id });
    }
  }
  return out;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const registry = useFinderRegistry();
  const finder = useFinderActions();
  const sectionsRef = useRef(registry.sections);
  sectionsRef.current = registry.sections;
  const providers = useRef(new Map<HTMLElement, ContextProvider>());
  const [menu, setMenu] = useState<MenuState | null>(null);

  const openAt = useCallback((x: number, y: number, targets: ContextTarget[]) => {
    const byId = new Map(sectionsRef.current.map((s) => [s.id, s]));
    const groups: Group[] = [];
    for (const t of targets) {
      const section = byId.get(t.section);
      if (!section) continue;
      const item = t.item ?? (t.id !== undefined ? section.resolve?.(t.id) : null);
      if (!item) continue;
      const actions = section.actions.filter((a) => !a.when || a.when([item]));
      const key = `${section.id}:${item.id}`;
      if (!actions.length || groups.some((g) => g.key === key)) continue;
      groups.push({
        key,
        title: section.contextOnly ? section.title : `${section.title} · ${item.label}`,
        section,
        item,
        actions,
      });
    }
    if (!groups.length) return false;
    const active = document.activeElement;
    setMenu({ x, y, groups, returnFocus: active instanceof HTMLElement ? active : null });
    return true;
  }, []);

  const provide = useCallback((root: HTMLElement, provider: ContextProvider) => {
    providers.current.set(root, provider);
    return () => {
      if (providers.current.get(root) === provider) providers.current.delete(root);
    };
  }, []);

  // One listener for the whole app; regions with a provider answer first.
  useEffect(() => {
    const fromProvider = (node: Node | null, where: Parameters<ContextProvider>[0]) => {
      for (const [root, provider] of providers.current)
        if (node && root.contains(node)) return provider(where);
      return undefined;
    };
    const onContextMenu = (e: MouseEvent) => {
      if (e.shiftKey) return; // the browser's own menu
      const target = e.target instanceof Element ? e.target : null;
      const provided = fromProvider(target, { event: e });
      const targets = [...(provided?.targets ?? []), ...domTargets(target)];
      if (openAt(e.clientX, e.clientY, targets)) e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const isMenuKey = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
      if (!isMenuKey) return;
      const active = document.activeElement;
      const provided = fromProvider(active, { keyboard: true });
      let x = 0;
      let y = 0;
      let targets: ContextTarget[] = [];
      if (provided) {
        ({ x, y } = provided);
        targets = provided.targets;
      } else if (active instanceof HTMLElement) {
        const rect = active.getBoundingClientRect();
        x = rect.left + 12;
        y = rect.bottom - 4;
      }
      targets = [...targets, ...domTargets(active)];
      if (openAt(x, y, targets)) e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [openAt]);

  const api = useMemo<Api>(() => ({ openAt, provide }), [openAt, provide]);

  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;
  const close = useCallback((restore: boolean) => {
    const open = menuRef.current;
    setMenu(null);
    if (restore) open?.returnFocus?.focus();
  }, []);

  const run = useCallback(
    async (group: Group, action: FinderAction) => {
      setMenu(null);
      const result = await action.run([group.item], {
        query: '',
        close: () => {},
        context: {},
      });
      // an action that needs a second choice (move to sprint…) continues in the Finder
      if (result && typeof result === 'object' && 'pick' in result)
        finder.open({ followUp: result.pick });
    },
    [finder],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {menu && <Menu state={menu} onClose={close} onRun={run} />}
    </Ctx.Provider>
  );
}

function Menu({
  state,
  onClose,
  onRun,
}: {
  state: MenuState;
  onClose: (restoreFocus: boolean) => void;
  onRun: (group: Group, action: FinderAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const flat = useMemo(
    () => state.groups.flatMap((g) => g.actions.map((a) => ({ group: g, action: a }))),
    [state.groups],
  );
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // Keep the menu on screen, and take focus so the keyboard drives it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(state.x, window.innerWidth - r.width - 4));
    const top =
      state.y + r.height > window.innerHeight - 4 ? Math.max(4, state.y - r.height) : state.y;
    setPos({ left, top });
    el.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    const away = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose(false);
    };
    const gone = () => onClose(false);
    document.addEventListener('mousedown', away, true);
    document.addEventListener('wheel', gone, { passive: true, capture: true });
    window.addEventListener('resize', gone);
    window.addEventListener('blur', gone);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('wheel', gone, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('blur', gone);
    };
  }, [onClose]);

  // Keys are taken at the document while the menu is open: the editor can
  // win focus back after a right-click, and must not see these keys anyway.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = flat.length;
      if (e.key === 'ArrowDown') setCursor((c) => (c + 1) % n);
      else if (e.key === 'ArrowUp') setCursor((c) => (c - 1 + n) % n);
      else if (e.key === 'Home') setCursor(0);
      else if (e.key === 'End') setCursor(n - 1);
      else if (e.key === 'Escape' || e.key === 'Tab') onClose(true);
      else if (e.key === 'Enter' || e.key === ' ') {
        const row = flat[cursorRef.current];
        if (row) onRun(row.group, row.action);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [flat, onClose, onRun]);

  let index = -1;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.groups.map((g) => (
        <section key={g.key} className="ctx-group" aria-label={g.title}>
          <div className="ctx-title" title={g.title}>
            {g.title}
          </div>
          {g.actions.map((a) => {
            index++;
            const i = index;
            return (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`ctx-item${i === cursor ? ' active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onRun(g, a)}
              >
                <span>{a.label}</span>
                {a.keys && <kbd>{keyLabel(a.keys)}</kbd>}
              </button>
            );
          })}
        </section>
      ))}
      <div className="ctx-foot">
        <kbd>⇧</kbd> right-click for the browser menu
      </div>
    </div>
  );
}
