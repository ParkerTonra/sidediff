import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LARGE_BYTES, LARGE_LINES } from '../types';
import {
  DEGRADED_MAX_COMPUTATION_MS,
  MAX_COMPUTATION_MS,
  clampContextLines,
  countHunks,
  countLines,
  degradedInfo,
  hunkFromLineChange,
  indexFromLine,
  mapDiffOptions,
  mapStrippedColumn,
  nextIndex,
  stripWhitespace,
} from './pure';

describe('countHunks (INTERFACES.md counting rule)', () => {
  it('counts pure inserts, pure deletes and modified hunks', () => {
    expect(countHunks([{ a: 0, b: 5 }])).toEqual({ added: 5, removed: 0, modified: 0, changes: 1 });
    expect(countHunks([{ a: 4, b: 0 }])).toEqual({ added: 0, removed: 4, modified: 0, changes: 1 });
    expect(countHunks([{ a: 3, b: 3 }])).toEqual({ added: 0, removed: 0, modified: 3, changes: 1 });
  });

  it('splits uneven modified hunks into paired + surplus lines', () => {
    expect(countHunks([{ a: 2, b: 5 }])).toEqual({ added: 3, removed: 0, modified: 2, changes: 1 });
    expect(countHunks([{ a: 7, b: 1 }])).toEqual({ added: 0, removed: 6, modified: 1, changes: 1 });
  });

  it('sums across hunks', () => {
    expect(countHunks([{ a: 0, b: 300 }, { a: 300, b: 0 }, { a: 1, b: 1 }, { a: 2, b: 4 }])).toEqual({
      added: 302,
      removed: 300,
      modified: 3,
      changes: 4,
    });
    expect(countHunks([])).toEqual({ added: 0, removed: 0, modified: 0, changes: 0 });
  });
});

describe('hunkFromLineChange', () => {
  it('treats endLineNumber 0 as an empty side (Monaco ILineChange)', () => {
    expect(
      hunkFromLineChange({ originalStartLineNumber: 10, originalEndLineNumber: 0, modifiedStartLineNumber: 11, modifiedEndLineNumber: 13 }),
    ).toEqual({ a: 0, b: 3 });
    expect(
      hunkFromLineChange({ originalStartLineNumber: 4, originalEndLineNumber: 6, modifiedStartLineNumber: 3, modifiedEndLineNumber: 0 }),
    ).toEqual({ a: 3, b: 0 });
    expect(
      hunkFromLineChange({ originalStartLineNumber: 1, originalEndLineNumber: 1, modifiedStartLineNumber: 1, modifiedEndLineNumber: 2 }),
    ).toEqual({ a: 1, b: 2 });
  });
});

describe('degradedInfo', () => {
  const small = { lines: 10, bytes: 100 };
  it('is null at or under the limits', () => {
    expect(degradedInfo({ a: small, b: { lines: LARGE_LINES, bytes: LARGE_BYTES } })).toBeNull();
  });
  it('trips on lines or bytes, per side', () => {
    const d = degradedInfo({ a: { lines: LARGE_LINES + 1, bytes: 10 }, b: small });
    expect(d?.sides).toEqual(['a']);
    expect(d?.lines).toEqual({ a: LARGE_LINES + 1, b: 10 });
    const e = degradedInfo({ a: small, b: { lines: 5, bytes: LARGE_BYTES + 1 } });
    expect(e?.sides).toEqual(['b']);
    expect(e?.reason).toMatch(/MB/);
    const f = degradedInfo({ a: { lines: LARGE_LINES + 1, bytes: 0 }, b: { lines: 1, bytes: LARGE_BYTES + 1 } });
    expect(f?.sides).toEqual(['a', 'b']);
  });
});

describe('countLines', () => {
  it('counts like Monaco: every \\n, \\r\\n or \\r ends a line', () => {
    expect(countLines('')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(2);
    expect(countLines('a\r\nb\rc\nd')).toBe(4);
  });
});

describe('ignore all whitespace helpers', () => {
  it('strips every whitespace char except line breaks', () => {
    expect(stripWhitespace('  a b\t c \r\n d  e\n')).toBe('abc\r\nde\n');
  });

  it('maps stripped columns back to the real line', () => {
    const line = '  foo( a,  b )';
    // stripped: "foo(a,b)"; "a" is stripped col 5, real col 8
    expect(mapStrippedColumn(line, 5, false)).toBe(8);
    // range "a" = [5, 6) stripped → [8, 9) real
    expect(mapStrippedColumn(line, 6, true)).toBe(9);
    // start of line → before the first non-ws char
    expect(mapStrippedColumn(line, 1, false)).toBe(3);
    // end of stripped line → after the last non-ws char
    expect(mapStrippedColumn(line, 9, true)).toBe(line.length + 1);
    // start past the end → end of line
    expect(mapStrippedColumn(line, 9, false)).toBe(line.length + 1);
    // empty range at start (end col 1)
    expect(mapStrippedColumn(line, 1, true)).toBe(3);
  });
});

describe('mapDiffOptions', () => {
  const d = DEFAULT_SETTINGS.diff;

  it('maps the defaults', () => {
    const m = mapDiffOptions(d, false);
    expect(m.ignoreTrimWhitespace).toBe(true);
    expect(m.renderSideBySide).toBe(true);
    expect(m.useInlineViewWhenSpaceIsLimited).toBe(false);
    expect(m.wordWrap).toBe('off');
    expect(m.minimap.enabled).toBe(true);
    expect(m.folding).toBe(true);
    expect(m.hideUnchangedRegions).toEqual({ enabled: false, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 });
    expect(m.maxComputationTime).toBe(MAX_COMPUTATION_MS);
    expect(m.fontSize).toBe(13);
  });

  it('maps view mode, wrap, diff-only and context lines', () => {
    const m = mapDiffOptions({ ...d, viewMode: 'inline', wordWrap: true, diffOnly: true, contextLines: 7 }, false);
    expect(m.renderSideBySide).toBe(false);
    expect(m.wordWrap).toBe('on');
    expect(m.hideUnchangedRegions.enabled).toBe(true);
    expect(m.hideUnchangedRegions.contextLineCount).toBe(7);
  });

  it('clamps context lines to 0..20', () => {
    expect(mapDiffOptions({ ...d, contextLines: 99 }, false).hideUnchangedRegions.contextLineCount).toBe(20);
    expect(mapDiffOptions({ ...d, contextLines: -4 }, false).hideUnchangedRegions.contextLineCount).toBe(0);
    expect(clampContextLines(Number.NaN)).toBe(3);
  });

  it('turns off costly features in degraded mode', () => {
    const m = mapDiffOptions({ ...d, wordWrap: true, minimap: true }, true);
    expect(m.wordWrap).toBe('off');
    expect(m.minimap.enabled).toBe(false);
    expect(m.folding).toBe(false);
    expect(m.maxComputationTime).toBe(DEGRADED_MAX_COMPUTATION_MS);
    expect(DEGRADED_MAX_COMPUTATION_MS).toBeLessThan(60_000);
    expect(MAX_COMPUTATION_MS).toBeLessThanOrEqual(DEGRADED_MAX_COMPUTATION_MS);
  });
});

describe('navigation', () => {
  it('nextIndex wraps around', () => {
    expect(nextIndex(0, 5, 1)).toBe(1);
    expect(nextIndex(0, 5, -1)).toBe(5);
    expect(nextIndex(5, 5, 1)).toBe(1);
    expect(nextIndex(1, 5, -1)).toBe(5);
    expect(nextIndex(2, 5, 1)).toBe(3);
    expect(nextIndex(3, 0, 1)).toBe(0);
  });

  it('indexFromLine picks the change after/before the cursor, wrapping', () => {
    const starts = [10, 20, 30];
    expect(indexFromLine(starts, 15, 1)).toBe(2);
    expect(indexFromLine(starts, 30, 1)).toBe(1);
    expect(indexFromLine(starts, 15, -1)).toBe(1);
    expect(indexFromLine(starts, 10, -1)).toBe(3);
    expect(indexFromLine([], 1, 1)).toBe(0);
  });
});
