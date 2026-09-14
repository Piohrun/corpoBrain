import { describe, expect, it } from 'vitest';
import {
  emptyPreview,
  previewBody,
  previewPath,
  previewReducer as reduce,
} from '../src/preview-state.ts';

describe('context previews', () => {
  it('keeps a pinned note while following links in the second pane', () => {
    let state = reduce(emptyPreview, { type: 'open', path: 'people/Alex.md' });
    state = reduce(state, { type: 'pin' });
    state = reduce(state, { type: 'open', path: 'jira/API-1.md' });
    state = reduce(state, { type: 'open', path: 'jira/API-2.md' });
    expect(state.pinned).toBe('people/Alex.md');
    expect(previewPath(state)).toBe('jira/API-2.md');
    state = reduce(state, { type: 'back' });
    expect(previewPath(state)).toBe('jira/API-1.md');
    expect(previewPath(reduce(state, { type: 'forward' }))).toBe('jira/API-2.md');
  });

  it('does not duplicate either visible note or keep an abandoned forward trail', () => {
    let state = reduce(emptyPreview, { type: 'open', path: 'a' });
    expect(reduce(state, { type: 'open', path: 'a' })).toBe(state);
    state = reduce(state, { type: 'pin' });
    expect(reduce(state, { type: 'open', path: 'a' })).toBe(state);
    for (const path of ['b', 'c']) state = reduce(state, { type: 'open', path });
    state = reduce(state, { type: 'back' });
    state = reduce(state, { type: 'open', path: 'd' });
    expect(state.history).toEqual(['b', 'd']);
    expect(previewPath(reduce(state, { type: 'forward' }))).toBe('d');
  });

  it('unpins a single note without closing it; closing the reference really removes it', () => {
    const pinned = reduce(reduce(emptyPreview, { type: 'open', path: 'a' }), { type: 'pin' });
    const unpinned = reduce(pinned, { type: 'unpin' });
    expect(unpinned.pinned).toBeNull();
    expect(previewPath(unpinned)).toBe('a');
    expect(reduce(pinned, { type: 'close-pinned' })).toEqual(emptyPreview);
    const pair = reduce(pinned, { type: 'open', path: 'b' });
    expect(previewPath(reduce(pair, { type: 'unpin' }))).toBe('b');
    expect(reduce(pair, { type: 'close' })).toEqual(emptyPreview);
  });

  it('bounds history and handles back/forward on an empty dock', () => {
    let state = emptyPreview;
    for (let i = 0; i < 45; i++) state = reduce(state, { type: 'open', path: String(i) });
    expect(state.history).toHaveLength(30);
    expect(previewPath(state)).toBe('44');
    expect(reduce(emptyPreview, { type: 'back' })).toEqual(emptyPreview);
    expect(reduce(emptyPreview, { type: 'forward' })).toEqual(emptyPreview);
  });

  it('hides only the frontmatter and preserves code, links, and encryption tokens', () => {
    const body = '# Heading\n[[Alex]]\n```secret\nciphertext\n```\n';
    expect(previewBody(`---\ntitle: Test\n---\n${body}`)).toBe(body);
    expect(previewBody(`\uFEFF---\r\ntitle: Test\r\n...\r\n${body}`)).toBe(body);
    expect(previewBody(body)).toBe(body);
    expect(previewBody('---\nunclosed')).toBe('---\nunclosed');
  });

  it('omits a repeated title and the Jira delimiter while retaining a different heading', () => {
    expect(previewBody('# Demo\n\nContent\n<!-- jira:end -->\n## My notes\n', 'Demo')).toBe(
      '\nContent\n## My notes\n',
    );
    expect(previewBody('# A different heading\nBody', 'Demo')).toBe('# A different heading\nBody');
  });
});
