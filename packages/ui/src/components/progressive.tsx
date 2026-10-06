import { type RefObject, useEffect, useRef, useState } from 'react';

/**
 * The nearest ancestor that actually scrolls vertically (the page itself when
 * none does). `overflow-x: auto` alone also computes `overflow-y: auto`, so a
 * horizontally scrolling wrapper only counts if its content is taller than it.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight + 1)
      return at;
  }
  return null;
}

/**
 * Progressive rendering for long lists: start with `step` items and add
 * another `step` whenever the sentinel (render it after the shown items while
 * `shown < total`) comes within reach of the scroll box. Thousands of rows
 * otherwise get built, styled and laid out before anything is on screen.
 * `resetKey` (e.g. the filter) starts over from the top.
 */
export function useProgressive(
  total: number,
  step = 200,
  resetKey: unknown = null,
): { shown: number; sentinel: RefObject<HTMLElement | null> } {
  const [shown, setShown] = useState(step);
  const sentinel = useRef<HTMLElement | null>(null);
  const lastReset = useRef(resetKey);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    if (shown !== step) setShown(step);
  }
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => n + step);
      },
      { root: scrollParent(el), rootMargin: '800px' },
    );
    io.observe(el);
    return () => io.disconnect();
  });
  return { shown: Math.min(shown, total), sentinel };
}
