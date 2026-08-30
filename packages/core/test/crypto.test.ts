import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CryptoError,
  changePassphrase,
  createKeystore,
  decryptNote,
  encryptNote,
  loadKeystore,
  opaqueName,
  saveKeystore,
  unlockKeystore,
} from '../src/crypto.ts';

describe('keystore', () => {
  it('create → unlock round trip', () => {
    const { keystore, dataKey } = createKeystore('correct horse battery');
    const unlocked = unlockKeystore(keystore, 'correct horse battery');
    expect(unlocked.equals(dataKey)).toBe(true);
  });

  it('wrong passphrase throws, never returns a key', () => {
    const { keystore } = createKeystore('correct horse battery');
    expect(() => unlockKeystore(keystore, 'wrong passphrase!')).toThrow(CryptoError);
    expect(() => unlockKeystore(keystore, 'wrong passphrase!')).toThrow(/wrong passphrase/);
  });

  it('rejects short passphrases', () => {
    expect(() => createKeystore('short')).toThrow(/at least 8/);
  });

  it('changePassphrase keeps the same data key', () => {
    const { keystore, dataKey } = createKeystore('old passphrase 1');
    const next = changePassphrase(keystore, 'old passphrase 1', 'new passphrase 2');
    expect(unlockKeystore(next, 'new passphrase 2').equals(dataKey)).toBe(true);
    expect(() => unlockKeystore(next, 'old passphrase 1')).toThrow(CryptoError);
    expect(next.salt).not.toBe(keystore.salt);
  });
});

describe('note container', () => {
  const { dataKey } = createKeystore('a fine passphrase');

  it('encrypt → decrypt round trip, fresh nonce every time', () => {
    const text = '---\ntitle: Comp discussion\n---\n\nSensitive €£ ünïcode.\n';
    const c1 = encryptNote(dataKey, text);
    const c2 = encryptNote(dataKey, text);
    expect(decryptNote(dataKey, c1)).toBe(text);
    expect(decryptNote(dataKey, c2)).toBe(text);
    expect(c1.equals(c2)).toBe(false); // nonce differs
    expect(c1.subarray(0, 4).toString()).toBe('CBV1');
  });

  it('detects tampering (GCM auth)', () => {
    const c = encryptNote(dataKey, 'secret');
    c[c.length - 3] ^= 0xff;
    expect(() => decryptNote(dataKey, c)).toThrow(/tampered|failed/);
  });

  it('rejects wrong key and non-container data', () => {
    const other = createKeystore('another passphrase').dataKey;
    const c = encryptNote(dataKey, 'secret');
    expect(() => decryptNote(other, c)).toThrow(CryptoError);
    expect(() => decryptNote(dataKey, Buffer.from('not a container at all'))).toThrow(
      /not a corpobrain/,
    );
  });
});

describe('vault keystore file', () => {
  let root: string;
  beforeEach(() => {
    root = join(tmpdir(), `cb-crypt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, 'private'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('save/load round trip; missing → null; corrupted → error', () => {
    expect(loadKeystore(root, 'private')).toBeNull();
    const { keystore } = createKeystore('a fine passphrase');
    saveKeystore(root, 'private', keystore);
    expect(loadKeystore(root, 'private')).toEqual(keystore);
    const raw = readFileSync(join(root, 'private', '.keystore.json'), 'utf8');
    expect(raw).toContain('"version": 1');
    writeFileSync(join(root, 'private', '.keystore.json'), '{broken');
    expect(() => loadKeystore(root, 'private')).toThrow(/corrupted/);
  });

  it('opaque names leak nothing', () => {
    const a = opaqueName();
    expect(a).toMatch(/^[0-9a-f]{24}\.md\.enc$/);
    expect(opaqueName()).not.toBe(a);
  });
});
