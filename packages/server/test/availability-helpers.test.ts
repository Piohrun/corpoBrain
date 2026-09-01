import { describe, expect, it } from 'vitest';
import { monthsAgo } from '../src/availability.ts';

describe('monthsAgo', () => {
  it('clamps to the shorter month instead of overflowing into the next one', () => {
    expect(monthsAgo(new Date(2026, 4, 31), 3)).toBe('2026-02-28');
    expect(monthsAgo(new Date(2026, 2, 31), 1)).toBe('2026-02-28');
    expect(monthsAgo(new Date(2026, 0, 15), 3)).toBe('2025-10-15');
  });
});
