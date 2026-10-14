import { describe, expect, it } from 'vitest';
import { fuzzyItem, fuzzyMatch, fuzzyScore } from './fuzzy';

describe('fuzzy', () => {
  it('matches subsequences case-insensitively and rejects non-matches', () => {
    expect(fuzzyScore('soe', 'SOOrderEntry_Extension')).not.toBeNull();
    expect(fuzzyScore('SOEX', 'SOOrderEntry_Extension')).not.toBeNull();
    expect(fuzzyScore('xyz', 'SOOrderEntry_Extension')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers substrings, then word starts', () => {
    const sub = fuzzyScore('order', 'SOOrderEntry')!;
    const scattered = fuzzyScore('order', 'ObjectRiderDetailEntry')!;
    expect(sub).toBeGreaterThan(scattered);
    expect(fuzzyScore('oe', 'OrderEntry')!).toBeGreaterThan(fuzzyScore('oe', 'aboutthetree')!);
    expect(fuzzyScore('so3', 'SO301000')!).toBeGreaterThan(fuzzyScore('so3', 'ARSO1003')!);
  });

  it('ranks a prefix match first among several names', () => {
    const names = ['APInvoiceEntry_Extension', 'SOOrderEntry_Extension', 'POOrderEntry_Extension', 'SOShipmentEntry_Extension'];
    const ranked = names
      .map((n) => [n, fuzzyScore('soorder', n)] as const)
      .filter((x): x is readonly [string, number] => x[1] !== null)
      .sort((a, b) => b[1] - a[1]);
    expect(ranked[0]?.[0]).toBe('SOOrderEntry_Extension');
  });

  it('requires every space-separated term', () => {
    expect(fuzzyMatch('graph so', 'SOOrderEntry Graph extension')).not.toBeNull();
    expect(fuzzyMatch('graph zz', 'SOOrderEntry Graph extension')).toBeNull();
  });

  it('matches items by name or detail, weighting the name', () => {
    expect(fuzzyItem('aspx', 'SO301000', '~/pages/so/so301000.aspx')).not.toBeNull();
    expect(fuzzyItem('', 'x', 'y')).toBe(0);
    expect(fuzzyItem('nomatch', 'SO301000', 'Sales Orders')).toBeNull();
    expect(fuzzyItem('so301', 'SO301000', '')!).toBeGreaterThan(fuzzyItem('so301', 'Other', 'SO301000')!);
  });
});
