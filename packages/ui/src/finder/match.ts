/** Patterns for one query, compiled once and reused for every row it scores. */
interface Compiled {
  q: string;
  wordStart: RegExp;
  terms: RegExp[];
}
let compiled: Compiled | null = null;
function compile(query: string): Compiled {
  const q = query.trim().toLowerCase();
  if (compiled?.q === q) return compiled;
  const word = (s: string) => new RegExp(`(^|[\\s/_\\-—–.:(\\[])${escapeRegExp(s)}`);
  const terms = q.split(/\s+/).filter(Boolean);
  compiled = { q, wordStart: word(q), terms: terms.length > 1 ? terms.map(word) : [] };
  return compiled;
}

/**
 * Ranking shared by every Finder section: exact title, then prefix, then
 * word-start, then substring, then subsequence. Lower score is better; null
 * means no match. Purely lexical and synchronous so it can run per keystroke
 * over a few thousand rows.
 */
export function scoreMatch(query: string, text: string): number | null {
  const c = compile(query);
  const q = c.q;
  if (!q) return 100;
  const t = text.toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1 + (t.length - q.length) / 1000;
  const at = t.indexOf(q);
  if (at >= 0) {
    // a word-start match is also a substring match, so only then is the regex worth running
    const wordStart = t.search(c.wordStart);
    if (wordStart >= 0) return 2 + wordStart / 1000;
    return 3 + at / 1000;
  }
  // every query term as a word-start somewhere ("gw arch" → Gateway architecture)
  if (c.terms.length && c.terms.every((re) => re.test(t))) return 4;
  return null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split text into [plain, match, plain, match…] so the UI can emphasise hits. */
export function splitMatches(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const terms = q.split(/\s+/).filter(Boolean).map(escapeRegExp);
  const re = new RegExp(`(${terms.join('|')})`, 'ig');
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0] === '') break;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** Rank a list by the best score over several texts per row; drop non-matches. */
export function rankBy<T>(
  rows: T[],
  query: string,
  texts: (row: T) => (string | null | undefined)[],
  limit = 50,
): { row: T; score: number }[] {
  const out: { row: T; score: number }[] = [];
  for (const row of rows) {
    let best: number | null = null;
    let i = 0;
    for (const t of texts(row)) {
      if (!t) {
        i++;
        continue;
      }
      const s = scoreMatch(query, t);
      // later texts (path, body) rank below earlier ones (title) at equal score
      if (s !== null) {
        const adjusted = s + i * 0.5;
        if (best === null || adjusted < best) best = adjusted;
      }
      i++;
    }
    if (best !== null) out.push({ row, score: best });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, limit);
}
