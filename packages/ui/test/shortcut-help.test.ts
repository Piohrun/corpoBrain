import { describe, expect, it } from 'vitest';
import { mergeByLabel } from '../src/components/ShortcutHelp.tsx';
import type { Shortcut } from '../src/shortcuts.ts';

const key = (id: string, keys: string, label: string): Shortcut => ({
  id,
  keys,
  label,
  scope: 'global',
  run: () => {},
});

describe('mergeByLabel', () => {
  it('lists an action once, with every key that does it, in registry order', () => {
    expect(
      mergeByLabel([
        key('finder', 'Mod+F', 'Find'),
        key('daily', 'Mod+D', 'Open today’s daily note'),
        key('finder-alt', 'Mod+P', 'Find'),
        key('finder-alt2', 'Mod+K', 'Find'),
        key('help', 'Mod+/', 'Keyboard shortcuts'),
        key('help2', '?', 'Keyboard shortcuts'),
      ]),
    ).toEqual([
      { id: 'finder', label: 'Find', keys: ['Mod+F', 'Mod+P', 'Mod+K'] },
      { id: 'daily', label: 'Open today’s daily note', keys: ['Mod+D'] },
      { id: 'help', label: 'Keyboard shortcuts', keys: ['Mod+/', '?'] },
    ]);
  });
});
