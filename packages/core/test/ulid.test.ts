import { describe, expect, it } from 'vitest';
import { generateUlid, SPEC_VERSION } from '../src/index.ts';

describe('core scaffold', () => {
  it('exposes the spec version', () => {
    expect(SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('generates 26-char Crockford ULIDs that sort by time', () => {
    const a = generateUlid(1_000_000);
    const b = generateUlid(2_000_000);
    expect(a).toHaveLength(26);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
