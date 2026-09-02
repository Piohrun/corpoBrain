import { useCallback, useEffect, useRef, useState } from 'react';
import { lsJson, lsSetJson } from '../storage.ts';

export type ColumnWidths = Record<string, number>;

/** Keep malformed or hand-edited localStorage values from breaking a layout. */
export function normalizeColumnWidths(value: unknown): ColumnWidths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const widths: ColumnWidths = {};
  for (const [key, width] of Object.entries(value)) {
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) widths[key] = width;
  }
  return widths;
}

export function boundedColumnWidth(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value ?? fallback));
}

export function usePersistentColumnWidths(storageKey: string) {
  const [widths, setWidths] = useState<ColumnWidths>(() =>
    normalizeColumnWidths(lsJson<unknown>(storageKey, {})),
  );

  useEffect(() => lsSetJson(storageKey, widths), [storageKey, widths]);

  const setWidth = useCallback((key: string, width: number) => {
    setWidths((current) => ({ ...current, [key]: Math.round(width) }));
  }, []);

  const resetWidth = useCallback((key: string) => {
    setWidths((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const resetAll = useCallback(() => setWidths({}), []);

  return { widths, setWidth, resetWidth, resetAll };
}

export function ColumnResizeHandle({
  label,
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const resize = (next: number) => onResize(boundedColumnWidth(next, width, min, max));

  return (
    <hr
      className="column-resizer"
      aria-label={`Resize ${label} column`}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title={`Drag to resize ${label}. Double-click to reset.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || event.pointerId !== drag.current.pointerId) return;
        resize(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          const step = event.shiftKey ? 25 : 10;
          resize(width + (event.key === 'ArrowLeft' ? -step : step));
        } else if (event.key === 'Home') {
          event.preventDefault();
          event.stopPropagation();
          onReset();
        }
      }}
    />
  );
}
