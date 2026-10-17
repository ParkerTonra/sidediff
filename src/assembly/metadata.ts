// ECMA-335 metadata reader: PE/COFF → CLI header → metadata root → streams →
// tables and heaps. Pure (Uint8Array in, plain objects out) so it runs in the
// assembly worker and in node unit tests. Spec: ECMA-335 6th ed., II.22–II.25.

export class MetadataError extends Error {}

/** Table ids (II.22). */
export const T = {
  Module: 0x00,
  TypeRef: 0x01,
  TypeDef: 0x02,
  FieldPtr: 0x03,
  Field: 0x04,
  MethodPtr: 0x05,
  MethodDef: 0x06,
  ParamPtr: 0x07,
  Param: 0x08,
  InterfaceImpl: 0x09,
  MemberRef: 0x0a,
  Constant: 0x0b,
  CustomAttribute: 0x0c,
  FieldMarshal: 0x0d,
  DeclSecurity: 0x0e,
  ClassLayout: 0x0f,
  FieldLayout: 0x10,
  StandAloneSig: 0x11,
  EventMap: 0x12,
  EventPtr: 0x13,
  Event: 0x14,
  PropertyMap: 0x15,
  PropertyPtr: 0x16,
  Property: 0x17,
  MethodSemantics: 0x18,
  MethodImpl: 0x19,
  ModuleRef: 0x1a,
  TypeSpec: 0x1b,
  ImplMap: 0x1c,
  FieldRVA: 0x1d,
  EncLog: 0x1e,
  EncMap: 0x1f,
  Assembly: 0x20,
  AssemblyProcessor: 0x21,
  AssemblyOS: 0x22,
  AssemblyRef: 0x23,
  AssemblyRefProcessor: 0x24,
  AssemblyRefOS: 0x25,
  File: 0x26,
  ExportedType: 0x27,
  ManifestResource: 0x28,
  NestedClass: 0x29,
  GenericParam: 0x2a,
  MethodSpec: 0x2b,
  GenericParamConstraint: 0x2c,
} as const;

/** Coded index kinds (II.24.2.6): tag bit count and the tables in tag order (-1 = unused tag). */
const CODED: Record<string, { bits: number; tables: number[] }> = {
  TypeDefOrRef: { bits: 2, tables: [T.TypeDef, T.TypeRef, T.TypeSpec] },
  HasConstant: { bits: 2, tables: [T.Field, T.Param, T.Property] },
  HasCustomAttribute: {
    bits: 5,
    tables: [
      T.MethodDef, T.Field, T.TypeRef, T.TypeDef, T.Param, T.InterfaceImpl, T.MemberRef, T.Module, T.DeclSecurity, T.Property,
      T.Event, T.StandAloneSig, T.ModuleRef, T.TypeSpec, T.Assembly, T.AssemblyRef, T.File, T.ExportedType, T.ManifestResource,
      T.GenericParam, T.GenericParamConstraint, T.MethodSpec,
    ],
  },
  HasFieldMarshal: { bits: 1, tables: [T.Field, T.Param] },
  HasDeclSecurity: { bits: 2, tables: [T.TypeDef, T.MethodDef, T.Assembly] },
  MemberRefParent: { bits: 3, tables: [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec] },
  HasSemantics: { bits: 1, tables: [T.Event, T.Property] },
  MethodDefOrRef: { bits: 1, tables: [T.MethodDef, T.MemberRef] },
  MemberForwarded: { bits: 1, tables: [T.Field, T.MethodDef] },
  Implementation: { bits: 2, tables: [T.File, T.AssemblyRef, T.ExportedType] },
  CustomAttributeType: { bits: 3, tables: [-1, -1, T.MethodDef, T.MemberRef, -1] },
  ResolutionScope: { bits: 2, tables: [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef] },
  TypeOrMethodDef: { bits: 1, tables: [T.TypeDef, T.MethodDef] },
};

/** Column kinds: u8/u16/u32, heap indexes, a simple table index, or a coded index name. */
type Col = 'u8' | 'u16' | 'u32' | 'str' | 'guid' | 'blob' | { table: number } | { coded: string };

const SCHEMA: Record<number, [string, Col][]> = {
  [T.Module]: [['generation', 'u16'], ['name', 'str'], ['mvid', 'guid'], ['encId', 'guid'], ['encBaseId', 'guid']],
  [T.TypeRef]: [['scope', { coded: 'ResolutionScope' }], ['name', 'str'], ['namespace', 'str']],
  [T.TypeDef]: [
    ['flags', 'u32'], ['name', 'str'], ['namespace', 'str'], ['extends', { coded: 'TypeDefOrRef' }],
    ['fieldList', { table: T.Field }], ['methodList', { table: T.MethodDef }],
  ],
  [T.FieldPtr]: [['field', { table: T.Field }]],
  [T.Field]: [['flags', 'u16'], ['name', 'str'], ['signature', 'blob']],
  [T.MethodPtr]: [['method', { table: T.MethodDef }]],
  [T.MethodDef]: [
    ['rva', 'u32'], ['implFlags', 'u16'], ['flags', 'u16'], ['name', 'str'], ['signature', 'blob'], ['paramList', { table: T.Param }],
  ],
  [T.ParamPtr]: [['param', { table: T.Param }]],
  [T.Param]: [['flags', 'u16'], ['sequence', 'u16'], ['name', 'str']],
  [T.InterfaceImpl]: [['class', { table: T.TypeDef }], ['interface', { coded: 'TypeDefOrRef' }]],
  [T.MemberRef]: [['class', { coded: 'MemberRefParent' }], ['name', 'str'], ['signature', 'blob']],
  [T.Constant]: [['type', 'u16'], ['parent', { coded: 'HasConstant' }], ['value', 'blob']],
  [T.CustomAttribute]: [['parent', { coded: 'HasCustomAttribute' }], ['type', { coded: 'CustomAttributeType' }], ['value', 'blob']],
  [T.FieldMarshal]: [['parent', { coded: 'HasFieldMarshal' }], ['nativeType', 'blob']],
  [T.DeclSecurity]: [['action', 'u16'], ['parent', { coded: 'HasDeclSecurity' }], ['permissionSet', 'blob']],
  [T.ClassLayout]: [['packingSize', 'u16'], ['classSize', 'u32'], ['parent', { table: T.TypeDef }]],
  [T.FieldLayout]: [['offset', 'u32'], ['field', { table: T.Field }]],
  [T.StandAloneSig]: [['signature', 'blob']],
  [T.EventMap]: [['parent', { table: T.TypeDef }], ['eventList', { table: T.Event }]],
  [T.EventPtr]: [['event', { table: T.Event }]],
  [T.Event]: [['flags', 'u16'], ['name', 'str'], ['eventType', { coded: 'TypeDefOrRef' }]],
  [T.PropertyMap]: [['parent', { table: T.TypeDef }], ['propertyList', { table: T.Property }]],
  [T.PropertyPtr]: [['property', { table: T.Property }]],
  [T.Property]: [['flags', 'u16'], ['name', 'str'], ['type', 'blob']],
  [T.MethodSemantics]: [['semantics', 'u16'], ['method', { table: T.MethodDef }], ['association', { coded: 'HasSemantics' }]],
  [T.MethodImpl]: [['class', { table: T.TypeDef }], ['body', { coded: 'MethodDefOrRef' }], ['declaration', { coded: 'MethodDefOrRef' }]],
  [T.ModuleRef]: [['name', 'str']],
  [T.TypeSpec]: [['signature', 'blob']],
  [T.ImplMap]: [['flags', 'u16'], ['member', { coded: 'MemberForwarded' }], ['importName', 'str'], ['scope', { table: T.ModuleRef }]],
  [T.FieldRVA]: [['rva', 'u32'], ['field', { table: T.Field }]],
  [T.EncLog]: [['token', 'u32'], ['funcCode', 'u32']],
  [T.EncMap]: [['token', 'u32']],
  [T.Assembly]: [
    ['hashAlgId', 'u32'], ['major', 'u16'], ['minor', 'u16'], ['build', 'u16'], ['revision', 'u16'], ['flags', 'u32'],
    ['publicKey', 'blob'], ['name', 'str'], ['culture', 'str'],
  ],
  [T.AssemblyProcessor]: [['processor', 'u32']],
  [T.AssemblyOS]: [['platform', 'u32'], ['major', 'u32'], ['minor', 'u32']],
  [T.AssemblyRef]: [
    ['major', 'u16'], ['minor', 'u16'], ['build', 'u16'], ['revision', 'u16'], ['flags', 'u32'], ['publicKeyOrToken', 'blob'],
    ['name', 'str'], ['culture', 'str'], ['hashValue', 'blob'],
  ],
  [T.AssemblyRefProcessor]: [['processor', 'u32'], ['assemblyRef', { table: T.AssemblyRef }]],
  [T.AssemblyRefOS]: [['platform', 'u32'], ['major', 'u32'], ['minor', 'u32'], ['assemblyRef', { table: T.AssemblyRef }]],
  [T.File]: [['flags', 'u32'], ['name', 'str'], ['hashValue', 'blob']],
  [T.ExportedType]: [
    ['flags', 'u32'], ['typeDefId', 'u32'], ['name', 'str'], ['namespace', 'str'], ['implementation', { coded: 'Implementation' }],
  ],
  [T.ManifestResource]: [['offset', 'u32'], ['flags', 'u32'], ['name', 'str'], ['implementation', { coded: 'Implementation' }]],
  [T.NestedClass]: [['nested', { table: T.TypeDef }], ['enclosing', { table: T.TypeDef }]],
  [T.GenericParam]: [['number', 'u16'], ['flags', 'u16'], ['owner', { coded: 'TypeOrMethodDef' }], ['name', 'str']],
  [T.MethodSpec]: [['method', { coded: 'MethodDefOrRef' }], ['instantiation', 'blob']],
  [T.GenericParamConstraint]: [['owner', { table: T.GenericParam }], ['constraint', { coded: 'TypeDefOrRef' }]],
};

/** A decoded coded index: target table and 1-based row (0 = null). */
export interface CodedRef {
  table: number;
  row: number;
}

export type Row = Record<string, number | CodedRef>;

export interface Section {
  va: number;
  vsize: number;
  raw: number;
  rawSize: number;
}

export interface Metadata {
  bytes: Uint8Array;
  view: DataView;
  sections: Section[];
  version: string;
  /** Rows per table, 1-based (index 0 unused). */
  tables: Map<number, Row[]>;
  strings: (offset: number) => string;
  /** #US entry at `offset` (string literal for an ldstr token). */
  userString: (offset: number) => string;
  /** Every #US entry in order (offset, text). */
  userStrings: () => { offset: number; text: string }[];
  blob: (offset: number) => Uint8Array;
  rvaToOffset: (rva: number) => number;
  rows: (table: number) => number;
  row: (table: number, index: number) => Row | undefined;
}

export function readCompressedUInt(b: Uint8Array, pos: number): { value: number; size: number } {
  const first = b[pos];
  if (first === undefined) throw new MetadataError('blob ends early');
  if ((first & 0x80) === 0) return { value: first, size: 1 };
  if ((first & 0xc0) === 0x80) return { value: ((first & 0x3f) << 8) | (b[pos + 1] ?? 0), size: 2 };
  if ((first & 0xe0) === 0xc0) {
    const v = ((first & 0x1f) << 24) | ((b[pos + 1] ?? 0) << 16) | ((b[pos + 2] ?? 0) << 8) | (b[pos + 3] ?? 0);
    return { value: v >>> 0, size: 4 };
  }
  throw new MetadataError('bad compressed integer');
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
const utf16 = new TextDecoder('utf-16le', { fatal: false });

export function readMetadata(bytes: Uint8Array): Metadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (m: string): never => {
    throw new MetadataError(m);
  };
  if (bytes.length < 0x80 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail('Not a .NET assembly (no MZ header).');
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550) fail('Not a .NET assembly (no PE header).');
  const coff = pe + 4;
  const nSections = view.getUint16(coff + 2, true);
  const optSize = view.getUint16(coff + 16, true);
  const opt = coff + 20;
  const magic = view.getUint16(opt, true);
  const dirBase = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : fail('Unknown PE optional header.');
  const sections: Section[] = [];
  let s = opt + optSize;
  for (let i = 0; i < nSections; i++, s += 40) {
    sections.push({
      vsize: view.getUint32(s + 8, true),
      va: view.getUint32(s + 12, true),
      rawSize: view.getUint32(s + 16, true),
      raw: view.getUint32(s + 20, true),
    });
  }
  const rvaToOffset = (rva: number): number => {
    for (const sec of sections) {
      if (rva >= sec.va && rva < sec.va + Math.max(sec.vsize, sec.rawSize)) return rva - sec.va + sec.raw;
    }
    throw new MetadataError(`RVA 0x${rva.toString(16)} is outside every section.`);
  };
  const cliRva = view.getUint32(dirBase + 14 * 8, true);
  if (!cliRva) fail('Not a .NET assembly (no CLI header; native DLL).');
  const cli = rvaToOffset(cliRva);
  const mdRoot = rvaToOffset(view.getUint32(cli + 8, true));
  if (view.getUint32(mdRoot, true) !== 0x424a5342) fail('Bad metadata signature.');
  const verLen = view.getUint32(mdRoot + 12, true);
  const version = utf8.decode(bytes.subarray(mdRoot + 16, mdRoot + 16 + verLen)).replace(/\0+$/, '');
  let p = mdRoot + 16 + verLen;
  const nStreams = view.getUint16(p + 2, true);
  p += 4;
  const streams = new Map<string, { off: number; size: number }>();
  for (let i = 0; i < nStreams; i++) {
    const off = view.getUint32(p, true);
    const size = view.getUint32(p + 4, true);
    p += 8;
    let name = '';
    while (bytes[p] !== 0 && p < bytes.length) name += String.fromCharCode(bytes[p++]!);
    p += 4 - (name.length % 4); // name + NUL, padded to 4
    streams.set(name, { off: mdRoot + off, size });
  }
  const tilde = streams.get('#~') ?? streams.get('#-') ?? fail('No metadata tables stream.');
  const str = streams.get('#Strings');
  const us = streams.get('#US');
  const blobS = streams.get('#Blob');

  // --- #~ ---
  const heapSizes = bytes[tilde.off + 6]!;
  const valid = view.getBigUint64(tilde.off + 8, true);
  let q = tilde.off + 24;
  const counts = new Map<number, number>();
  for (let t = 0; t < 64; t++) {
    if ((valid >> BigInt(t)) & 1n) {
      counts.set(t, view.getUint32(q, true));
      q += 4;
    }
  }
  if (heapSizes & 0x40) q += 4; // extra data (EnC)
  const strSize = heapSizes & 0x01 ? 4 : 2;
  const guidSize = heapSizes & 0x02 ? 4 : 2;
  const blobSize = heapSizes & 0x04 ? 4 : 2;
  const rows = (t: number): number => counts.get(t) ?? 0;
  const codedSize = (name: string): number => {
    const c = CODED[name]!;
    const max = Math.max(...c.tables.map((t) => (t < 0 ? 0 : rows(t))));
    return max < 1 << (16 - c.bits) ? 2 : 4;
  };
  const colSize = (c: Col): number => {
    if (c === 'u8') return 1;
    if (c === 'u16') return 2;
    if (c === 'u32') return 4;
    if (c === 'str') return strSize;
    if (c === 'guid') return guidSize;
    if (c === 'blob') return blobSize;
    if ('table' in c) return rows(c.table) < 65536 ? 2 : 4;
    return codedSize(c.coded);
  };
  const read = (off: number, size: number): number => (size === 1 ? bytes[off]! : size === 2 ? view.getUint16(off, true) : view.getUint32(off, true));

  const tables = new Map<number, Row[]>();
  for (let t = 0; t < 64; t++) {
    const n = counts.get(t);
    if (n === undefined) continue;
    const schema = SCHEMA[t];
    if (!schema) fail(`Unsupported metadata table 0x${t.toString(16)}.`);
    const cols = schema!.map(([name, c]) => ({ name, c, size: colSize(c) }));
    const width = cols.reduce((a, x) => a + x.size, 0);
    const list: Row[] = [{}];
    for (let r = 0; r < n; r++) {
      const row: Row = {};
      let o = q;
      for (const col of cols) {
        const v = read(o, col.size);
        o += col.size;
        if (typeof col.c === 'object' && 'coded' in col.c) {
          const cd = CODED[col.c.coded]!;
          const tag = v & ((1 << cd.bits) - 1);
          row[col.name] = { table: cd.tables[tag] ?? -1, row: v >>> cd.bits };
        } else {
          row[col.name] = v;
        }
      }
      list.push(row);
      q += width;
    }
    tables.set(t, list);
  }

  const strings = (offset: number): string => {
    if (!str || offset === 0) return '';
    let end = str.off + offset;
    while (end < str.off + str.size && bytes[end] !== 0) end++;
    return utf8.decode(bytes.subarray(str.off + offset, end));
  };
  const blob = (offset: number): Uint8Array => {
    if (!blobS || offset === 0) return new Uint8Array(0);
    const { value, size } = readCompressedUInt(bytes, blobS.off + offset);
    return bytes.subarray(blobS.off + offset + size, blobS.off + offset + size + value);
  };
  const userString = (offset: number): string => {
    if (!us || offset === 0) return '';
    const { value, size } = readCompressedUInt(bytes, us.off + offset);
    const start = us.off + offset + size;
    // value counts the UTF-16 bytes plus one trailing flag byte.
    return utf16.decode(bytes.subarray(start, start + Math.max(0, value - 1)));
  };
  const userStrings = (): { offset: number; text: string }[] => {
    const out: { offset: number; text: string }[] = [];
    if (!us) return out;
    let o = 1;
    while (o < us.size) {
      const { value, size } = readCompressedUInt(bytes, us.off + o);
      if (value === 0) {
        o += size;
        continue;
      }
      out.push({ offset: o, text: userString(o) });
      o += size + value;
    }
    return out;
  };
  return {
    bytes,
    view,
    sections,
    version,
    tables,
    strings,
    userString,
    userStrings,
    blob,
    rvaToOffset,
    rows,
    row: (t, i) => tables.get(t)?.[i],
  };
}

export function num(row: Row | undefined, col: string): number {
  const v = row?.[col];
  return typeof v === 'number' ? v : 0;
}

export function coded(row: Row | undefined, col: string): CodedRef {
  const v = row?.[col];
  return typeof v === 'object' ? v : { table: -1, row: 0 };
}

/** Token for a table row (table << 24 | row). */
export function token(table: number, row: number): number {
  return ((table << 24) | row) >>> 0;
}

/** [start, end) row range of a list column (fieldList, methodList, …) owned by row `i`. */
export function listRange(md: Metadata, table: number, col: string, i: number, target: number): [number, number] {
  const start = num(md.row(table, i), col);
  const next = i + 1 <= md.rows(table) ? num(md.row(table, i + 1), col) : md.rows(target) + 1;
  return [start, Math.max(start, next)];
}

/** TypeDef row whose `col` list (methodList / fieldList) contains `row`, or 0. */
export function listOwner(md: Metadata, col: 'methodList' | 'fieldList', row: number): number {
  // The list columns are non-decreasing: the owner is the last TypeDef whose
  // list starts at or before `row` (empty lists share the next one's start).
  let lo = 1;
  let hi = md.rows(T.TypeDef);
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (num(md.row(T.TypeDef, mid), col) <= row) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
