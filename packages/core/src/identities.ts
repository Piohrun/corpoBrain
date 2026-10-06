/**
 * External identities on person notes: the keys connectors use to attribute
 * outside data to a person (SPEC §6.3). `email:` matches Outlook senders and
 * attendees, `github:` matches GitHub logins (Copilot metrics). Either may be
 * a single value or a list; matching is case-insensitive.
 */
import type { DatabaseSync } from 'node:sqlite';

export type IdentityKind = 'email' | 'github';
export const IDENTITY_KINDS: readonly IdentityKind[] = ['email', 'github'];

// Lenient on purpose: Enterprise Managed Users logins carry an `_shortcode` suffix.
const GITHUB_LOGIN = /^[a-z\d][a-z\d_-]{0,99}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Canonical form of an identity value, or null when it cannot be one. */
export function normalizeIdentity(kind: IdentityKind, raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (kind === 'email') {
    value = value.replace(/^mailto:/, '');
    return EMAIL.test(value) ? value : null;
  }
  value = value
    .replace(/^@/, '')
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\/$/, '');
  return GITHUB_LOGIN.test(value) ? value : null;
}

/** Normalized identities a person note declares for one kind; invalid values are dropped. */
export function identitiesOf(fm: Record<string, unknown>, kind: IdentityKind): string[] {
  const raw = fm[kind];
  const values = Array.isArray(raw) ? raw : [raw];
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const n = normalizeIdentity(kind, v);
    if (n) out.add(n);
  }
  return [...out];
}

export type IdentityMatch =
  | { status: 'matched'; path: string }
  | { status: 'ambiguous'; paths: string[] }
  | { status: 'unknown' };

/**
 * A snapshot of one identity kind, for attributing a batch of external
 * records (a mailbox page, a metrics report) without a query per record.
 */
export class IdentityIndex {
  private constructor(
    readonly kind: IdentityKind,
    private readonly byValue: Map<string, string[]>,
  ) {}

  static load(db: DatabaseSync, kind: IdentityKind): IdentityIndex {
    const rows = db
      .prepare('SELECT value, path FROM person_identities WHERE kind = ? ORDER BY path')
      .all(kind) as { value: string; path: string }[];
    const byValue = new Map<string, string[]>();
    for (const { value, path } of rows) {
      const paths = byValue.get(value);
      if (paths) paths.push(path);
      else byValue.set(value, [path]);
    }
    return new IdentityIndex(kind, byValue);
  }

  /** Two person notes claiming the same identity is ambiguous, never a guess. */
  match(raw: string): IdentityMatch {
    const value = normalizeIdentity(this.kind, raw);
    const paths = value ? this.byValue.get(value) : undefined;
    if (!paths) return { status: 'unknown' };
    if (paths.length > 1) return { status: 'ambiguous', paths: [...paths] };
    return { status: 'matched', path: paths[0] as string };
  }

  /** Every person path that declares at least one identity of this kind. */
  people(): Set<string> {
    return new Set([...this.byValue.values()].flat());
  }
}
