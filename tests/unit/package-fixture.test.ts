// The `package` fixture pair (Phase 5): zip structure, determinism, and the
// sidecar's expected items, overview and searches.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { generatePackagePair } from '../../scripts/lib/package-gen.ts';
import type { PackageItem } from '../../scripts/lib/package-gen.ts';
import { generateProjectPair } from '../../scripts/lib/project-gen.ts';
import { crc32, png } from '../../scripts/lib/zip.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const fx = (p: string): Buffer => readFileSync(join(ROOT, 'fixtures', p));
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const statics = { dllA: fx('static/Contoso.Extensions.dll'), dllB: fx('static/Contoso.Extensions.B.dll'), jpg: fx('static/contoso-banner.jpg') };
const pkg = generatePackagePair(statics);
const sidecar = JSON.parse(fx('package.changes.json').toString('utf8')) as {
  a: { sha256: string; entries: { path: string; size: number }[] };
  b: { sha256: string; entries: { path: string; size: number }[] };
  counts: { total: number; byStatus: Record<string, number>; byGroup: Record<string, number> };
  items: PackageItem[];
  edits: Record<string, string[]>;
};

/** Independent reader: EOCD → central directory → local headers; checks CRC-32. */
function readZip(buf: Buffer): Map<string, { method: number; flags: number; data: Buffer }> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBe(buf.length - 22);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, { method: number; flags: number; data: Buffer }>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length, name).toBe(usize);
    expect(crc32(data), name).toBe(crc);
    out.set(name, { method, flags, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const item = (id: string): PackageItem => {
  const it = sidecar.items.find((x) => x.id === id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};

describe('package fixture', () => {
  it('regenerates byte-identical zips and the committed item list', () => {
    expect(sha256(pkg.zips.a)).toBe(sidecar.a.sha256);
    expect(sha256(pkg.zips.b)).toBe(sidecar.b.sha256);
    expect(pkg.items).toEqual(sidecar.items);
  });

  it('is a real-layout zip: project.xml at the root, files at AppRelativePath with /, deflate, UTF-8 names, valid CRCs', () => {
    const proj = generateProjectPair();
    for (const [side, xml] of [['a', proj.a], ['b', proj.b]] as const) {
      const z = readZip(pkg.zips[side]);
      expect(z.get('project.xml')?.data.toString('utf8')).toBe(xml);
      for (const [name, e] of z) {
        expect(name.includes('\\'), name).toBe(false);
        expect(e.flags & 0x0800).toBe(0x0800);
        if (name !== 'Data/routes.bin') expect(e.method, name).toBe(8);
      }
      expect([...z.keys()].map((n) => ({ path: n, size: z.get(n)?.data.length }))).toEqual(sidecar[side].entries);
      expect(z.get('Bin/Contoso.Extensions.dll')?.data.equals(side === 'a' ? statics.dllA : statics.dllB)).toBe(true);
      expect(z.get('Bin/Contoso.Extensions.dll')?.data.subarray(0, 2).toString('latin1')).toBe('MZ');
      expect(z.get('Images/contoso-logo.png')?.data.subarray(1, 4).toString('latin1')).toBe('PNG');
      // Referenced by project.xml but deliberately missing.
      expect(z.has('Pages/PO/PO302000.aspx')).toBe(false);
      expect(xml).toContain('<File AppRelativePath="Pages\\PO\\PO302000.aspx" />');
    }
  });

  it('B differs as specified: changed .aspx, .ts and DLL; an image and a .ts only in A', () => {
    const a = readZip(pkg.zips.a);
    const b = readZip(pkg.zips.b);
    for (const path of sidecar.edits.changedFiles ?? []) expect(a.get(path)?.data.equals(b.get(path)?.data ?? Buffer.alloc(0)), path).toBe(false);
    for (const path of sidecar.edits.onlyInA ?? []) {
      expect(a.has(path), path).toBe(true);
      expect(b.has(path), path).toBe(false);
    }
    expect(item('File:Pages\\SO\\SO301000.aspx').status).toBe('modified');
    expect(item('PerTenantFile:screens\\SO\\SO301000\\SO301000.ts').status).toBe('modified');
    // Referenced DLLs and images are grouped by kind (Lead decision).
    expect(item('File:Bin\\Contoso.Extensions.dll')).toMatchObject({ status: 'modified', group: 'assemblies', views: ['assembly', 'xml', 'summary'] });
    expect(item('File:Images\\contoso-logo.png')).toMatchObject({ status: 'same', group: 'images', views: ['image', 'xml', 'summary'] });
    // .aspx/.html content: screen outline summary first.
    expect(item('File:Pages\\SO\\SO301000.aspx').views).toEqual(['summary', 'code', 'xml']);
    expect(item('Zip:Images/contoso-banner.jpg')).toMatchObject({ status: 'only-a', group: 'images', sides: ['a'] });
    expect(item('File:Pages\\PO\\PO302000.aspx')).toMatchObject({ status: 'same', views: ['xml', 'summary'] });
  });

  it('unreferenced files become Zip items, grouped by kind, marked "not in project.xml"', () => {
    const zipItems = sidecar.items.filter((i) => i.element === 'Zip');
    expect(zipItems.map((i) => i.key).sort()).toEqual([...(sidecar.edits.unreferenced ?? [])].sort());
    expect(zipItems.every((i) => i.detail === 'not in project.xml')).toBe(true);
    expect(item('Zip:App_Data/SnapshotConfigs/ContosoRoutes.esc')).toMatchObject({ group: 'files', views: ['code', 'summary'] });
    expect(item('Zip:Data/routes.bin')).toMatchObject({ group: 'files', views: ['binary', 'summary'] });
  });

  it('counts add up; overview counts follow the items on each side', () => {
    expect(sidecar.items.length).toBe(sidecar.counts.total);
    expect(Object.values(sidecar.counts.byStatus).reduce((x, y) => x + y, 0)).toBe(sidecar.counts.total);
    for (const side of ['a', 'b'] as const) {
      const n = Object.values(pkg.overview[side].counts).reduce((x, y) => x + (y ?? 0), 0);
      expect(n).toBe(sidecar.items.filter((i) => i.sides.includes(side)).length);
      expect(pkg.overview[side].assemblies).toEqual([{ path: 'Bin/Contoso.Extensions.dll', size: (side === 'a' ? statics.dllA : statics.dllB).length }]);
      expect(pkg.overview[side].warningsInclude).toContain('Pages/PO/PO302000.aspx');
    }
  });

  it('search targets exist where the sidecar says', () => {
    const a = readZip(pkg.zips.a);
    for (const s of pkg.searches) {
      expect(sidecar.items.some((i) => i.id === s.itemId), s.itemId).toBe(true);
      if (s.itemId.startsWith('Zip:') && s.line) {
        const lines = a.get(s.itemId.slice(4))?.data.toString('utf8').split(/\r?\n/) ?? [];
        expect(lines[s.line - 1], s.query).toContain(s.query);
      }
    }
    expect(statics.dllA.includes(Buffer.from('CONTOSO-ROUTE-AUDIT-7731', 'utf16le'))).toBe(true);
  });

  it('png() writes a valid PNG (signature, IHDR, CRCs)', () => {
    const b = png(4, 3, () => [1, 2, 3]);
    expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(b.readUInt32BE(16)).toBe(4);
    expect(b.readUInt32BE(20)).toBe(3);
    const ihdr = b.subarray(12, 12 + 4 + 13);
    expect(b.readUInt32BE(12 + 4 + 13)).toBe(crc32(ihdr));
  });
});
