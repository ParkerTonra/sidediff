import { describe, expect, it } from 'vitest';
import { LONG_LINE, fixLongLineChanges, hashString, maskLongLines, pairLongLines } from './long-lines';
import type { SerializedChange } from './diff-worker-protocol';

const long = (c: string, n = 2000): string => c.repeat(n);

describe('maskLongLines', () => {
  it('replaces only lines over the limit, by content hash', () => {
    expect(LONG_LINE).toBe(1000);
    const lines = ['short', long('x'), long('x'), long('y'), 'x'.repeat(1000)];
    const m = maskLongLines(lines, false);
    expect([...m.long]).toEqual([2, 3, 4]);
    expect(m.lines[0]).toBe('short');
    expect(m.lines[4]).toBe('x'.repeat(1000));
    expect(m.lines[1]).toBe(m.lines[2]); // same content → same token
    expect(m.lines[1]).not.toBe(m.lines[3]);
    expect(m.lines[1]!.length).toBeLessThan(30);
  });

  it('hashes the trimmed line when trim-whitespace is on', () => {
    const a = maskLongLines(['  ' + long('z') + ' '], true);
    const b = maskLongLines([long('z')], true);
    expect(a.lines[0]).toBe(b.lines[0]);
    expect(maskLongLines(['  ' + long('z')], false).lines[0]).not.toBe(maskLongLines([long('z')], false).lines[0]);
  });

  it('hashString is stable and spreads', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('pairLongLines', () => {
  it('pairs in order by best shared prefix + suffix, leaving the odd one out', () => {
    const a = ['', 'Q'.repeat(1200), 'pageSource="' + long('A') + '"'];
    const b = ['pageSource="' + long('A') + 'B"'];
    // Hunk A lines 2, 3 vs B line 1: line 3 is the real partner.
    expect(pairLongLines([2, 3], [1], a, b)).toEqual([
      [0, -1],
      [1, 0],
    ]);
  });
});

describe('fixLongLineChanges', () => {
  it('keeps ranges on normal lines and trims a changed long line to its differing middle', () => {
    const head = 'data="';
    const a = ['same', 'tiny change a', head + long('Q') + 'OLD' + long('R') + '"'];
    const b = ['same', 'tiny change b', head + long('Q') + 'NEWER' + long('R') + '"'];
    const longA = new Set([3]);
    const longB = new Set([3]);
    const changes: SerializedChange[] = [
      [
        2,
        4,
        2,
        4,
        [
          [2, 13, 2, 14, 2, 13, 2, 14], // normal line: kept
          [3, 5, 3, 9, 3, 5, 3, 9], // token columns: dropped
        ],
      ],
    ];
    const [c] = fixLongLineChanges(changes, a, b, longA, longB);
    const start = head.length + 2000 + 1;
    expect(c).toEqual([
      2,
      4,
      2,
      4,
      [
        [2, 13, 2, 14, 2, 13, 2, 14],
        [3, start, 3, start + 3, 3, start, 3, start + 5],
      ],
    ]);
  });

  it('leaves hunks without long lines untouched', () => {
    const changes: SerializedChange[] = [[1, 2, 1, 2, [[1, 1, 1, 2, 1, 1, 1, 2]]]];
    expect(fixLongLineChanges(changes, ['a'], ['b'], new Set([5]), new Set())[0]).toBe(changes[0]);
    expect(fixLongLineChanges(changes, ['a'], ['b'], new Set(), new Set())).toBe(changes);
  });

  it('an unpaired long line covers the whole line', () => {
    const a = [long('k')];
    const b = ['x'];
    const [c] = fixLongLineChanges([[1, 2, 1, 2, undefined]], a, b, new Set([1]), new Set());
    expect(c![4]).toEqual([[1, 1, 1, 2001, 1, 1, 1, 1]]);
  });
});
