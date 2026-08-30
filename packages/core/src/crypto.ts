/**
 * Protected notes crypto per docs/SPEC.md §9. Trilium-style key hierarchy:
 * passphrase → scrypt (N=2^15, r=8, p=1) → master key, which wraps a random
 * 32-byte data key. Notes are AES-256-GCM, per-file 12-byte nonce.
 *
 * Container (.md.enc): "CBV1" | version u8 (=1) | nonce (12) | ciphertext+tag.
 * Keystore (private/.keystore.json): { version, salt, nonce, wrappedKey } b64.
 *
 * Uses node:crypto only. NEVER implement primitives here.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from('CBV1');
const VERSION = 1;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
const NONCE_LEN = 12;

export class CryptoError extends Error {}

export interface Keystore {
  version: number;
  salt: string; // b64
  nonce: string; // b64, for the wrapped data key
  wrappedKey: string; // b64, AES-GCM(masterKey, dataKey) ciphertext+tag
  /** b64 AES-GCM(masterKey, MAGIC) — cheap passphrase check without unwrap side effects */
  check: string;
  checkNonce: string;
}

function deriveMaster(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT);
}

function gcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]);
}

function gcmDecrypt(key: Buffer, nonce: Buffer, data: Buffer): Buffer {
  if (data.length < 16) throw new CryptoError('ciphertext too short');
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CryptoError('decryption failed — wrong key or tampered data');
  }
}

/** Create a new keystore with a fresh random data key. */
export function createKeystore(passphrase: string): { keystore: Keystore; dataKey: Buffer } {
  if (passphrase.length < 8) throw new CryptoError('passphrase must be at least 8 characters');
  const salt = randomBytes(16);
  const master = deriveMaster(passphrase, salt);
  const dataKey = randomBytes(KEY_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const checkNonce = randomBytes(NONCE_LEN);
  const keystore: Keystore = {
    version: VERSION,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    wrappedKey: gcmEncrypt(master, nonce, dataKey).toString('base64'),
    check: gcmEncrypt(master, checkNonce, MAGIC).toString('base64'),
    checkNonce: checkNonce.toString('base64'),
  };
  master.fill(0);
  return { keystore, dataKey };
}

/** Unlock: derive master from passphrase and unwrap the data key. */
export function unlockKeystore(keystore: Keystore, passphrase: string): Buffer {
  if (keystore.version !== VERSION)
    throw new CryptoError(`unsupported keystore version ${keystore.version}`);
  const master = deriveMaster(passphrase, Buffer.from(keystore.salt, 'base64'));
  try {
    const check = gcmDecrypt(
      master,
      Buffer.from(keystore.checkNonce, 'base64'),
      Buffer.from(keystore.check, 'base64'),
    );
    if (check.length !== MAGIC.length || !timingSafeEqual(check, MAGIC)) {
      throw new CryptoError('wrong passphrase');
    }
    return gcmDecrypt(
      master,
      Buffer.from(keystore.nonce, 'base64'),
      Buffer.from(keystore.wrappedKey, 'base64'),
    );
  } catch (e) {
    throw e instanceof CryptoError && e.message === 'wrong passphrase'
      ? e
      : new CryptoError('wrong passphrase');
  } finally {
    master.fill(0);
  }
}

/** Re-wrap the data key under a new passphrase (no re-encryption of notes). */
export function changePassphrase(
  keystore: Keystore,
  oldPassphrase: string,
  newPassphrase: string,
): Keystore {
  const dataKey = unlockKeystore(keystore, oldPassphrase);
  try {
    if (newPassphrase.length < 8) throw new CryptoError('passphrase must be at least 8 characters');
    const salt = randomBytes(16);
    const master = deriveMaster(newPassphrase, salt);
    const nonce = randomBytes(NONCE_LEN);
    const checkNonce = randomBytes(NONCE_LEN);
    const next: Keystore = {
      version: VERSION,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      wrappedKey: gcmEncrypt(master, nonce, dataKey).toString('base64'),
      check: gcmEncrypt(master, checkNonce, MAGIC).toString('base64'),
      checkNonce: checkNonce.toString('base64'),
    };
    master.fill(0);
    return next;
  } finally {
    dataKey.fill(0);
  }
}

/** Encrypt a note's full markdown text into a CBV1 container. */
export function encryptNote(dataKey: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    nonce,
    gcmEncrypt(dataKey, nonce, Buffer.from(plaintext, 'utf8')),
  ]);
}

/** Decrypt a CBV1 container to markdown text (memory only — never write it to disk). */
export function decryptNote(dataKey: Buffer, container: Buffer): string {
  if (
    container.length < MAGIC.length + 1 + NONCE_LEN + 16 ||
    !container.subarray(0, 4).equals(MAGIC)
  ) {
    throw new CryptoError('not a corpobrain protected note');
  }
  if (container[4] !== VERSION)
    throw new CryptoError(`unsupported container version ${container[4]}`);
  const nonce = container.subarray(5, 5 + NONCE_LEN);
  const data = container.subarray(5 + NONCE_LEN);
  return gcmDecrypt(dataKey, nonce, data).toString('utf8');
}

// ------------------------------------------------------------- vault-level

export function keystorePath(vaultRoot: string, privateFolder: string): string {
  return join(vaultRoot, privateFolder, '.keystore.json');
}

export function loadKeystore(vaultRoot: string, privateFolder: string): Keystore | null {
  const p = keystorePath(vaultRoot, privateFolder);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Keystore;
  } catch {
    throw new CryptoError('keystore is corrupted');
  }
}

export function saveKeystore(vaultRoot: string, privateFolder: string, keystore: Keystore): void {
  writeFileSync(keystorePath(vaultRoot, privateFolder), `${JSON.stringify(keystore, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Opaque filename for a new protected note. */
export function opaqueName(): string {
  return `${randomBytes(12).toString('hex')}.md.enc`;
}
