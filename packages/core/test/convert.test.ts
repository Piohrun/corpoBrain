import { describe, expect, it } from 'vitest';
import { jiraTextToMarkdown, wikiToMarkdown } from '../src/jira/convert.ts';

describe('wikiToMarkdown', () => {
  it('converts headings, lists, quotes', () => {
    const src = 'h2. Title\n\n* one\n** nested\n# first\n## sub\nbq. quoted';
    expect(wikiToMarkdown(src)).toBe('## Title\n\n- one\n  - nested\n1. first\n  1. sub\n> quoted');
  });

  it('converts inline markup', () => {
    expect(wikiToMarkdown('This is *bold* and _italic_ and {{mono}} and [text|https://x.y]')).toBe(
      'This is **bold** and *italic* and `mono` and [text](https://x.y)',
    );
  });

  it('converts code blocks and leaves their content alone', () => {
    const src = '{code:java}\nint x = *notbold*;\n{code}\nafter';
    expect(wikiToMarkdown(src)).toBe('```java\nint x = *notbold*;\n```\nafter');
  });
});

describe('jiraTextToMarkdown (ADF)', () => {
  it('converts a document with common nodes', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' and ' },
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://a.b' } }],
            },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'q' },
          content: [{ type: 'text', text: 'select from t' }],
        },
      ],
    };
    expect(jiraTextToMarkdown(adf)).toBe(
      '## Why\n\n**Bold** and [link](https://a.b)\n\n- one\n\n- two\n\n```q\nselect from t\n```',
    );
  });

  it('null and string passthrough', () => {
    expect(jiraTextToMarkdown(null)).toBe('');
    expect(jiraTextToMarkdown('plain h1. no')).toBe('plain h1. no');
  });
});

describe('describeNetworkError', () => {
  it('digs codes out of undici-style causes and adds hints', async () => {
    const { describeNetworkError, JiraAdapter, JiraError } = await import('../src/jira/adapter.ts');
    const cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    const wrapped = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeNetworkError(wrapped)).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(describeNetworkError(wrapped)).toContain('NODE_EXTRA_CA_CERTS');
    expect(describeNetworkError(new TypeError('fetch failed'))).toBe('fetch failed');
    // adapter surfaces it through JiraError with the host
    const adapter = new JiraAdapter(
      'https://jira.example.com',
      { mode: 'bearer', token: 't' },
      'datacenter',
      (() => Promise.reject(wrapped)) as unknown as typeof fetch,
    );
    await expect(adapter.search('project = X')).rejects.toThrow(JiraError);
    await expect(adapter.search('project = X')).rejects.toThrow(
      /jira\.example\.com.*UNABLE_TO_VERIFY/,
    );
  });
});

describe('request timeout', () => {
  it('a hanging fetch aborts and reports a proxy/firewall hint', async () => {
    const { JiraAdapter, JiraError } = await import('../src/jira/adapter.ts');
    const hangingFetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const adapter = new JiraAdapter(
      'https://jira.example.com',
      { mode: 'bearer', token: 't' },
      'datacenter',
      hangingFetch,
      50, // 50ms timeout for the test
    );
    await expect(adapter.probe()).rejects.toThrow(JiraError);
    await expect(adapter.probe()).rejects.toThrow(/timed out.*proxy|proxy.*timed out/i);
  }, 5000);
});
