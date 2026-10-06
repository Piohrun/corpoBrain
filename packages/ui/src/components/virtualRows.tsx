import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { scrollParent } from './progressive.tsx';

/**
 * Row virtualization for long grids (Planning's bandwidth grid, the
 * Availability month): only rows near the visible part of the scroll box are
 * in the DOM, with padding above and below standing in for the rest. Rows may
 * differ in height; each rendered row is measured and the estimate is only
 * used for rows never seen.
 *
 * Usage: render `<Spacer ref={anchorRef} height={padTop}/>`, then
 * `keys.slice(start, end)` with `ref={measure(key)}`, then a spacer of
 * `padBottom`. The top spacer is the anchor: its top is row 0's top.
 *
 * Rows that are not rendered cannot be found with querySelector: to bring
 * one into view use `revealRow(list, key)`.
 */
export function revealRow(list: string, key: string): void {
  window.dispatchEvent(new CustomEvent('cb:reveal-row', { detail: { list, key } }));
}

interface Options {
  /** name for revealRow() */
  list: string;
  keys: string[];
  /** px for rows not measured yet */
  estimate: number;
  /** px rendered beyond the visible area on each side */
  overscan?: number;
  /** after revealRow() brought a row on screen (e.g. flash it) */
  onRevealed?: (key: string) => void;
}

export function useVirtualRows({ list, keys, estimate, overscan = 600, onRevealed }: Options) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const [measuredVersion, setMeasuredVersion] = useState(0);
  const [view, setView] = useState({ top: 0, bottom: 1600 });

  // one ResizeObserver for every rendered row
  const keyOf = useRef(new WeakMap<Element, string>());
  const observer = useRef<ResizeObserver | null>(null);
  const pending = useRef(0);
  if (!observer.current && typeof ResizeObserver !== 'undefined') {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const key = keyOf.current.get(e.target);
        if (key === undefined) continue;
        const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
        if (h > 0 && Math.abs((heights.current.get(key) ?? -1) - h) > 0.5) {
          heights.current.set(key, h);
          changed = true;
        }
      }
      if (changed && !pending.current)
        pending.current = requestAnimationFrame(() => {
          pending.current = 0;
          setMeasuredVersion((v) => v + 1);
        });
    });
  }
  useEffect(
    () => () => {
      observer.current?.disconnect();
      if (pending.current) cancelAnimationFrame(pending.current);
    },
    [],
  );

  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const measure = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      let current: HTMLElement | null = null;
      ref = (el: HTMLElement | null) => {
        if (current) observer.current?.unobserve(current);
        current = el;
        if (el) {
          keyOf.current.set(el, key);
          observer.current?.observe(el);
        }
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);

  // offsets[i] = top of row i; offsets[n] = total height
  // biome-ignore lint/correctness/useExhaustiveDependencies: measuredVersion signals new heights in the ref
  const offsets = useMemo(() => {
    const out = new Float64Array(keys.length + 1);
    for (let i = 0; i < keys.length; i++)
      out[i + 1] = (out[i] as number) + (heights.current.get(keys[i] as string) ?? estimate);
    return out;
  }, [keys, estimate, measuredVersion]);

  // where the scroll box shows the rows, in the rows' own coordinates
  const scroller = useRef<HTMLElement | null>(null);
  const update = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const box = scroller.current;
    const boxTop = box ? box.getBoundingClientRect().top : 0;
    const boxHeight = box ? box.clientHeight : window.innerHeight;
    const top = boxTop - anchor.getBoundingClientRect().top;
    setView((v) =>
      Math.abs(v.top - top) < 1 && Math.abs(v.bottom - (top + boxHeight)) < 1
        ? v
        : { top, bottom: top + boxHeight },
    );
  }, []);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    scroller.current = scrollParent(anchor) ?? anchor.closest<HTMLElement>('.planning-scroll');
    const target: HTMLElement | Window = scroller.current ?? window;
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
    };
    update();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [update]);

  // the scroll box can also move because content above the grid changed
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check after every list/height change
  useLayoutEffect(update, [keys, measuredVersion]);

  const n = keys.length;
  const first = (y: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offsets[mid + 1] as number) <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const start = Math.min(n, first(view.top - overscan));
  const end = Math.min(n, first(view.bottom + overscan) + 1);
  const total = offsets[n] as number;

  // revealRow(): scroll the row to the middle, then let the page flash it
  const latest = useRef({ keys, offsets, onRevealed });
  latest.current = { keys, offsets, onRevealed };
  useEffect(() => {
    const onReveal = (e: Event) => {
      const { list: target, key } = (e as CustomEvent<{ list: string; key: string }>).detail;
      if (target !== list) return;
      const { keys: ks, offsets: off, onRevealed: done } = latest.current;
      const i = ks.indexOf(key);
      const anchor = anchorRef.current;
      if (i < 0 || !anchor) return;
      const box = scroller.current;
      const rowTop = off[i] as number;
      const rowHeight = (off[i + 1] as number) - rowTop;
      const boxHeight = box ? box.clientHeight : window.innerHeight;
      const anchorTop =
        anchor.getBoundingClientRect().top - (box ? box.getBoundingClientRect().top : 0);
      const delta = anchorTop + rowTop - (boxHeight - rowHeight) / 2;
      if (box) box.scrollTop += delta;
      else window.scrollBy(0, delta);
      update();
      // the row exists after the next render
      requestAnimationFrame(() => requestAnimationFrame(() => done?.(key)));
    };
    window.addEventListener('cb:reveal-row', onReveal);
    return () => window.removeEventListener('cb:reveal-row', onReveal);
  }, [list, update]);

  return {
    anchorRef: anchorRef as RefObject<HTMLElement | null>,
    measure,
    start,
    end,
    padTop: offsets[start] as number,
    padBottom: total - (offsets[end] as number),
  };
}
