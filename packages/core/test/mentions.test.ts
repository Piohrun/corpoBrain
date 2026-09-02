import { describe, expect, it } from 'vitest';
import { findMentions, linkMention } from '../src/mentions.ts';

describe('findMentions', () => {
  const doc = [
    '---',
    'title: Gateway',
    '---',
    '# Gateway notes',
    'The gateway is slow. See [[Gateway]] and [gateway docs](http://x/gateway).',
    '`gateway` in code, and https://example.com/gateway too.',
    '```',
    'gateway inside a fence',
    '```',
    'Gateways plural, and the Gateway again.',
  ].join('\n');

  it('finds whole-word, case-insensitive mentions outside links, code and frontmatter', () => {
    const m = findMentions(doc, ['Gateway']);
    expect(m.map((x) => [x.line, x.name])).toEqual([
      [4, 'Gateway'],
      [5, 'gateway'],
      [10, 'Gateway'],
    ]);
  });

  it('links one mention, keeping the written form as the alias when it differs', () => {
    const [heading, lower] = findMentions(doc, ['Gateway']);
    expect(linkMention(doc, lower as NonNullable<typeof lower>, 'Gateway')).toContain(
      'The [[Gateway|gateway]] is slow.',
    );
    expect(linkMention(doc, heading as NonNullable<typeof heading>, 'Gateway')).toContain(
      '# [[Gateway]] notes',
    );
  });

  it('ignores short or empty names and matches aliases', () => {
    expect(findMentions(doc, ['', 'G'])).toEqual([]);
    expect(findMentions('the GW is fine', ['Gateway', 'GW']).map((x) => x.name)).toEqual(['GW']);
  });
});
