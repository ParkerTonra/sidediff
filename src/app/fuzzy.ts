// Fuzzy matching for the explorer filter and quick open. Owned by UI / UX.

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  const cur = text[i] ?? '';
  if (/[\s_.\-/\\:~#<]/.test(prev)) return true;
  // camelCase / PascalCase hump, or a letter after a digit.
  return (cur !== cur.toLowerCase() && prev === prev.toLowerCase() && /[a-z0-9]/i.test(prev)) || (/\d/.test(prev) && /[a-z]/i.test(cur));
}

/**
 * Scores `query` as a case-insensitive subsequence of `text`. Higher is
 * better; null means no match. Contiguous runs, word starts and an early
 * first hit score higher. An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  if (q === '') return 0;
  const t = text.toLowerCase();

  // Exact substring: strongly preferred, more so at a word start or at 0.
  const sub = t.indexOf(q);
  if (sub >= 0) return 1000 + (sub === 0 ? 300 : isBoundary(text, sub) ? 150 : 0) - sub - (t.length - q.length) * 0.1;

  let score = 0;
  let ti = 0;
  let run = 0;
  let first = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (first < 0) first = found;
    if (found === ti && ti > 0) run++;
    else run = 0;
    score += 10 + run * 15 + (isBoundary(text, found) ? 25 : 0) - Math.min(found - ti, 20);
    ti = found + 1;
  }
  return score - first;
}

/** All whitespace-separated terms must match `text`; returns the summed score or null. */
export function fuzzyMatch(query: string, text: string): number | null {
  let total = 0;
  for (const term of query.trim().split(/\s+/)) {
    if (term === '') continue;
    const s = fuzzyScore(term, text);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** Matches against a name (weighted higher) and a secondary detail. */
export function fuzzyItem(query: string, name: string, detail: string): number | null {
  if (query.trim() === '') return 0;
  const byName = fuzzyMatch(query, name);
  const byBoth = fuzzyMatch(query, `${name} ${detail}`);
  if (byName === null && byBoth === null) return null;
  return Math.max(byName === null ? -Infinity : byName * 1.5, byBoth ?? -Infinity);
}
