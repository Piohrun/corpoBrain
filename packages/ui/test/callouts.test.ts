import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { calloutStyle, findCallouts } from '../src/editor/callouts.ts';

describe('callouts', () => {
  const doc = Text.of([
    '# Notes',
    '> [!warning]- Vendor risk',
    '> They may slip.',
    '> Mitigation: second supplier.',
    'plain',
    '> just a quote',
    '```',
    '> [!note] inside code',
    '```',
    '> [!Decision] ',
  ]);

  it('finds callouts with their type, fold and body lines, not quotes or code', () => {
    expect(
      findCallouts(doc).map(({ first, last, type, fold, title }) => ({
        first,
        last,
        type,
        fold,
        title,
      })),
    ).toEqual([
      { first: 2, last: 4, type: 'warning', fold: '-', title: 'Vendor risk' },
      { first: 10, last: 10, type: 'decision', fold: '', title: '' },
    ]);
    const [c] = findCallouts(doc);
    expect(doc.sliceString(c?.foldAt ?? 0, (c?.foldAt ?? 0) + 1)).toBe('-');
    expect(doc.sliceString(doc.line(2).from, c?.headEnd)).toBe('> [!warning]- ');
  });

  it('only returns callouts reaching the requested lines', () => {
    expect(findCallouts(doc, 5, 9)).toEqual([]);
    expect(findCallouts(doc, 4, 4).map((c) => c.first)).toEqual([2]);
  });

  it('maps aliases and unknown types', () => {
    expect(calloutStyle('caution').color).toBe('orange');
    expect(calloutStyle('TLDR').color).toBe('teal');
    expect(calloutStyle('whatever')).toEqual(calloutStyle('note'));
  });
});

describe('turning a selection into rich text', () => {
  it('quotes lines into a callout and highlights line by line', async () => {
    const { toCallout, toHighlight } = await import('../src/editor/callouts.ts');
    expect(toCallout('First\n\nSecond', 'warning')).toBe('> [!warning]\n> First\n>\n> Second');
    expect(toHighlight('  one two \nthree\n')).toBe('  ==one two== \n==three==\n');
  });
});
