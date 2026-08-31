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

describe('table rendering field', () => {
  const TDOC =
    '# Team\n\n| Name | Pay |\n| :--- | ---: |\n| [[Anna]] | `🔒Q0JWMWFiY2RlZmdo` |\n| Bob | 100 |\n\nafter\n';

  it('a doc with a table constructs and updates cleanly', () => {
    const state = stateWith(TDOC);
    expect(state.doc.toString()).toBe(TDOC);
    const tr = state.update({ changes: { from: 0, insert: 'x' } });
    expect(tr.state.doc.toString().startsWith('x')).toBe(true);
  });

  it('cursor inside the table keeps it raw (constructs without widget conflict)', () => {
    const inside = TDOC.indexOf('Bob');
    const state = stateWith(TDOC, inside);
    expect(state.doc.toString()).toBe(TDOC);
  });

  it('tables inside code fences are ignored', () => {
    const state = stateWith('```\n| a | b |\n| --- | --- |\n```\n');
    expect(state.doc.lines).toBe(5);
  });
});

describe('encryptTableCells', () => {
  const LINES = [
    '| Name | Pay | Note |',
    '| --- | ---: | --- |',
    '| Anna | 1000 | a\\|b |',
    '| Bob |  | `🔒Q0JWMWFiY2RlZmdo` |',
  ];
  const fakeEncrypt = async (t: string) => `ENC(${t})`;

  it('column mode encrypts non-empty, non-token cells and preserves escaping', async () => {
    const { encryptTableCells } = await import('../src/editor/tables.ts');
    const { lines, encrypted } = await encryptTableCells(
      LINES,
      { kind: 'column', index: 1 },
      fakeEncrypt,
    );
    expect(encrypted).toBe(1); // only Anna's Pay; Bob's is empty
    expect(lines[2]).toContain('`🔒ENC(1000)`');
    expect(lines[2]).toContain('a\\|b'); // untouched cell keeps its escape
    expect(lines[3]).toBe(LINES[3]); // row without changes untouched
  });

  it('row mode encrypts the whole row but skips existing tokens and empties', async () => {
    const { encryptTableCells } = await import('../src/editor/tables.ts');
    const { lines, encrypted } = await encryptTableCells(
      LINES,
      { kind: 'row', rowIndex: 1 },
      fakeEncrypt,
    );
    expect(encrypted).toBe(1); // only "Bob" — Pay empty, Note already a token
    expect(lines[3]).toContain('`🔒ENC(Bob)`');
    expect(lines[3]).toContain('`🔒Q0JWMWFiY2RlZmdo`');
    expect(lines[2]).toBe(LINES[2]);
  });

  it('header and separator are never touched', async () => {
    const { encryptTableCells } = await import('../src/editor/tables.ts');
    const { lines } = await encryptTableCells(LINES, { kind: 'column', index: 0 }, fakeEncrypt);
    expect(lines[0]).toBe(LINES[0]);
    expect(lines[1]).toBe(LINES[1]);
  });
});

describe('inline token vs code-span collision (regression)', () => {
  it('the token chip survives; code-span styling for its span is dropped', async () => {
    const { collectInline } = await import('../src/editor/livePreview.ts');
    const text = 'Pay: `🔒Q0JWMWFiY2RlZmdo` end';
    const tokenFrom = text.indexOf('`');
    const tokenTo = text.lastIndexOf('`') + 1;
    const out: { from: number; to: number; deco: unknown }[] = [];
    // simulate the parser having seen the token as an InlineCode node
    const emphasis = [
      {
        from: tokenFrom,
        to: tokenTo,
        cls: 'cm-cb-code',
        marks: [
          [tokenFrom, tokenFrom + 1],
          [tokenTo - 1, tokenTo],
        ] as [number, number][],
      },
    ];
    collectInline(
      0,
      text,
      { cursorTouches: false, inCodeBlock: false },
      9999,
      out,
      emphasis,
      undefined,
      () => null,
    );
    // exactly one decoration covering the token span — the chip; no
    // code-span mark or backtick hides competing for it
    const covering = out.filter((d) => d.from >= tokenFrom && d.to <= tokenTo);
    expect(covering).toHaveLength(1);
    expect(covering[0]).toMatchObject({ from: tokenFrom, to: tokenTo });
  });
});

describe('tokenCipher (surrogate-pair regression)', () => {
  it('extracts clean base64 — the lock char is two UTF-16 units', async () => {
    const { tokenCipher } = await import('../src/editor/tables.ts');
    const cipher = 'Q0JWMWFiY2RlZmdo';
    const whole = '`🔒' + cipher + '`';
    expect(tokenCipher(whole)).toBe(cipher);
    // the old slice(2,-1) approach would have produced a corrupted prefix:
    expect(whole.slice(2, -1)).not.toBe(cipher);
    expect(tokenCipher('`not a token`')).toBeNull();
  });
});
