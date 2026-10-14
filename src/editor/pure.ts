// Pure helpers for the diff engine: no Monaco, no DOM. Unit tested in
// pure.test.ts (node environment).
import { LARGE_BYTES, LARGE_LINES, CONTEXT_LINES_MAX, CONTEXT_LINES_MIN } from '../types';
import type { DegradedInfo, DiffOptions, DiffStats, Side } from '../types';

/** One line-change hunk: how many lines it spans on each side. */
export interface HunkSize {
  a: number;
  b: number;
}

/** Counting rule from docs/INTERFACES.md ("DiffStats counting rule"). */
export function countHunks(hunks: readonly HunkSize[]): Pick<DiffStats, 'added' | 'removed' | 'modified' | 'changes'> {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const { a, b } of hunks) {
    if (a === 0) {
      added += b;
    } else if (b === 0) {
      removed += a;
    } else {
      modified += Math.min(a, b);
      added += Math.max(0, b - a);
      removed += Math.max(0, a - b);
    }
  }
  return { added, removed, modified, changes: hunks.length };
}

/**
 * Hunk size from Monaco's ILineChange line numbers. Monaco marks an empty side
 * with endLineNumber 0 (the start is the line before/after the gap).
 */
export function hunkFromLineChange(c: {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}): HunkSize {
  const a = c.originalEndLineNumber === 0 ? 0 : c.originalEndLineNumber - c.originalStartLineNumber + 1;
  const b = c.modifiedEndLineNumber === 0 ? 0 : c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
  return { a, b };
}

export interface SideSize {
  lines: number;
  bytes: number;
}

/** Degraded-mode decision. Returns null when both sides are under the limits. */
export function degradedInfo(sizes: Record<Side, SideSize>): DegradedInfo | null {
  const sides: Side[] = [];
  const reasons: string[] = [];
  for (const side of ['a', 'b'] as const) {
    const s = sizes[side];
    if (s.lines > LARGE_LINES) {
      sides.push(side);
      reasons.push(`${side.toUpperCase()} has ${s.lines.toLocaleString('en-US')} lines (limit ${LARGE_LINES.toLocaleString('en-US')})`);
    } else if (s.bytes > LARGE_BYTES) {
      sides.push(side);
      reasons.push(`${side.toUpperCase()} is ${(s.bytes / 1024 / 1024).toFixed(1)} MB (limit ${LARGE_BYTES / 1024 / 1024} MB)`);
    }
  }
  if (sides.length === 0) return null;
  return {
    sides,
    lines: { a: sizes.a.lines, b: sizes.b.lines },
    bytes: { a: sizes.a.bytes, b: sizes.b.bytes },
    reason: `${reasons.join('; ')}. Intra-line highlighting, minimap, folding and word wrap are off.`,
  };
}

/** Line count the way Monaco counts it: \r\n, \r and \n each end a line. */
export function countLines(text: string): number {
  let lines = 1;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) lines++;
    else if (c === 13) {
      lines++;
      if (text.charCodeAt(i + 1) === 10) i++;
    }
  }
  return lines;
}

export function clampContextLines(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.min(CONTEXT_LINES_MAX, Math.max(CONTEXT_LINES_MIN, Math.round(n)));
}

/** Whitespace that "ignore all whitespace" removes: everything except line breaks. */
const NON_NEWLINE_WS = /[^\S\r\n]+/g;

export function stripWhitespace(text: string): string {
  return text.replace(NON_NEWLINE_WS, '');
}

function isWs(c: number): boolean {
  // Matches /\s/ minus line breaks for the characters that occur in practice.
  return c === 32 || c === 9 || c === 11 || c === 12 || c === 160 || c === 0xfeff || (c >= 0x2000 && c <= 0x200a) || c === 0x3000;
}

/**
 * Maps a 1-based column in a whitespace-stripped line back to the real line.
 * A start column lands before the matching non-whitespace character; an end
 * column (exclusive) lands right after the previous one, so ranges never grow
 * to swallow the whitespace around them.
 */
export function mapStrippedColumn(line: string, col: number, isEnd: boolean): number {
  const target = isEnd ? col - 2 : col - 1; // index of the non-ws char we anchor to
  if (target < 0) {
    if (!isEnd) return 1;
    // Empty range at the start: anchor before the first non-ws char.
    return mapStrippedColumn(line, 1, false);
  }
  let seen = 0;
  for (let i = 0; i < line.length; i++) {
    if (isWs(line.charCodeAt(i))) continue;
    if (seen === target) return isEnd ? i + 2 : i + 1;
    seen++;
  }
  return line.length + 1;
}

export type MonacoWrap = 'on' | 'off';

/** The subset of Monaco diff editor options that DiffOptions + degraded control. */
export interface MappedDiffEditorOptions {
  ignoreTrimWhitespace: boolean;
  renderSideBySide: boolean;
  useInlineViewWhenSpaceIsLimited: false;
  wordWrap: MonacoWrap;
  diffWordWrap: 'inherit';
  fontSize: number;
  minimap: { enabled: boolean };
  folding: boolean;
  hideUnchangedRegions: {
    enabled: boolean;
    contextLineCount: number;
    minimumLineCount: number;
    revealLineCount: number;
  };
  maxComputationTime: number;
}

/**
 * Time budget for the diff algorithm. Real edits on 150k lines finish in
 * well under a second, but two unrelated files make Myers run for minutes
 * and block the worker for every later diff. Past the budget Monaco returns
 * an approximate result (stats.quitEarly = true). Measured: see STATUS.md.
 */
export const MAX_COMPUTATION_MS = 10_000;
/** Degraded mode allows more time, still well inside the 60 s watchdog. */
export const DEGRADED_MAX_COMPUTATION_MS = 30_000;
/** Watchdog: emit diff:error when no result arrives within this time. */
export const DIFF_TIMEOUT_MS = 60_000;

export function mapDiffOptions(o: DiffOptions, degraded: boolean): MappedDiffEditorOptions {
  return {
    ignoreTrimWhitespace: o.ignoreTrimWhitespace,
    renderSideBySide: o.viewMode === 'side-by-side',
    // Never let Monaco silently switch to inline: the user's choice wins.
    useInlineViewWhenSpaceIsLimited: false,
    // Word wrap computes line breaks for every line on the main thread; too costly above the limits.
    wordWrap: o.wordWrap && !degraded ? 'on' : 'off',
    diffWordWrap: 'inherit',
    fontSize: o.fontSize,
    minimap: { enabled: o.minimap && !degraded },
    folding: !degraded,
    hideUnchangedRegions: {
      enabled: o.diffOnly,
      contextLineCount: clampContextLines(o.contextLines),
      // Collapse any unchanged run that is longer than the context on both sides.
      minimumLineCount: 3,
      revealLineCount: 20,
    },
    maxComputationTime: degraded ? DEGRADED_MAX_COMPUTATION_MS : MAX_COMPUTATION_MS,
  };
}

/** Change navigation. Indices are 1-based; 0 = none. Wraps around. */
export function nextIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  if (current <= 0) return dir === 1 ? 1 : total;
  const n = current + dir;
  if (n > total) return 1;
  if (n < 1) return total;
  return n;
}

/**
 * Picks the next/previous change relative to a cursor line when the cursor
 * is not on the current change. `starts` are the change start lines, sorted.
 */
export function indexFromLine(starts: readonly number[], line: number, dir: 1 | -1): number {
  if (starts.length === 0) return 0;
  if (dir === 1) {
    for (let i = 0; i < starts.length; i++) if ((starts[i] ?? 0) > line) return i + 1;
    return 1;
  }
  for (let i = starts.length - 1; i >= 0; i--) if ((starts[i] ?? 0) < line) return i + 1;
  return starts.length;
}
