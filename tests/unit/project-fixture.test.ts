// The `project` fixture pair and its sidecar (explorer expectations).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateProjectPair, GROUP_ORDER } from '../../scripts/lib/project-gen.ts';
import type { ExpectedItem } from '../../scripts/lib/project-gen.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const sidecar = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'project.changes.json'), 'utf8')) as {
  a: { lines: number; sha256: string; root: Record<string, string> };
  b: { lines: number; sha256: string; root: Record<string, string> };
  counts: { total: number; byStatus: Record<string, number>; byGroup: Record<string, number> };
  cdataSplit: { id: string; mustContain: string };
  edits: Record<string, string[]>;
  items: ExpectedItem[];
};
const p = generateProjectPair();
const item = (id: string): ExpectedItem => {
  const it = sidecar.items.find((x) => x.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};

describe('project fixture', () => {
  it('regenerates byte-identical to the committed sidecar', () => {
    expect(sha256(p.a)).toBe(sidecar.a.sha256);
    expect(sha256(p.b)).toBe(sidecar.b.sha256);
    expect(p.items).toEqual(sidecar.items);
  });

  it('is about 20k lines a side with a changed product-version', () => {
    for (const s of [sidecar.a, sidecar.b]) {
      expect(s.lines).toBeGreaterThan(18_000);
      expect(s.lines).toBeLessThan(22_000);
    }
    expect(sidecar.a.root['product-version']).not.toBe(sidecar.b.root['product-version']);
    expect(p.a).toContain(`product-version="${sidecar.a.root['product-version'] ?? ''}"`);
    expect(p.b).toContain(`product-version="${sidecar.b.root['product-version'] ?? ''}"`);
  });

  it('has every element kind the contract classifies, plus unknown ones in other', () => {
    const elements = new Set(sidecar.items.map((i) => i.element));
    for (const e of ['Graph', 'File', 'Page', 'Table', 'Sql', 'Report', 'SiteMapNode', 'GenericInquiryScreen', 'EntityEndpoint']) expect(elements, e).toContain(e);
    const others = sidecar.items.filter((i) => i.group === 'other');
    expect(new Set(others.map((i) => i.element)).size).toBeGreaterThanOrEqual(2);
    expect(others.every((i) => i.detail === i.element)).toBe(true);
    const fileTypes = new Set([...p.a.matchAll(/FileType="(\w+)"/g)].map((m) => m[1]));
    expect([...fileTypes].sort()).toEqual(['ExistingDac', 'ExistingGraph', 'NewDac', 'NewGraph']);
    expect(sidecar.items.some((i) => i.element === 'File' && i.group === 'files')).toBe(true);
    expect(sidecar.items.some((i) => i.element === 'File' && i.group === 'code')).toBe(true);
    expect(sidecar.items.some((i) => i.element === 'Page' && i.views[0] === 'code')).toBe(true);
  });

  it('covers every status, duplicates and moves', () => {
    for (const s of ['same', 'whitespace', 'modified', 'only-a', 'only-b']) expect(sidecar.counts.byStatus[s], s).toBeGreaterThan(0);
    expect(item('Table:SOLine').status).toBe('same');
    expect(item('Table:SOLine#2').status).toBe('modified');
    for (const key of sidecar.edits.moved ?? []) {
      const it = sidecar.items.find((i) => i.key === key);
      expect(it?.status, key).toBe('same');
      expect(it?.a?.startLine).not.toBe(it?.b?.startLine);
    }
    expect(sidecar.items.filter((i) => i.status === 'only-a').every((i) => i.a && !i.b)).toBe(true);
    expect(sidecar.items.filter((i) => i.status === 'only-b').every((i) => i.b && !i.a)).toBe(true);
  });

  it('counts add up and items are sorted by group order then name', () => {
    const { counts, items } = sidecar;
    expect(items.length).toBe(counts.total);
    expect(Object.values(counts.byStatus).reduce((x, y) => x + y, 0)).toBe(counts.total);
    expect(Object.values(counts.byGroup).reduce((x, y) => x + y, 0)).toBe(counts.total);
    const order = items.map((i) => GROUP_ORDER.indexOf(i.group));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('line ranges point at the element in each file', () => {
    const linesA = p.a.split('\n');
    const linesB = p.b.split('\n');
    for (const it of sidecar.items) {
      for (const [r, lines] of [[it.a, linesA], [it.b, linesB]] as const) {
        if (!r) continue;
        expect(lines[r.startLine - 1]?.startsWith(`<${it.element}`), it.id).toBe(true);
        expect(lines[r.endLine - 1], it.id).toBe(`</${it.element}>`);
      }
    }
  });

  it('splits a literal "]]>" across CDATA sections on both sides', () => {
    const it = item(sidecar.cdataSplit.id);
    for (const [text, r] of [[p.a, it.a], [p.b, it.b]] as const) {
      const el = text.split('\n').slice((r?.startLine ?? 1) - 1, r?.endLine).join('\n');
      expect(el).toContain(']]]]><![CDATA[>');
      const joined = el.replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>');
      expect(joined).toContain(sidecar.cdataSplit.mustContain);
    }
  });
});
