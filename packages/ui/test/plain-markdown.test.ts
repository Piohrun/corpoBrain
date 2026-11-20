import { describe, expect, it } from 'vitest';
import { plainMarkdown } from '../src/plain-markdown.ts';

const titles: Record<string, string> = {
  'people/anna': 'Anna Kowalska',
  'EXEC-104': 'EXEC-104 — Replication',
};
const plain = (text: string) => plainMarkdown(text, (t) => titles[t]);

describe('plainMarkdown', () => {
  it('shows links as what they point to', () => {
    expect(plain('confirm APAC failover behaviour with [[Anna Kowalska]]')).toBe(
      'confirm APAC failover behaviour with Anna Kowalska',
    );
    expect(
      plain('ask [[people/anna]] and [[people/Navid]] about [[EXEC-104|the replication]]'),
    ).toBe('ask Anna Kowalska and Navid about the replication');
    expect(plain('see [the runbook](https://wiki/x) or <https://wiki/y>')).toBe(
      'see the runbook or https://wiki/y',
    );
    expect(plain('diagram ![[shot.png|300]] here')).toBe('diagram here');
  });

  it('drops the markup around the words', () => {
    expect(
      plain(
        '1. **Structure:** enable “Show secondary memberships”. [[people/Navid]] has _two_ PODs',
      ),
    ).toBe('Structure: enable “Show secondary memberships”. Navid has two PODs');
    expect(plain('- [ ] review `main.q` and ==ship== ~~never~~')).toBe(
      'review main.q and ship never',
    );
    expect(plain('> ## Decision: go')).toBe('Decision: go');
    expect(plain('text <!-- cb-track:01A:risk -->risky<!-- /cb-track:01A --> <u>now</u>')).toBe(
      'text risky now',
    );
  });

  it('ends a snippet that was cut inside a link cleanly', () => {
    expect(plain('has Gateway as a secondary membership. [[people')).toBe(
      'has Gateway as a secondary membership.…',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(plain('2 * 3 * 4 and snake_case_name stay')).toBe('2 * 3 * 4 and snake_case_name stay');
    expect(plain('a - b, not a list')).toBe('a - b, not a list');
    expect(plain('')).toBe('');
  });
});
