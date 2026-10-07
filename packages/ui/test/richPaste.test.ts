// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/editor/richPaste.ts';
import { inlineHtml, safeStyle } from '../src/editor/safeHtml.ts';

describe('rich paste', () => {
  it('keeps headings, paragraphs, emphasis and links from a web page', () => {
    const md = htmlToMarkdown(
      '<h2>Q4 plan</h2><p>We <b>must</b> ship <em>before</em> the freeze — see <a href="https://wiki.bank/q4">the wiki</a>.</p><p>Second <s>draft</s> paragraph.</p>',
    );
    expect(md).toBe(
      '## Q4 plan\n\nWe **must** ship *before* the freeze — see [the wiki](https://wiki.bank/q4).\n\nSecond ~~draft~~ paragraph.',
    );
  });

  it('turns Outlook/Word list paragraphs and styles into Markdown', () => {
    const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>
      <p class=MsoNormal><span style='font-weight:bold'>Action items</span><o:p></o:p></p>
      <p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>Send the budget<o:p></o:p></p>
      <p class=MsoListParagraph style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o<span>&nbsp;</span></span>to finance<o:p></o:p></p>
      <p class=MsoNormal><span style='color:#C00000'>Deadline Friday</span> and <span style='background:yellow'>this matters</span><o:p></o:p></p>
      </body></html>`;
    expect(htmlToMarkdown(word)).toBe(
      '**Action items**\n\n- Send the budget\n  - to finance\n\n<span style="color: #c00000">Deadline Friday</span> and ==this matters==',
    );
  });

  it('nests Confluence-style lists and keeps quotes, code and tables', () => {
    const md = htmlToMarkdown(
      '<ul><li><p>One</p><ul><li>One a</li></ul></li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol><blockquote><p>Quoted</p></blockquote><pre><code>npm run build\nnpm start</code></pre><table><tr><th>Name</th><th>Role</th></tr><tr><td>Anna</td><td>Lead</td></tr></table>',
    );
    expect(md).toBe(
      [
        '- One',
        '  - One a',
        '- Two',
        '',
        '1. First',
        '2. Second',
        '',
        '> Quoted',
        '',
        '```',
        'npm run build',
        'npm start',
        '```',
        '',
        '| Name | Role |',
        '| --- | --- |',
        '| Anna | Lead |',
      ].join('\n'),
    );
  });

  it('drops scripts, styles, handlers and unsafe links; escapes Markdown in text', () => {
    const md = htmlToMarkdown(
      '<style>p{color:red}</style><script>alert(1)</script><p onclick="x()">Use <b>a*b_c</b> and [[not a link]] <a href="javascript:alert(1)">click</a> <img src="cid:image001.png" alt="logo"></p>',
    );
    expect(md).toBe('Use **a\\*b\\_c** and \\[\\[not a link\\]\\] click logo');
  });

  it('leaves plain text to the normal paste', () => {
    expect(htmlToMarkdown('<p>just words</p>')).toBeNull();
    expect(htmlToMarkdown('<span style="color:black">plain</span>')).toBeNull();
    expect(htmlToMarkdown('')).toBeNull();
  });
});

describe('the safe inline HTML set', () => {
  it('accepts simple tags and colour-only spans, nothing else', () => {
    const line =
      'a <u>under</u> <kbd>Ctrl</kbd> <span style="color: #c00; background: yellow">red</span> <span style="position:fixed">x</span> <span style="color: url(javascript:1)">y</span>';
    expect(
      inlineHtml(line).map((h) => [h.tag, line.slice(h.innerFrom, h.innerTo), h.style]),
    ).toEqual([
      ['u', 'under', null],
      ['kbd', 'Ctrl', null],
      ['span', 'red', 'color:#c00;background-color:yellow'],
    ]);
    expect(safeStyle('color: expression(alert(1))')).toBeNull();
    expect(safeStyle('color: rgb(192, 0, 0)')).toBe('color:rgb(192, 0, 0)');
  });
});

describe('colours from the browser', () => {
  it('are written as hex', () => {
    expect(
      htmlToMarkdown(
        '<p><span style="color: rgb(192, 0, 0)">late</span> <span style="background-color: rgb(255, 255, 0)">key</span></p>',
      ),
    ).toBe('<span style="color: #c00000">late</span> ==key==');
  });
});

describe('colouring a selection', () => {
  it('wraps each line and survives the safe set', async () => {
    const { toColored } = await import('../src/editor/safeHtml.ts');
    const out = toColored('late\n\n vendor ', '#c00000');
    expect(out).toBe(
      '<span style="color: #c00000">late</span>\n\n <span style="color: #c00000">vendor</span> ',
    );
    expect(inlineHtml(out.split('\n')[0] as string)[0]?.style).toBe('color:#c00000');
  });
});
