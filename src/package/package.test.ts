import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createPackageReader, pathKey, zipHandleOf } from './index';
import { crc32, decodeCp437, decodeText, kindByExtension, readDirectory, readEntry } from './zip';

// --- a tiny zip writer for tests ---------------------------------------------------------

export interface TestEntry {
  name: string | Uint8Array;
  data: Uint8Array | string;
  method?: 0 | 8 | 12;
  utf8?: boolean;
  encrypted?: boolean;
  /** Override the stored CRC (to simulate corruption). */
  crc?: number;
}

const enc = new TextEncoder();
const u8 = (d: Uint8Array | string) => (typeof d === 'string' ? enc.encode(d) : d);

export function buildZip(entries: TestEntry[], opts: { comment?: string; zip64Locator?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = u8(e.data);
    const method = e.method ?? 8;
    const comp = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = typeof e.name === 'string' ? enc.encode(e.name) : e.name;
    const flags = (e.utf8 ? 0x800 : 0) | (e.encrypted ? 1 : 0);
    const crc = e.crc ?? crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, comp);
    central.push(cd);
    offset += local.length + comp.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const comment = enc.encode(opts.comment ?? '');
  const locator = opts.zip64Locator ? new Uint8Array(20) : new Uint8Array(0);
  if (opts.zip64Locator) new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  const all = [...parts, ...central, locator, eocd];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);
const blob = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>]);
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
const PROJECT = '<Customization level="0">\r\n<File AppRelativePath="App_Code\\Caches\\X.cs" />\r\n</Customization>';

describe('zip reader', () => {
  it('opens a package: project.xml, entries with kinds, lazy reads, CRC checked', async () => {
    const zip = buildZip([
      { name: 'project.xml', data: `${BOM}${PROJECT}` },
      { name: 'App_Code/Caches/X.cs', data: 'class X {}' },
      { name: 'Bin/Vendor.Ext.dll', data: MZ },
      { name: 'Bin/fake.dll', data: 'not a PE file' },
      { name: 'Pages/SO/SO301000.aspx', data: '<%@ Page %>', method: 0 },
      { name: 'Images/logo.PNG', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      { name: 'App_Data/SnapshotConfigs/a.esc', data: 'x' },
      { name: 'data/blob.bin', data: new Uint8Array([1, 2, 3]) },
      { name: 'empty-dir/', data: '' , method: 0 },
    ]);
    const src = await createPackageReader().open(blob(zip), 'pkg.zip');
    expect(src).toMatchObject({ name: 'pkg.zip', kind: 'zip', bytes: zip.length, projectXml: PROJECT });
    expect(src.entries.map((e) => [e.path, e.kind])).toEqual([
      ['App_Code/Caches/X.cs', 'text'],
      ['Bin/Vendor.Ext.dll', 'assembly'],
      ['Bin/fake.dll', 'binary'],
      ['Pages/SO/SO301000.aspx', 'text'],
      ['Images/logo.PNG', 'image'],
      ['App_Data/SnapshotConfigs/a.esc', 'text'],
      ['data/blob.bin', 'binary'],
    ]);
    expect(src.entries[0]).toMatchObject({ size: 10 });
    // AppRelativePath style lookups: backslashes, any case
    expect(await src.readText('App_Code\\caches\\x.CS')).toBe('class X {}');
    expect(await src.readText('Pages/SO/SO301000.aspx')).toBe('<%@ Page %>');
    expect(Array.from(await src.read('Bin/Vendor.Ext.dll'))).toEqual(Array.from(MZ));
    await expect(src.read('nope.txt')).rejects.toThrow(/"nope.txt" is not in pkg.zip/);
    expect(zipHandleOf(src)?.records).toHaveLength(7);
    expect(pathKey('\\App_Code\\X.cs')).toBe('app_code/x.cs');
  });

  it('a zip without project.xml has projectXml null', async () => {
    const src = await createPackageReader().open(blob(buildZip([{ name: 'a.txt', data: 'hi' }])), 'x.zip');
    expect(src.projectXml).toBeNull();
    expect(src.entries.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('non-zip input is read as text (UTF-8 BOM stripped); a .zip name without a zip header is rejected', async () => {
    const src = await createPackageReader().open(blob(enc.encode(`${BOM}${PROJECT}`)), 'project.xml');
    expect(src).toMatchObject({ kind: 'xml', projectXml: PROJECT, entries: [] });
    await expect(src.read('a')).rejects.toThrow(/bare project.xml has no files/);
    await expect(createPackageReader().open(blob(enc.encode('hello')), 'broken.zip')).rejects.toThrow(/not a zip archive/);
  });

  it('decodes UTF-8 names (flag 11) and CP437 names otherwise', async () => {
    const zip = buildZip([
      { name: 'Résumé/ü.txt', data: 'u', utf8: true },
      { name: new Uint8Array([0x82, 0x81, 0x2e, 0x74, 0x78, 0x74]), data: 'c' }, // "éü.txt" in CP437
    ]);
    const recs = await readDirectory(blob(zip));
    expect(recs.map((r) => r.path)).toEqual(['Résumé/ü.txt', 'éü.txt']);
    expect(decodeCp437(new Uint8Array([0x41, 0xb0, 0xff]))).toBe(`A░${NBSP}`);
  });

  it('finds the EOCD behind an archive comment', async () => {
    const src = await createPackageReader().open(blob(buildZip([{ name: 'a.txt', data: 'hi' }], { comment: 'created by test' })), 'c.zip');
    expect(await src.readText('a.txt')).toBe('hi');
  });

  it('rejects encrypted entries and zip64 with clear messages', async () => {
    await expect(createPackageReader().open(blob(buildZip([{ name: 'secret.cs', data: 'x', encrypted: true }])), 'e.zip')).rejects.toThrow(/"secret.cs" is encrypted/);
    await expect(createPackageReader().open(blob(buildZip([{ name: 'a', data: 'x' }], { zip64Locator: true })), 'z.zip')).rejects.toThrow(/ZIP64/);
  });

  it('rejects a CRC mismatch, an unsupported method, and corrupt deflate data on read', async () => {
    const zip = buildZip([
      { name: 'bad-crc.txt', data: 'hello', crc: 0x12345678 },
      { name: 'bzip.txt', data: 'hello', method: 12 },
      { name: 'ok.txt', data: 'hello world hello world' },
    ]);
    const src = await createPackageReader().open(blob(zip), 'r.zip');
    await expect(src.read('bad-crc.txt')).rejects.toThrow(/CRC-32/);
    await expect(src.read('bzip.txt')).rejects.toThrow(/compression method 12/);
    // flip bytes inside ok.txt's deflate stream
    const recs = await readDirectory(blob(zip));
    const ok = recs.find((r) => r.path === 'ok.txt');
    if (!ok) throw new Error('missing');
    const damaged = zip.slice();
    const dataStart = ok.localHeaderOffset + 30 + 'ok.txt'.length;
    for (let i = 0; i < ok.compressedSize; i++) damaged[dataStart + i] = 0xff;
    await expect(readEntry(blob(damaged), ok)).rejects.toThrow(/Corrupt zip: "ok.txt"/);
  });

  it('rejects truncated archives', async () => {
    const zip = buildZip([{ name: 'project.xml', data: PROJECT }, { name: 'a.txt', data: 'x'.repeat(1000) }]);
    await expect(createPackageReader().open(blob(zip.subarray(0, zip.length - 10)), 't.zip')).rejects.toThrow(/end of central directory not found|truncated/);
    await expect(createPackageReader().open(blob(zip.subarray(0, 40)), 't.zip')).rejects.toThrow(/zip/i);
    await expect(createPackageReader().open(blob(new Uint8Array([0x50, 0x4b, 3, 4])), 't.zip')).rejects.toThrow(/too small/);
  });

  it('a central directory pointing past the file is corrupt, not a crash', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'hi' }]);
    const v = new DataView(zip.buffer);
    v.setUint32(zip.length - 22 + 16, 999999, true); // cdOffset
    await expect(createPackageReader().open(blob(zip), 'p.zip')).rejects.toThrow(/Corrupt zip/);
  });

  it('helpers: kinds, CRC-32, UTF-16 text', () => {
    expect(['a.CS', 'x.esc', 'y.rpx', 'p.svg', 'q.dll', 'r.pdb', 'noext'].map(kindByExtension)).toEqual(['text', 'text', 'text', 'image', 'assembly', 'binary', 'binary']);
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0, 0x42, 0]))).toBe('AB');
  });

  it('opens a 50 MB package directory quickly (central directory only)', async () => {
    // 2,000 entries, ~50 MB of stored data: open() must not touch the data.
    const big = new Uint8Array(25_000).fill(0x61);
    const entries: TestEntry[] = [{ name: 'project.xml', data: PROJECT }];
    for (let i = 0; i < 2000; i++) entries.push({ name: `files/f${i}.bin`, data: big, method: 0 });
    const zip = buildZip(entries);
    expect(zip.length).toBeGreaterThan(50_000_000);
    const t0 = performance.now();
    const src = await createPackageReader().open(blob(zip), 'big.zip');
    const ms = performance.now() - t0;
    expect(src.entries).toHaveLength(2000);
    expect(ms).toBeLessThan(200);
  });
});
