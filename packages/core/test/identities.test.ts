import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { IdentityIndex, identitiesOf, normalizeIdentity } from '../src/identities.ts';
import { Indexer } from '../src/indexer.ts';

describe('normalizeIdentity', () => {
  it('canonicalises emails and GitHub logins, rejecting what cannot be one', () => {
    expect(normalizeIdentity('email', ' Anna.Kowalska@Bank.COM ')).toBe('anna.kowalska@bank.com');
    expect(normalizeIdentity('email', 'mailto:anna@bank.com')).toBe('anna@bank.com');
    expect(normalizeIdentity('email', 'Anna Kowalska')).toBeNull();
    expect(normalizeIdentity('github', '@AKowalska')).toBe('akowalska');
    expect(normalizeIdentity('github', 'https://github.com/akowalska-bank/')).toBe(
      'akowalska-bank',
    );
    expect(normalizeIdentity('github', 'not a login')).toBeNull();
    expect(normalizeIdentity('github', 'AKowalska_BankCorp')).toBe('akowalska_bankcorp');
  });

  it('reads single values and lists from frontmatter, deduplicated', () => {
    expect(identitiesOf({ email: ['a@x.com', 'A@X.com', 'b@x.com', 42, 'nope'] }, 'email')).toEqual(
      ['a@x.com', 'b@x.com'],
    );
    expect(identitiesOf({ github: 'anna' }, 'github')).toEqual(['anna']);
    expect(identitiesOf({}, 'github')).toEqual([]);
  });
});

describe('IdentityIndex', () => {
  let root: string;
  let indexer: Indexer;
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };

  beforeEach(() => {
    root = join(tmpdir(), `cb-ident-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    write(
      'people/anna.md',
      '---\ntype: person\ntitle: Anna\nemail: [anna@bank.com, Anna.K@bank.com]\ngithub: AKowalska\n---\n',
    );
    write('people/marek.md', '---\ntype: person\ntitle: Marek\nemail: shared@bank.com\n---\n');
    write('people/ola.md', '---\ntype: person\ntitle: Ola\nemail: shared@bank.com\n---\n');
    // identities only count on person notes
    write('notes/meeting.md', '---\ntitle: Sync\nemail: notaperson@bank.com\n---\n');
    indexer = new Indexer(root, DEFAULT_CONFIG, openDb(':memory:'));
    indexer.rebuild();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('matches case-insensitively and refuses to guess between two people', () => {
    const email = IdentityIndex.load(indexer.db, 'email');
    expect(email.match('ANNA.K@BANK.COM')).toEqual({
      status: 'matched',
      path: 'people/anna.md',
    });
    expect(email.match('shared@bank.com')).toEqual({
      status: 'ambiguous',
      paths: ['people/marek.md', 'people/ola.md'],
    });
    expect(email.match('notaperson@bank.com')).toEqual({ status: 'unknown' });
    expect(email.match('garbage')).toEqual({ status: 'unknown' });
    expect(IdentityIndex.load(indexer.db, 'github').match('@akowalska')).toEqual({
      status: 'matched',
      path: 'people/anna.md',
    });
    expect([...IdentityIndex.load(indexer.db, 'github').people()]).toEqual(['people/anna.md']);
  });

  it('follows edits and deletions incrementally', () => {
    write('people/ola.md', '---\ntype: person\ntitle: Ola\nemail: ola@bank.com\n---\n');
    unlinkSync(join(root, 'people/anna.md'));
    indexer.updatePaths(['people/ola.md', 'people/anna.md']);
    const email = IdentityIndex.load(indexer.db, 'email');
    expect(email.match('shared@bank.com')).toEqual({ status: 'matched', path: 'people/marek.md' });
    expect(email.match('ola@bank.com')).toEqual({ status: 'matched', path: 'people/ola.md' });
    expect(email.match('anna@bank.com')).toEqual({ status: 'unknown' });
    expect(IdentityIndex.load(indexer.db, 'github').people().size).toBe(0);
  });
});
