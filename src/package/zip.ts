// Dependency-free zip reader (DECISIONS.md D16). Reads the End of Central
// Directory and the central directory up front; local headers and data are
// read lazily per entry. Stored (0) and deflate (8) via DecompressionStream.
// Zip64 and encrypted entries are rejected with a readable message.
import type { FileKind } from '../types';

export interface ZipRecord {
  /** Path inside the zip, forward slashes, no leading slash. */
  path: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  override name = 'ZipError';
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** Reads [start, end) of a blob as bytes. */
export async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// --- names -----------------------------------------------------------------------------

// CP437 upper half (0x80–0xFF); the lower half is ASCII.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

export function decodeCp437(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : (CP437_HIGH[c - 0x80] ?? '?');
  return s;
}

const utf8 = new TextDecoder('utf-8');

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

// --- CRC-32 ------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

// --- directory ---------------------------------------------------------------------------

/** True if the blob starts like a zip (local header, or an empty archive's EOCD). */
export async function looksLikeZip(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  const h = await readRange(blob, 0, 4);
  const sig = (h[0] as number) | ((h[1] as number) << 8) | ((h[2] as number) << 16) | ((h[3] as number) << 24);
  return sig >>> 0 === SIG_LOCAL || sig >>> 0 === SIG_EOCD;
}

export async function readDirectory(blob: Blob): Promise<ZipRecord[]> {
  const size = blob.size;
  if (size < EOCD_MIN) throw new ZipError('This file is too small to be a zip archive.');
  const tailStart = Math.max(0, size - EOCD_MIN - MAX_COMMENT);
  const tail = await readRange(blob, tailStart, size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      // The comment length must reach exactly to the end of the file.
      if (i + EOCD_MIN + tv.getUint16(i + 20, true) === tail.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) throw new ZipError('Not a valid zip archive (end of central directory not found; the file may be truncated).');
  if (eocd >= 20 && tv.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR) {
    throw new ZipError('This zip uses the ZIP64 format, which SideDiff does not support.');
  }
  const disk = tv.getUint16(eocd + 4, true);
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('This zip uses the ZIP64 format, which SideDiff does not support.');
  }
  if (disk !== 0) throw new ZipError('Multi-part (spanned) zip archives are not supported.');
  const eocdAbs = tailStart + eocd;
  if (cdOffset + cdSize > eocdAbs) throw new ZipError('Corrupt zip: the central directory points past the end of the file.');

  const cd = await readRange(blob, cdOffset, cdOffset + cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipRecord[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError(`Corrupt zip: central directory entry ${n + 1} is damaged.`);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localHeaderOffset = v.getUint32(p + 42, true);
    if (p + 46 + nameLen > cd.length) throw new ZipError(`Corrupt zip: central directory entry ${n + 1} is truncated.`);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const path = normalizePath(flags & 0x800 ? utf8.decode(nameBytes) : decodeCp437(nameBytes));
    if (compressedSize === 0xffffffff || usize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipError(`This zip uses ZIP64 for "${path}", which SideDiff does not support.`);
    }
    if (flags & 0x1) throw new ZipError(`"${path}" is encrypted; password-protected zips are not supported.`);
    if (localHeaderOffset + 30 > cdOffset) throw new ZipError(`Corrupt zip: "${path}" points outside the archive.`);
    out.push({ path, method, flags, crc32: crc, compressedSize, size: usize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Offset of an entry's compressed data (reads its local header). */
async function dataOffset(blob: Blob, r: ZipRecord): Promise<number> {
  const h = await readRange(blob, r.localHeaderOffset, r.localHeaderOffset + 30);
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (h.length < 30 || v.getUint32(0, true) !== SIG_LOCAL) throw new ZipError(`Corrupt zip: the local header of "${r.path}" is damaged.`);
  const start = r.localHeaderOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
  if (start + r.compressedSize > blob.size) throw new ZipError(`Corrupt zip: "${r.path}" is truncated.`);
  return start;
}

function rawStream(blob: Blob, r: ZipRecord, start: number): ReadableStream<Uint8Array> {
  const raw = blob.slice(start, start + r.compressedSize).stream();
  if (r.method === 0) return raw;
  if (r.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw')) as ReadableStream<Uint8Array>;
  throw new ZipError(`"${r.path}" uses compression method ${r.method}; only stored and deflate are supported.`);
}

/** Inflates one entry and checks its size and CRC-32. */
export async function readEntry(blob: Blob, r: ZipRecord): Promise<Uint8Array> {
  if (r.flags & 0x1) throw new ZipError(`"${r.path}" is encrypted; password-protected zips are not supported.`);
  const start = await dataOffset(blob, r);
  const out = new Uint8Array(r.size);
  let off = 0;
  let crc = 0;
  const reader = rawStream(blob, r, start).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > r.size) throw new ZipError(`Corrupt zip: "${r.path}" inflates to more than its recorded ${r.size} bytes.`);
      out.set(value, off);
      off += value.length;
      crc = crc32(value, crc);
    }
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError(`Corrupt zip: "${r.path}" could not be decompressed (${err instanceof Error ? err.message : String(err)}).`, { cause: err });
  } finally {
    reader.releaseLock();
  }
  if (off !== r.size) throw new ZipError(`Corrupt zip: "${r.path}" has ${off} bytes, expected ${r.size}.`);
  if (crc !== r.crc32) throw new ZipError(`Corrupt zip: "${r.path}" failed its CRC-32 check (the download may be damaged).`);
  return out;
}

/** First `n` bytes of an entry (inflating only as much as needed). */
export async function readHead(blob: Blob, r: ZipRecord, n: number): Promise<Uint8Array> {
  const start = await dataOffset(blob, r);
  const reader = rawStream(blob, r, start).getReader();
  const out = new Uint8Array(Math.min(n, r.size));
  let off = 0;
  try {
    while (off < out.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, out.length - off);
      out.set(value.subarray(0, take), off);
      off += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, off);
}

// --- kinds ---------------------------------------------------------------------------------

const TEXT_EXT = new Set(['cs', 'aspx', 'ascx', 'ts', 'js', 'html', 'htm', 'css', 'scss', 'xml', 'config', 'json', 'txt', 'esc', 'rpx', 'sql', 'resx', 'md']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp']);
const ASSEMBLY_EXT = new Set(['dll', 'exe']);

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Kind from the extension alone; assemblies still need the MZ check. */
export function kindByExtension(path: string): FileKind {
  const e = extOf(path);
  if (TEXT_EXT.has(e)) return 'text';
  if (IMAGE_EXT.has(e)) return 'image';
  if (ASSEMBLY_EXT.has(e)) return 'assembly';
  return 'binary';
}

/** UTF-8 (BOM stripped), or UTF-16 when it has a UTF-16 BOM. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const s = utf8.decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
