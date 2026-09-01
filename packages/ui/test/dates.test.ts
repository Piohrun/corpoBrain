import { describe, expect, it } from 'vitest';
import { localISODate, monthsAgo } from '../src/dates.ts';

describe('localISODate', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // 00:30 local on 2 Sep; in any zone east of UTC toISOString() says 1 Sep
    const d = new Date(2026, 8, 2, 0, 30);
    expect(localISODate(d)).toBe('2026-09-02');
    expect(localISODate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('monthsAgo walks back whole months', () => {
    expect(monthsAgo(3, new Date(2026, 8, 1))).toBe('2026-06-01');
    expect(monthsAgo(1, new Date(2026, 0, 15))).toBe('2025-12-15');
  });
});
