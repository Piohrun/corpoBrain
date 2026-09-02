import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { externalLinksInText, normalizeExternalHref } from '../src/editor/externalLinks.ts';
import { wikilinkCompletionReplaceTo } from '../src/editor/setup.ts';

describe('external Markdown links', () => {
  it('recognises labeled links, autolinks, bare URLs, www links, and email addresses', () => {
    const text = [
      '[Docs](https://example.com/guide "Guide")',
      '<https://example.org/path>',
      'www.example.net/help',
      'owner@example.com',
    ].join(' ');
    const links = externalLinksInText(text);

    expect(links.map((link) => link.kind)).toEqual(['markdown', 'autolink', 'bare', 'bare']);
    expect(links.map((link) => text.slice(link.labelFrom, link.labelTo))).toEqual([
      'Docs',
      'https://example.org/path',
      'www.example.net/help',
      'owner@example.com',
    ]);
    expect(links.map((link) => link.href)).toEqual([
      'https://example.com/guide',
      'https://example.org/path',
      'https://www.example.net/help',
      'mailto:owner@example.com',
    ]);
  });

  it('does not turn local links, images, code, or unsafe protocols into external links', () => {
    const text = [
      '[local](notes/team.md)',
      '![image](https://example.com/image.png)',
      '`https://example.com/in-code`',
      '[unsafe](javascript:alert(1))',
    ].join(' ');

    expect(externalLinksInText(text)).toEqual([]);
    expect(normalizeExternalHref('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalHref('file:///etc/passwd')).toBeNull();
  });
});

describe('wikilink completion', () => {
  it('replaces the closing pair inserted by closeBrackets', () => {
    const state = EditorState.create({ doc: '[[pay]]' });
    const from = 2;
    const cursor = 5;
    const insert = 'Payments]]';
    const transaction = state.update({
      changes: {
        from,
        to: wikilinkCompletionReplaceTo(state, cursor),
        insert,
      },
    });

    expect(transaction.state.doc.toString()).toBe('[[Payments]]');
  });

  it('adds a closing pair when the opener was pasted without one', () => {
    const state = EditorState.create({ doc: '[[pay' });
    expect(wikilinkCompletionReplaceTo(state, state.doc.length)).toBe(state.doc.length);
  });
});
