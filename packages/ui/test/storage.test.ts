import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lsGet, lsJson, lsSet, lsSetJson } from '../src/storage.ts';

function fakeStorage(throwing = false) {
  const m = new Map<string, string>();
  const boom = () => {
    throw new Error('blocked');
  };
  return {
    getItem: throwing ? boom : (k: string) => m.get(k) ?? null,
    setItem: throwing ? boom : (k: string, v: string) => void m.set(k, v),
    removeItem: throwing ? boom : (k: string) => void m.delete(k),
  };
}

describe('storage helpers', () => {
  const g = globalThis as { localStorage?: unknown };
  let saved: unknown;
  beforeEach(() => {
    saved = g.localStorage;
  });
  afterEach(() => {
    g.localStorage = saved;
  });

  it('round-trips strings and JSON, removes on null', () => {
    g.localStorage = fakeStorage();
    lsSet('a', 'x');
    expect(lsGet('a')).toBe('x');
    lsSet('a', null);
    expect(lsGet('a', 'dflt')).toBe('dflt');
    lsSetJson('j', { n: 1 });
    expect(lsJson('j', { n: 0 })).toEqual({ n: 1 });
    lsSet('j', '{not json');
    expect(lsJson('j', { n: 0 })).toEqual({ n: 0 });
  });

  it('never throws when storage is blocked', () => {
    g.localStorage = fakeStorage(true);
    expect(() => lsSet('a', 'x')).not.toThrow();
    expect(lsGet('a', 'dflt')).toBe('dflt');
    expect(lsJson('a', [])).toEqual([]);
  });
});
