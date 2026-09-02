import { describe, expect, it } from 'vitest';
import { boundedColumnWidth, normalizeColumnWidths } from '../src/components/resizableColumns.tsx';

describe('resizable columns', () => {
  it('keeps finite positive stored widths and ignores corrupt values', () => {
    expect(
      normalizeColumnWidths({ person: 220, sprint: Number.NaN, tiny: 0, text: '200' }),
    ).toEqual({ person: 220 });
    expect(normalizeColumnWidths(null)).toEqual({});
    expect(normalizeColumnWidths([120, 180])).toEqual({});
  });

  it('uses a default and clamps widths to the column limits', () => {
    expect(boundedColumnWidth(undefined, 180, 120, 400)).toBe(180);
    expect(boundedColumnWidth(80, 180, 120, 400)).toBe(120);
    expect(boundedColumnWidth(900, 180, 120, 400)).toBe(400);
    expect(boundedColumnWidth(260, 180, 120, 400)).toBe(260);
  });
});
