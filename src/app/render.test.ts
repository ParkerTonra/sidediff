import { describe, expect, it } from 'vitest';
import type { AssemblyInfo } from '../types';
import { outline } from './asm';
import { diffRows, formatSize, hexDump } from './render';

describe('diffRows', () => {
  const a = { heading: 'Roles', columns: ['Role', 'Rights'], keyColumn: 0, rows: [['Admin', 'Delete'], ['Clerk', 'Edit'], ['Old', 'View']] };
  const b = { heading: 'Roles', columns: ['Role', 'Rights'], keyColumn: 0, rows: [['Clerk', 'View'], ['Admin', 'Delete'], ['New', 'View']] };

  it('matches rows by key column, regardless of order', () => {
    const rows = diffRows(a, b);
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['Admin', 'same'],
      ['Clerk', 'modified'],
      ['Old', 'only-a'],
      ['New', 'only-b'],
    ]);
  });

  it('compares whole rows when there is no key column', () => {
    const rows = diffRows({ ...a, keyColumn: undefined }, { ...b, keyColumn: undefined });
    expect(rows.filter((r) => r.status === 'same')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'only-a')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'only-b')).toHaveLength(2);
  });

  it('handles a missing side', () => {
    expect(diffRows(a, undefined).every((r) => r.status === 'only-a')).toBe(true);
    expect(diffRows(undefined, b).every((r) => r.status === 'only-b')).toBe(true);
  });
});

describe('hexDump', () => {
  it('prints offset, hex and printable ASCII', () => {
    const bytes = new TextEncoder().encode('MZ hello\x00\x01');
    const [line] = hexDump(bytes).split('\n');
    expect(line).toMatch(/^00000000 {2}4d 5a 20 68 65 6c 6c 6f 00 01/);
    expect(line?.endsWith('MZ hello..')).toBe(true);
  });

  it('stops at the limit', () => {
    expect(hexDump(new Uint8Array(100), 32).split('\n')).toHaveLength(2);
  });
});

describe('formatSize', () => {
  it('uses B, KB, MB', () => {
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('assembly outline', () => {
  it('is sorted and stable, one line per type and member', () => {
    const info: AssemblyInfo = {
      name: 'X', version: '1.0.0.0', references: [], stringCount: 0,
      types: [
        { fullName: 'N.B', namespace: 'N', name: 'B', kind: 'class', visibility: 'public', interfaces: [], attributes: [], token: 2, members: [{ kind: 'method', name: 'Z', signature: 'void Z()', attributes: [], token: 5 }, { kind: 'method', name: 'A', signature: 'void A()', attributes: ['PXOverride'], token: 4 }] },
        { fullName: 'N.A', namespace: 'N', name: 'A', kind: 'class', visibility: 'internal', baseType: 'object', interfaces: [], attributes: [], token: 1, members: [] },
      ],
    };
    const text = outline(info);
    expect(text.indexOf('internal class N.A')).toBeLessThan(text.indexOf('public class N.B'));
    expect(text).toContain('    [PXOverride]\n    void A()\n    void Z()');
    expect(outline(null)).toBe('');
  });
});
