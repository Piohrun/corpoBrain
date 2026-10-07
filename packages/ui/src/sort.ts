const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The order people expect for names, titles and keys: numbers by value
 * ("Pod 2" before "Pod 10", "EXEC-9" before "EXEC-10"), case-insensitive,
 * with a plain comparison as the tiebreak so the order is total.
 */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
