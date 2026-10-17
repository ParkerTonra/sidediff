// Browser perf check for Phase 5 (not part of the app build): opening a 50 MB
// zip's directory, inflating a 1 MB entry, and search over the large pair in
// the real worker. Open /src/project/harness.html?bench=phase5 on an ad-hoc server.
import { createPackageReader } from '../package';
import { crc32 } from '../package/zip';
import { createProjectIndexer } from './index';

const enc = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Minimal zip writer: stored or deflate entries. */
export async function makeZip(entries: { name: string; data: Uint8Array; deflate?: boolean }[]): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = e.deflate ? await deflateRaw(e.data) : e.data;
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local as Uint8Array<ArrayBuffer>, comp as Uint8Array<ArrayBuffer>);
    central.push(cd);
    offset += local.length + comp.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as Uint8Array<ArrayBuffer>[]), eocd as Uint8Array<ArrayBuffer>]);
}

export async function benchPhase5(log: (m: string) => void): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  // 50 MB package: 2,000 × 25 KB stored files + one 1 MB deflated text file.
  const filler = new Uint8Array(25_000).fill(0x61);
  const mb = enc.encode('public class Widget { int x; }\n'.repeat(Math.ceil(1_048_576 / 31)).slice(0, 1_048_576));
  const entries = [{ name: 'project.xml', data: enc.encode('<Customization level="0"></Customization>') }];
  for (let i = 0; i < 2000; i++) entries.push({ name: `files/f${i}.bin`, data: filler });
  const zip = await makeZip([...entries, { name: 'App_Code/Big.cs', data: mb, deflate: true }]);
  log(`zip built: ${(zip.size / 1e6).toFixed(1)} MB, ${entries.length + 1} entries`);

  const reader = createPackageReader();
  const openMs: number[] = [];
  let src = await reader.open(zip, 'bench.zip');
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    src = await reader.open(zip, 'bench.zip');
    openMs.push(performance.now() - t0);
  }
  results.openDirMsMedian = median(openMs);
  results.openDirMsMax = Math.max(...openMs);
  const inflMs: number[] = [];
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    const bytes = await src.read('App_Code/Big.cs');
    inflMs.push(performance.now() - t0);
    if (bytes.length !== 1_048_576) throw new Error('bad inflate');
  }
  results.inflate1MbMsMedian = median(inflMs);

  // Search over the large pair in the real worker.
  const get = (u: string): Promise<string> => fetch(u).then((r) => r.text());
  const [a, b] = await Promise.all([get('/fixtures/large-a.xml'), get('/fixtures/large-b.xml')]);
  const ix = createProjectIndexer();
  await ix.index(a, b);
  await ix.search?.('warm-up-no-such-text'); // waits for the post-index cache warm-up
  const miss: number[] = [];
  const hit: number[] = [];
  const rx: number[] = [];
  for (let k = 0; k < 5; k++) {
    let t0 = performance.now();
    await ix.search?.('zzz-no-such-text-anywhere');
    miss.push(performance.now() - t0);
    t0 = performance.now();
    await ix.search?.('PXGraphExtension');
    hit.push(performance.now() - t0);
    t0 = performance.now();
    await ix.search?.('Usr\\w+Qty', { regex: true });
    rx.push(performance.now() - t0);
  }
  results.searchMissMsMedian = median(miss);
  results.searchMissMsMax = Math.max(...miss);
  results.search500HitsMsMedian = median(hit);
  results.searchRegexMsMedian = median(rx);
  ix.dispose();
  for (const [k, v] of Object.entries(results)) log(`${k}: ${v.toFixed(1)}`);
  return results;
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}
