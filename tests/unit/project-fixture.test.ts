// The `project` fixture pair and its sidecar (explorer expectations).
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
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
  relatedScreen: { screenId: string; ids: string[] };
  pageSource: { id: string; mustContain: string };
  edits: Record<string, string[]>;
  items: ExpectedItem[];
};
const p = generateProjectPair();
const item = (id: string): ExpectedItem => {
  const it = sidecar.items.find((x) => x.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};
const LF = '\n';
const CR = '\r';

describe('project fixture', () => {
  it('regenerates byte-identical to the committed sidecar', () => {
    expect(sha256(p.a)).toBe(sidecar.a.sha256);
    expect(sha256(p.b)).toBe(sidecar.b.sha256);
    expect(p.items).toEqual(sidecar.items);
  });

  it('is about 20k lines a side with a changed product-version', () => {
    for (const s of [sidecar.a, sidecar.b]) {
      expect(s.lines).toBeGreaterThan(17_000);
      expect(s.lines).toBeLessThan(22_000);
    }
    expect(sidecar.a.root['product-version']).not.toBe(sidecar.b.root['product-version']);
    expect(p.a).toContain(`product-version="${sidecar.a.root['product-version'] ?? ''}"`);
    expect(p.b).toContain(`product-version="${sidecar.b.root['product-version'] ?? ''}"`);
  });

  it('has every element kind the contract classifies, plus unknown ones in other', () => {
    const elements = new Set(sidecar.items.map((i) => i.element));
    for (const e of ['Graph', 'DAC', 'File', 'PerTenantFile', 'Page', 'EditorUpdatedFields', 'Table', 'Sql', 'Report', 'SiteMapNode', 'GenericInquiryScreen', 'EntityEndpoint']) expect(elements, e).toContain(e);
    // Phase 5 kinds and their groups.
    const phase5: [string, string][] = [['ScreenWithRights', 'security'], ['Automation', 'screens'], ['MobileSiteMap', 'sitemap'], ['XportScenario', 'integration'], ['CSAttribute', 'tables'], ['DashboardV2', 'inquiries']];
    for (const [e, g] of phase5) {
      const its = sidecar.items.filter((i) => i.element === e);
      expect(its.length, e).toBeGreaterThan(0);
      expect(its.every((i) => i.group === g), e).toBe(true);
    }
    expect(item('ScreenWithRights:SO301000').status).toBe('modified');
    expect(item('CSAttribute:CTZONE').status).toBe('modified');
    expect(item('XportScenario:Contoso Export Carriers').status).toBe('only-a');
    const others = sidecar.items.filter((i) => i.group === 'other');
    expect(new Set(others.map((i) => i.element)).size).toBeGreaterThanOrEqual(2);
    expect(others.every((i) => i.detail === i.element)).toBe(true);
    const fileTypes = new Set([...p.a.matchAll(/FileType="(\w+)"/g)].map((m) => m[1]));
    expect([...fileTypes].sort()).toEqual(['ExistingDac', 'ExistingGraph', 'NewDac', 'NewFile', 'NewGraph']);
    expect(sidecar.items.some((i) => i.element === 'File' && i.group === 'files')).toBe(true);
    expect(sidecar.items.some((i) => i.element === 'File' && i.group === 'code')).toBe(true);
    expect(sidecar.items.filter((i) => i.element === 'Page').every((i) => i.views[0] === 'code')).toBe(true);
    expect(sidecar.items.some((i) => i.element === 'Page' && i.views.includes('changes'))).toBe(true);
    // Real exports also carry content-less File references.
    expect(p.a).toMatch(/^<File AppRelativePath="[^"]+" \/>\r$/m);
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
    const linesA = p.a.split(LF);
    const linesB = p.b.split(LF);
    for (const it of sidecar.items) {
      for (const [r, lines] of [[it.a, linesA], [it.b, linesB]] as const) {
        if (!r) continue;
        expect(lines[r.startLine - 1]?.startsWith(`<${it.element}`), it.id).toBe(true);
        const end = (lines[r.endLine - 1] ?? '').trimEnd();
        expect(end.endsWith(`</${it.element}>`) || (r.startLine === r.endLine && end.endsWith(' />')), it.id).toBe(true);
      }
    }
  });

  it('splits a literal "]]>" across CDATA sections on both sides', () => {
    const it = item(sidecar.cdataSplit.id);
    for (const [text, r] of [[p.a, it.a], [p.b, it.b]] as const) {
      const el = text.split(LF).slice((r?.startLine ?? 1) - 1, r?.endLine).join(LF);
      expect(el).toContain(']]]]><![CDATA[>');
      const joined = el.replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>');
      expect(joined).toContain(sidecar.cdataSplit.mustContain);
    }
  });

  it('is shaped like a real export: no <?xml> header, CRLF, entities, Name@Version endpoints', () => {
    for (const t of [p.a, p.b]) {
      expect(t.startsWith('<Customization level="99" description="" product-version="')).toBe(true);
      expect(t).toMatch(/^<EditorUpdatedFields ScreenId="\w+"><!\[CDATA\[\{.*\}\]\]><\/EditorUpdatedFields>\r$/m);
      expect(t).toMatch(/^<Page path="~\/Pages\/[A-Z]{2}\/[A-Z]{2}\d{6}\.aspx" pageSource="[A-Za-z0-9+/=]+" \/>\r$/m);
      expect(t).toContain('isModernUIOnlyNode="True"');
      expect(t).toMatch(/<Field FieldName="\w+" TypeName="[\w?]+" MapDbTable="\w+" TextAttributes="#CDATA" StorageName="AddColumn">/);
      expect(t.split(LF).slice(0, -1).every((l) => l.endsWith(CR))).toBe(true);
      expect(t).toContain('Title="Orders &amp; Returns"');
      expect(t).toContain('&quot;Express&quot;');
      expect(Math.max(...t.split(LF).map((l) => l.length))).toBeGreaterThan(15_000);
    }
    const eps = sidecar.items.filter((i) => i.element === 'EntityEndpoint').map((i) => i.id);
    expect(eps).toContain('EntityEndpoint:ContosoEndpoint@23.200.001');
    expect(eps).toContain('EntityEndpoint:ContosoEndpoint@24.200.001');
    expect(item('EntityEndpoint:ContosoEndpoint@24.200.001').status).toBe('only-b');
    expect(item('EntityEndpoint:ContosoEndpoint@23.200.001').status).toBe('modified');
    expect(sidecar.items.some((i) => i.element === 'Page' && i.status === 'same' && i.a?.startLine !== i.b?.startLine && (sidecar.edits.moved ?? []).includes(i.key))).toBe(true);
    expect(sidecar.items.some((i) => i.element === 'Page' && i.status === 'modified')).toBe(true);
    expect(item('SiteMapNode:SO301000').detail).toBe('Orders & Returns');
  });

  it('pageSource is base64 of raw-deflated ASPX', () => {
    const it = item(sidecar.pageSource.id);
    const line = p.a.split(LF)[(it.a?.startLine ?? 1) - 1] ?? '';
    const b64 = /pageSource="([^"]+)"/.exec(line)?.[1] ?? '';
    expect(inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8')).toContain(sidecar.pageSource.mustContain);
  });

  it('one screen has a page, file references, Modern UI files, a site map entry and editor fields', () => {
    const elements = sidecar.relatedScreen.ids.map((id) => item(id).element).sort();
    expect(elements).toEqual(['Automation', 'EditorUpdatedFields', 'File', 'File', 'MobileSiteMap', 'Page', 'PerTenantFile', 'PerTenantFile', 'ScreenWithRights', 'SiteMapNode']);
  });

  it('reformatted JSON is same; changed JSON is modified', () => {
    const json = sidecar.items.filter((i) => i.element === 'EditorUpdatedFields');
    expect(json.filter((i) => i.status === 'modified')).toHaveLength(1);
    for (const key of sidecar.edits.sameAfterJsonReformat ?? []) expect(json.find((i) => i.key === key)?.status).toBe('same');
  });
});
