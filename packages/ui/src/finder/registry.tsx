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

const Ctx = createContext<Registry | null>(null);

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

  const value = useMemo<Registry>(
    () => ({ sections, register, open, close, request, isOpen }),
    [sections, register, open, close, request, isOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFinder(): Pick<Registry, 'open' | 'close' | 'isOpen'> {
  const r = useContext(Ctx);
  if (!r) throw new Error('useFinder outside FinderProvider');
  return r;
}

export function useFinderRegistry(): Registry {
  const r = useContext(Ctx);
  if (!r) throw new Error('useFinderRegistry outside FinderProvider');
  return r;
}

/**
 * A page contributes its sections while mounted. `sections` should be memoised
 * by the caller (useMemo) so registration does not churn on every render.
 */
export function useFinderSections(owner: string, sections: FinderSection[]): void {
  // depend on the stable register function, not the whole context value —
  // otherwise every open/close re-registers, which restarts in-flight searches
  const { register } = useFinderRegistry();
  useEffect(() => register(owner, sections), [register, owner, sections]);
}
