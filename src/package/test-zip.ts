// A tiny zip writer for tests (not shipped): stored, deflate, flags, bad CRCs.
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip';

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
