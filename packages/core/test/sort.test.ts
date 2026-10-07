import { describe, expect, it } from 'vitest';
import { naturalCompare } from '../src/sort.ts';

describe('natural order', () => {
  it('compares numbers by value, ignores case, and stays total', () => {
    expect(['Pod 10', 'pod 2', 'Pod 1', 'Pod 016'].sort(naturalCompare)).toEqual([
      'Pod 1',
      'pod 2',
      'Pod 10',
      'Pod 016',
    ]);
    expect(['EXEC-100', 'EXEC-9', 'EXEC-10'].sort(naturalCompare)).toEqual([
      'EXEC-9',
      'EXEC-10',
      'EXEC-100',
    ]);
    expect(naturalCompare('anna', 'Anna')).not.toBe(0);
    expect(['Łukasz', 'Zoe', 'Adam'].sort(naturalCompare)).toEqual(['Adam', 'Łukasz', 'Zoe']);
  });
});
