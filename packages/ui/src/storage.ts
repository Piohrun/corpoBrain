/**
 * localStorage with the try/catch folded in: private windows, blocked
 * storage and thumbnail renderers all throw on access, and a missing
 * preference must never break a page.
 */

export function lsGet(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference just does not persist */
  }
}

/** JSON-parsed value under `key`, or `fallback` when missing or unparsable. */
export function lsJson<T>(key: string, fallback: T): T {
  const raw = lsGet(key, '');
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function lsSetJson(key: string, value: unknown): void {
  lsSet(key, JSON.stringify(value));
}
