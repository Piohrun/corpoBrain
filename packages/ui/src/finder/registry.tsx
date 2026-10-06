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
import type { FinderRequest, FinderSection } from './types.ts';

interface Registry {
  sections: FinderSection[];
  register: (owner: string, sections: FinderSection[]) => () => void;
  open: (req?: FinderRequest) => void;
  close: () => void;
  request: FinderRequest | null;
  isOpen: boolean;
}

interface Actions {
  register: Registry['register'];
  open: Registry['open'];
  close: Registry['close'];
}

/**
 * Two contexts: the actions never change, so pages that only register sections
 * or open the Finder do not re-render when it opens, closes or gains sections.
 */
const ActionsCtx = createContext<Actions | null>(null);
const StateCtx = createContext<Registry | null>(null);

/** Holds every section the mounted pages contribute, and the open/close state. */
export function FinderProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<string, FinderSection[]>());
  const [version, setVersion] = useState(0);
  const [request, setRequest] = useState<FinderRequest | null>(null);
  const [isOpen, setOpen] = useState(false);

  const register = useCallback((owner: string, sections: FinderSection[]) => {
    owners.current.set(owner, sections);
    setVersion((v) => v + 1);
    return () => {
      if (owners.current.get(owner) === sections) {
        owners.current.delete(owner);
        setVersion((v) => v + 1);
      }
    };
  }, []);

  const open = useCallback((req: FinderRequest = {}) => {
    setRequest(req);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the invalidation signal for the owners map
  const sections = useMemo(
    () => [...owners.current.values()].flat().sort((a, b) => a.order - b.order),
    [version],
  );

  const actions = useMemo<Actions>(() => ({ register, open, close }), [register, open, close]);
  const value = useMemo<Registry>(
    () => ({ sections, register, open, close, request, isOpen }),
    [sections, register, open, close, request, isOpen],
  );
  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={value}>{children}</StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

/** open/close/register — stable for the life of the app. */
export function useFinderActions(): Actions {
  const r = useContext(ActionsCtx);
  if (!r) throw new Error('useFinderActions outside FinderProvider');
  return r;
}

/** Actions plus whether the Finder is open (re-renders on open/close). */
export function useFinder(): Pick<Registry, 'open' | 'close' | 'isOpen'> {
  const r = useContext(StateCtx);
  if (!r) throw new Error('useFinder outside FinderProvider');
  return r;
}

export function useFinderRegistry(): Registry {
  const r = useContext(StateCtx);
  if (!r) throw new Error('useFinderRegistry outside FinderProvider');
  return r;
}

/**
 * A page contributes its sections while mounted. `sections` should be memoised
 * by the caller (useMemo) so registration does not churn on every render.
 */
export function useFinderSections(owner: string, sections: FinderSection[]): void {
  // the stable actions context: registering must not re-render the caller
  const { register } = useFinderActions();
  useEffect(() => register(owner, sections), [register, owner, sections]);
}
