import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type VaultConfig } from '../src/config.ts';
import type { IdentityMatch } from '../src/identities.ts';
import {
  applyMailTasks,
  mailTaskKey,
  type OutlookMail,
  readMailState,
  tickTask,
} from '../src/outlook/mail.ts';

const mail = (over: Partial<OutlookMail> = {}): OutlookMail => ({
  id: '<abc@bank.com>',
  subject: 'Budget sign-off',
  from: { name: 'Anna Kowalska', email: 'anna@bank.com' },
  received: '2026-10-02T09:15:00',
  due: null,
  completed: false,
  flag: 'Follow up',
  importance: 'normal',
  categories: [],
  preview: 'Can you approve…',
  ...over,
});

const resolve = (email: string): IdentityMatch =>
  email === 'anna@bank.com' ? { status: 'matched', path: 'people/anna.md' } : { status: 'unknown' };

let root: string;
let config: VaultConfig;
const NOTE = 'notes/Email follow-ups.md';
beforeEach(() => {
  root = join(tmpdir(), `cb-mail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  config = structuredClone(DEFAULT_CONFIG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sync = (mails: OutlookMail[], locate: (key: string) => string | null = () => null) =>
  applyMailTasks(root, config, { since: '2026-09-06', mails, complete: true }, { resolve, locate });
const note = () => readFileSync(join(root, NOTE), 'utf8');
const key = mailTaskKey('<abc@bank.com>');

describe('flagged mail → tasks', () => {
  it('adds a task line once, linking the sender and the due date', () => {
    const report = sync([mail({ due: '2026-10-09' })]);
    expect(report).toMatchObject({ added: ['Budget sign-off'], touched: [NOTE] });
    expect(note()).toContain(
      `- [ ] Budget sign-off — from [[people/anna|Anna Kowalska]], 2026-10-02 📅 2026-10-09 ^${key}\n`,
    );
    expect(note()).toMatch(/^---\ntitle: Email follow-ups\n---\n# Email follow-ups\n/);
    expect(sync([mail({ due: '2026-10-09' })])).toMatchObject({
      added: [],
      unchanged: 1,
      touched: [],
    });
  });

  it('ticks the line where the user moved it when the flag is completed', () => {
    sync([mail()]);
    const line = note()
      .split('\n')
      .find((l) => l.includes(key)) as string;
    mkdirSync(join(root, 'projects'));
    writeFileSync(
      join(root, 'projects/budget.md'),
      `# Budget\n\n${line.replace('- [ ]', '- j[ ]')}\nmore\n`,
    );
    writeFileSync(join(root, NOTE), note().replace(`${line}\n`, ''));
    const report = sync([mail({ completed: true })], (k) =>
      k === key ? 'projects/budget.md' : null,
    );
    expect(report).toMatchObject({ ticked: 1, touched: ['projects/budget.md'] });
    expect(readFileSync(join(root, 'projects/budget.md'), 'utf8')).toContain(
      `- j[x] Budget sign-off`,
    );
  });

  it('treats an unflagged mail as done, but only inside a complete window', () => {
    sync([mail(), mail({ id: '<old@bank.com>', subject: 'Old', received: '2026-09-01T08:00:00' })]);
    // export missed everything but was incomplete: touch nothing
    expect(
      applyMailTasks(
        root,
        config,
        { since: '2026-09-06', mails: [], complete: false },
        {
          resolve,
          locate: () => null,
        },
      ).ticked,
    ).toBe(0);
    const report = sync([]);
    expect(report.ticked).toBe(1); // the old one is outside the window, so it stays open
    expect(note()).toContain(`- [x] Budget sign-off`);
    expect(note()).toContain('- [ ] Old');
  });

  it('never re-adds a task the user deleted, nor one completed before it was seen', () => {
    sync([mail()]);
    writeFileSync(join(root, NOTE), '# Email follow-ups\n');
    expect(sync([mail()]).added).toEqual([]);
    expect(sync([mail({ id: '<done@bank.com>', completed: true })]).added).toEqual([]);
    expect(Object.keys(readMailState(root).tasks)).toHaveLength(2);
    expect(note()).toBe('# Email follow-ups\n');
  });

  it('neutralises subjects and keeps user text in the note', () => {
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, NOTE), '# Mine\n\nKeep this paragraph.');
    sync([
      mail({
        subject: 'Re: [[secret]] 📅 2099-01-01 ^fake-id',
        from: { name: 'Vendor', email: 'v@vendor.com' },
        importance: 'high',
      }),
    ]);
    const text = note();
    expect(text.startsWith('# Mine\n\nKeep this paragraph.\n- [ ] ❗ Re:')).toBe(true);
    expect(text).not.toContain('[[secret]]');
    expect(text).not.toContain('📅 2099-01-01'); // no due token from the subject
    expect(text).not.toContain('^fake-id');
    expect(text).toContain('— from Vendor, 2026-10-02');
  });

  it('ticks only an open line with exactly that block id', () => {
    const text = `- [ ] a ^${key}\n- [ ] b ^${key}0\r\n`;
    expect(tickTask(text, key)).toBe(`- [x] a ^${key}\n- [ ] b ^${key}0\r\n`);
    expect(tickTask(`- [x] a ^${key}\n`, key)).toBeNull();
    expect(tickTask(`- [ ] b ^${key}0\r\n`, key)).toBeNull();
  });
});
