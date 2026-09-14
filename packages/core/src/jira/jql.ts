/** Add an incremental filter before the top-level ORDER BY, leaving quoted text intact. */
export function incrementalJql(jql: string, minutes: number): string {
  let quote = '';
  let depth = 0;
  let split = jql.length;
  for (let i = 0; i < jql.length; i++) {
    const char = jql[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) {
        if (jql[i + 1] === quote) i++;
        else quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (
      depth === 0 &&
      (i === 0 || /\s/.test(jql[i - 1] ?? '')) &&
      /^order\s+by\b/i.test(jql.slice(i))
    ) {
      split = i;
      break;
    }
  }
  const filter = jql.slice(0, split).trim();
  const order = jql.slice(split).trim();
  return `${filter ? `(${filter}) AND ` : ''}updated >= -${minutes}m${order ? ` ${order}` : ''}`;
}
