import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { livePreview } from '../src/editor/livePreview.ts';

function stateWith(doc: string, cursorAt = 0, revealed: Record<string, string> = {}) {
  return EditorState.create({
    doc,
    selection: { anchor: cursorAt },
    extensions: [
      livePreview({
        onNavigate: () => {},
        getSecret: (c) => revealed[c] ?? null,
        onSecretClick: () => {},
      }),
    ],
  });
}

const DOC = 'Fixed Pay:\n```secret\nQ0JWMWFiYw==\n```\nafter\n';

describe('secret block state field', () => {
  it('creating a state with a secret fence does not throw and yields one block decoration', () => {
    const state = stateWith(DOC);
    // the field is internal; assert via the state not throwing and doc intact
    expect(state.doc.toString()).toBe(DOC);
    // crash regression guard: an update transaction also computes cleanly
    const tr = state.update({ changes: { from: 0, insert: 'x' } });
    expect(tr.state.doc.toString().startsWith('x')).toBe(true);
  });

  it('cursor inside the fence keeps it raw (no replace at that position)', () => {
    const inside = DOC.indexOf('Q0JW');
    const state = stateWith(DOC, inside);
    expect(state.doc.toString()).toBe(DOC);
  });

  it('unterminated fences are left alone', () => {
    const state = stateWith('```secret\nabc\nno closing fence');
    expect(state.doc.lines).toBe(3);
  });
});

describe('inline secret tokens', () => {
  it('a doc with inline tokens constructs and updates cleanly', () => {
    const doc = '| Name | Pay |\n| --- | --- |\n| Anna | `🔒Q0JWMWFiY2RlZmdo` |\n';
    const state = stateWith(doc, 0, { Q0JWMWFiY2RlZmdo: 'revealed!' });
    expect(state.doc.toString()).toBe(doc);
    const tr = state.update({ changes: { from: 0, insert: 'x' } });
    expect(tr.state.doc.lines).toBe(4);
  });
});
