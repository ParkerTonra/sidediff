// Fixture generator determinism, the DiffStats counting rule, and the
// committed *.changes.json math.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countHunks, monacoDiffStats, withinTolerance } from '../../scripts/lib/diff-stats.ts';
import { EDIT_GAP, FIXTURE_SPECS, generatePair } from '../../scripts/lib/fixture-gen.ts';
import type { FixtureSpec, GeneratedPair } from '../../scripts/lib/fixture-gen.ts';
import { createRng } from '../../scripts/lib/rng.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

interface Sidecar {
  seed: number;
  a: { lines: number; bytes: number; sha256: string };
  b: { lines: number; bytes: number; sha256: string };
  edits: GeneratedPair['edits'];
  expected: GeneratedPair['constructed'];
  constructed: GeneratedPair['constructed'];
  tolerance: { relative: number; absolute: number };
}
const sidecar = (name: string): Sidecar => JSON.parse(readFileSync(join(ROOT, 'fixtures', `${name}.changes.json`), 'utf8')) as Sidecar;
const spec = (name: string): FixtureSpec => {
  const s = FIXTURE_SPECS.find((x) => x.name === name);
  if (!s) throw new Error(`no spec ${name}`);
  return s;
};

const cache = new Map<string, GeneratedPair>();
const pair = (name: string): GeneratedPair => {
  let p = cache.get(name);
  if (!p) cache.set(name, (p = generatePair(spec(name))));
  return p;
};

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const xs = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('int stays in range and hits both ends', () => {
    const r = createRng(7);
    const seen = new Set(Array.from({ length: 2000 }, () => r.int(3, 6)));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });
});

describe('DiffStats counting rule (docs/INTERFACES.md)', () => {
  it('counts pure inserts, pure deletes and modified hunks', () => {
    expect(countHunks([{ a: 0, b: 5 }])).toEqual({ added: 5, removed: 0, modified: 0, changes: 1 });
    expect(countHunks([{ a: 4, b: 0 }])).toEqual({ added: 0, removed: 4, modified: 0, changes: 1 });
    expect(countHunks([{ a: 1, b: 1 }])).toEqual({ added: 0, removed: 0, modified: 1, changes: 1 });
  });

  it('splits uneven hunks into modified plus surplus', () => {
    expect(countHunks([{ a: 2, b: 5 }])).toEqual({ added: 3, removed: 0, modified: 2, changes: 1 });
    expect(countHunks([{ a: 6, b: 1 }])).toEqual({ added: 0, removed: 5, modified: 1, changes: 1 });
    expect(countHunks([{ a: 2, b: 5 }, { a: 6, b: 1 }, { a: 0, b: 1 }])).toEqual({ added: 4, removed: 5, modified: 3, changes: 3 });
  });

  it('has no hunks for identical input', () => {
    expect(countHunks([])).toEqual({ added: 0, removed: 0, modified: 0, changes: 0 });
  });

  it('tolerance is relative plus absolute', () => {
    const tol = { relative: 0.02, absolute: 3 };
    expect(withinTolerance(1478 + 32, 1478, tol)).toBe(true); // 29.56 + 3
    expect(withinTolerance(1478 + 33, 1478, tol)).toBe(false);
    expect(withinTolerance(3, 0, tol)).toBe(true);
    expect(withinTolerance(4, 0, tol)).toBe(false);
  });
});

describe('fixture generator', () => {
  it('is deterministic: regenerated text matches the committed sha256 for every pair', () => {
    for (const s of FIXTURE_SPECS) {
      if (s.name === 'stress') continue; // 60 MB; covered by its constructed stats below
      const p = pair(s.name);
      const c = sidecar(s.name);
      expect(sha256(p.a), `${s.name} A`).toBe(c.a.sha256);
      expect(sha256(p.b), `${s.name} B`).toBe(c.b.sha256);
      expect(p.a.split('\n').length).toBe(c.a.lines);
      expect(p.b.split('\n').length).toBe(c.b.lines);
    }
  });

  it('two runs with the same seed give identical output', () => {
    const again = generatePair(spec('small'));
    expect(again.a).toBe(pair('small').a);
    expect(again.b).toBe(pair('small').b);
  });

  it('sizes match section 7', () => {
    const lines = (n: string): number => sidecar(n).a.lines;
    expect(lines('small')).toBeGreaterThanOrEqual(2_000);
    expect(lines('small')).toBeLessThan(2_600);
    expect(lines('medium')).toBeGreaterThanOrEqual(30_000);
    expect(lines('medium')).toBeLessThan(31_000);
    expect(lines('large')).toBeGreaterThanOrEqual(150_000);
    expect(lines('large')).toBeLessThan(151_000);
    expect(lines('stress')).toBeGreaterThanOrEqual(500_000);
    expect(lines('csharp-large')).toBeGreaterThanOrEqual(150_000);
    const mb = sidecar('large').a.bytes / 1024 / 1024;
    expect(mb).toBeGreaterThanOrEqual(8);
    expect(mb).toBeLessThanOrEqual(12);
    // stress must trip degraded mode by lines but stay under the byte limit
    expect(sidecar('stress').a.bytes).toBeLessThan(40 * 1024 * 1024);
  });

  it('XML is Acumatica-shaped: Customization root, balanced Graph/Page/Table/File, C# in CDATA', () => {
    const { a } = pair('medium');
    expect(a.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<Customization level="100" description="')).toBe(true);
    expect(a).toContain('product-version="24.200.0000"');
    expect(a.trimEnd().endsWith('</Customization>')).toBe(true);
    for (const tag of ['Graph', 'Page', 'Table', 'File']) {
      const open = a.match(new RegExp(`^<${tag}[ >]`, 'gm'))?.length ?? 0;
      const close = a.match(new RegExp(`^</${tag}>$`, 'gm'))?.length ?? 0;
      expect(open, tag).toBeGreaterThan(10);
      expect(close, tag).toBe(open);
    }
    const cdata = [...a.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => (m[1] ?? '').split('\n').length);
    expect(cdata.length).toBeGreaterThan(50);
    expect(Math.min(...cdata)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...cdata)).toBeLessThanOrEqual(402);
    expect(a).toMatch(/PXGraphExtension<\w+>/);
    expect(a).toMatch(/PXCacheExtension<\w+>/);
    expect(a).toMatch(/\[PXUIField\(DisplayName = "/);
    expect(a).toMatch(/\.Where\(l => /);
    expect(a.split('\n').some((l) => l.length > 500 && /pageSource="[A-Za-z0-9+/]+=*"/.test(l))).toBe(true);
  });

  it('C# fixture starts with using and has no XML', () => {
    const { a } = pair('csharp-large');
    expect(a.startsWith('using System;')).toBe(true);
    expect(a).not.toContain('<![CDATA[');
  });

  it('applies every edit kind, the 300-line blocks and a move', () => {
    for (const name of ['medium', 'large', 'csharp-large']) {
      const e = sidecar(name).edits;
      expect(e.attrValue, name).toBeGreaterThan(0);
      expect(e.csToken, name).toBeGreaterThan(0);
      expect(e.whitespace, name).toBeGreaterThan(0);
      expect(e.attrReorder, name).toBeGreaterThan(0);
      expect(e.blockInsert.lines, name).toBe(300);
      expect(e.blockDelete.lines, name).toBe(300);
      expect(e.move.lines, name).toBeGreaterThanOrEqual(3);
      expect(Math.abs(e.move.toBeforeLineA - e.move.fromLineA)).toBeGreaterThan(EDIT_GAP * 10);
    }
    // ~2% of lines touched in the large pair (1.5% scattered + blocks + move)
    const l = sidecar('large');
    const touched = l.edits.attrValue + l.edits.csToken + l.edits.whitespace + l.edits.attrReorder + 600 + 2 * l.edits.move.lines;
    expect(touched / l.a.lines).toBeGreaterThan(0.015);
    expect(touched / l.a.lines).toBeLessThan(0.025);
  });

  it('whitespace edits only touch leading/trailing whitespace', () => {
    const { a, b, edits } = pair('small');
    // Same lines modulo trim: every A line that is not in a block/move appears trimmed in B.
    const trimmedB = new Set(b.split('\n').map((x) => x.trim()));
    const missing = a.split('\n').filter((x) => !trimmedB.has(x.trim()));
    // Lines missing after trimming: deleted block + visible single-line edits (the moved element is still present).
    expect(missing.length).toBeLessThanOrEqual(edits.blockDelete.lines + edits.attrValue + edits.csToken + edits.attrReorder);
  });
});

describe('changes.json math', () => {
  it('constructed stats follow from the edit list', () => {
    for (const s of FIXTURE_SPECS) {
      const c = sidecar(s.name);
      const { edits: e } = c;
      const visible = e.attrValue + e.csToken + e.attrReorder;
      expect(c.constructed.trimWhitespace, s.name).toEqual({
        added: e.blockInsert.lines + e.move.lines,
        removed: e.blockDelete.lines + e.move.lines,
        modified: visible,
        changes: visible + 4,
      });
      expect(c.constructed.noTrimWhitespace.modified, s.name).toBe(visible + e.whitespace);
      expect(c.constructed.noTrimWhitespace.changes, s.name).toBe(visible + e.whitespace + 4);
      // Generator output for the same spec must agree with what is committed.
      if (s.name !== 'stress') expect(pair(s.name).constructed).toEqual(c.constructed);
    }
  });

  it('expected stats (from Monaco) agree with the constructed ones within tolerance', () => {
    for (const s of FIXTURE_SPECS) {
      const c = sidecar(s.name);
      for (const mode of ['trimWhitespace', 'noTrimWhitespace'] as const) {
        for (const k of ['added', 'removed', 'modified', 'changes'] as const) {
          expect(withinTolerance(c.expected[mode][k], c.constructed[mode][k], c.tolerance), `${s.name} ${mode} ${k}`).toBe(true);
        }
      }
    }
  });

  it("Monaco's line diff on the regenerated small and medium pairs reproduces the committed expectations", async () => {
    for (const name of ['small', 'medium']) {
      const p = pair(name);
      const c = sidecar(name);
      const trim = await monacoDiffStats(p.a, p.b, true);
      const noTrim = await monacoDiffStats(p.a, p.b, false);
      expect({ added: trim.added, removed: trim.removed, modified: trim.modified, changes: trim.changes }).toEqual(c.expected.trimWhitespace);
      expect({ added: noTrim.added, removed: noTrim.removed, modified: noTrim.modified, changes: noTrim.changes }).toEqual(c.expected.noTrimWhitespace);
      expect(trim.hitTimeout).toBe(false);
    }
  });
});
