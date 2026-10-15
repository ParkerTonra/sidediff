// Long lines in the diff worker (DECISIONS.md D14). Character-level diffing
// of one changed 20k-character line (base64 pageSource values in Acumatica
// projects) costs seconds and made whole diffs hit the time budget. Lines
// longer than LONG_LINE are replaced by a short content-hash token before the
// diff, so they still pair and match by content, and get no character diff:
// a changed long line is reported as one range trimmed of its common prefix
// and suffix. Pure functions; unit tested in long-lines.test.ts.
import type { SerializedChange } from './diff-worker-protocol';

/** Lines longer than this (UTF-16 code units) get no character-level diff. */
export const LONG_LINE = 1000;

/** 53-bit string hash (cyrb53): collisions are negligible for line matching. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface Masked {
  /** Lines with every long line replaced by a token. */
  lines: string[];
  /** 1-based line numbers that were replaced. */
  long: Set<number>;
}

/**
 * Replaces long lines with `\u0001<length>:<hash>`. With ignoreTrimWhitespace
 * the hash covers the trimmed line, matching how Monaco compares lines then.
 */
export function maskLongLines(lines: readonly string[], ignoreTrimWhitespace: boolean, limit = LONG_LINE): Masked {
  const out = lines.slice();
  const long = new Set<number>();
  for (let i = 0; i < out.length; i++) {
    const l = out[i]!;
    if (l.length <= limit) continue;
    const key = ignoreTrimWhitespace ? l.trim() : l;
    out[i] = `\u0001${key.length}:${hashString(key)}`;
    long.add(i + 1);
  }
  return { lines: out, long };
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffix(a: string, b: string, prefix: number): number {
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/**
 * Pairs the long lines of one hunk, in order, maximising the shared prefix +
 * suffix (a tiny DP; hunks hold a handful of long lines). Returns index pairs
 * into `la`/`lb`; -1 marks a line without a partner.
 */
export function pairLongLines(la: readonly number[], lb: readonly number[], a: readonly string[], b: readonly string[]): [number, number][] {
  const n = la.length;
  const m = lb.length;
  const score = (i: number, j: number): number => {
    const x = a[la[i]! - 1]!;
    const y = b[lb[j]! - 1]!;
    const p = commonPrefix(x, y);
    return p + commonSuffix(x, y, p);
  };
  // best[i][j] = best total for la[i..], lb[j..]
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const pick: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const pair = score(i, j) + best[i + 1]![j + 1]!;
      const skipA = best[i + 1]![j]!;
      const skipB = best[i]![j + 1]!;
      if (pair >= skipA && pair >= skipB) {
        best[i]![j] = pair;
        pick[i]![j] = 0;
      } else if (skipA >= skipB) {
        best[i]![j] = skipA;
        pick[i]![j] = 1;
      } else {
        best[i]![j] = skipB;
        pick[i]![j] = 2;
      }
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const k = pick[i]![j];
    if (k === 0) out.push([i++, j++]);
    else if (k === 1) out.push([i++, -1]);
    else out.push([-1, j++]);
  }
  while (i < n) out.push([i++, -1]);
  while (j < m) out.push([-1, j++]);
  return out;
}

/**
 * Fixes the inner (character) ranges of hunks that touch long lines: drops
 * every inner range that starts, ends or spans over a long line (its columns
 * refer to the token), then adds one range per long line, pairing the long
 * lines of both sides (pairLongLines) and trimming each pair's common prefix
 * and suffix. A hunk left with no inner ranges gets none (whole-line highlight).
 */
export function fixLongLineChanges(
  changes: SerializedChange[],
  a: readonly string[],
  b: readonly string[],
  longA: ReadonlySet<number>,
  longB: ReadonlySet<number>,
): SerializedChange[] {
  if (longA.size === 0 && longB.size === 0) return changes;
  return changes.map((c) => {
    const [o0, o1, m0, m1, inner] = c;
    const la: number[] = [];
    const lb: number[] = [];
    for (let l = o0; l < o1; l++) if (longA.has(l)) la.push(l);
    for (let l = m0; l < m1; l++) if (longB.has(l)) lb.push(l);
    if (la.length === 0 && lb.length === 0) return c;
    const touchesLong = (s: number, e: number, set: ReadonlySet<number>): boolean => {
      for (let l = s; l <= e; l++) if (set.has(l)) return true;
      return false;
    };
    const kept = (inner ?? []).filter((r) => !touchesLong(r[0]!, r[2]!, longA) && !touchesLong(r[4]!, r[6]!, longB));
    for (const [i, j] of pairLongLines(la, lb, a, b)) {
      const lineA = i >= 0 ? la[i] : undefined;
      const lineB = j >= 0 ? lb[j] : undefined;
      const textA = lineA !== undefined ? a[lineA - 1]! : '';
      const textB = lineB !== undefined ? b[lineB - 1]! : '';
      if (lineA !== undefined && lineB !== undefined) {
        const p = commonPrefix(textA, textB);
        const s = commonSuffix(textA, textB, p);
        kept.push([lineA, p + 1, lineA, textA.length - s + 1, lineB, p + 1, lineB, textB.length - s + 1]);
      } else if (lineA !== undefined) {
        // Long line only on A: the whole line is removed; empty range on B at the hunk start.
        kept.push([lineA, 1, lineA, textA.length + 1, m0, 1, m0, 1]);
      } else if (lineB !== undefined) {
        kept.push([o0, 1, o0, 1, lineB, 1, lineB, textB.length + 1]);
      }
    }
    kept.sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]! || x[4]! - y[4]! || x[5]! - y[5]!);
    return [o0, o1, m0, m1, kept.length ? kept : undefined];
  });
}
