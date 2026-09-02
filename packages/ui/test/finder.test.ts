import { describe, expect, it } from 'vitest';
import { rankBy, scoreMatch, splitMatches } from '../src/finder/match.ts';
import { keyLabel, matchesChord } from '../src/shortcuts.ts';

describe('scoreMatch / rankBy', () => {
  it('orders exact, prefix, word start, substring, multi-term', () => {
    const rows = [
      'Gateway',
      'Gateway architecture',
      'API gateway',
      'the-gateway-notes',
      'Gate Away',
    ];
    const ranked = rankBy(rows, 'gateway', (r) => [r]).map((r) => r.row);
    expect(ranked).toEqual(['Gateway', 'Gateway architecture', 'API gateway', 'the-gateway-notes']);
    expect(scoreMatch('gw arch', 'Gateway architecture')).toBeNull(); // not a word start for "gw"
    expect(scoreMatch('gate arch', 'Gateway architecture')).toBe(4);
    expect(scoreMatch('', 'anything')).toBe(100);
    expect(scoreMatch('zzz', 'Gateway')).toBeNull();
  });

  it('prefers title hits over path hits at equal quality', () => {
    const rows = [
      { title: 'Daily', path: 'daily/2026-09-01.md' },
      { title: 'Standup', path: 'daily/standup.md' },
    ];
    const ranked = rankBy(rows, 'daily', (r) => [r.title, r.path]).map((r) => r.row.title);
    expect(ranked[0]).toBe('Daily');
  });

  it('splits text around every query term for highlighting', () => {
    expect(splitMatches('Meet Anna about Anna', 'anna')).toEqual([
      { text: 'Meet ', hit: false },
      { text: 'Anna', hit: true },
      { text: ' about ', hit: false },
      { text: 'Anna', hit: true },
    ]);
    expect(splitMatches('plain', '')).toEqual([{ text: 'plain', hit: false }]);
  });
});

describe('shortcuts', () => {
  const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent;
  it('matches modifier chords exactly and ignores unrelated modifiers', () => {
    expect(
      matchesChord(
        ev({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }),
        'Mod+F',
      ),
    ).toBe(true);
    expect(
      matchesChord(
        ev({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }),
        'Mod+F',
      ),
    ).toBe(false);
    expect(
      matchesChord(
        ev({ key: 'F', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }),
        'Mod+Shift+F',
      ),
    ).toBe(true);
    expect(
      matchesChord(
        ev({ key: '?', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }),
        '?',
      ),
    ).toBe(true);
    expect(
      matchesChord(
        ev({ key: 'ArrowLeft', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false }),
        'Alt+ArrowLeft',
      ),
    ).toBe(true);
  });
  it('labels keys for the help overlay', () => {
    expect(keyLabel('g p')).toMatch(/G then P/);
    expect(keyLabel('Mod+/')).toMatch(/\/$/);
  });
});
