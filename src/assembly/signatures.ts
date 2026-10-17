// Signature and custom-attribute blob decoding (ECMA-335 II.23.2, II.23.3)
// into C#-like text: "List<ContosoRoute>", "decimal?", "string[]".
import { MetadataError, T, coded, listOwner, num, readCompressedUInt } from './metadata';
import type { CodedRef, Metadata } from './metadata';

const KEYWORDS: Record<string, string> = {
  Void: 'void',
  Boolean: 'bool',
  Char: 'char',
  SByte: 'sbyte',
  Byte: 'byte',
  Int16: 'short',
  UInt16: 'ushort',
  Int32: 'int',
  UInt32: 'uint',
  Int64: 'long',
  UInt64: 'ulong',
  Single: 'float',
  Double: 'double',
  Decimal: 'decimal',
  String: 'string',
  Object: 'object',
  IntPtr: 'nint',
  UIntPtr: 'nuint',
};

const PRIMITIVE: Record<number, string> = {
  0x01: 'void',
  0x02: 'bool',
  0x03: 'char',
  0x04: 'sbyte',
  0x05: 'byte',
  0x06: 'short',
  0x07: 'ushort',
  0x08: 'int',
  0x09: 'uint',
  0x0a: 'long',
  0x0b: 'ulong',
  0x0c: 'float',
  0x0d: 'double',
  0x0e: 'string',
  0x16: 'TypedReference',
  0x18: 'nint',
  0x19: 'nuint',
  0x1c: 'object',
};

/** "List`1" → "List". */
export function stripArity(name: string): string {
  const i = name.indexOf('`');
  return i < 0 ? name : name.slice(0, i);
}

/** Generic parameter names in scope while decoding. */
export interface GenericScope {
  type: string[];
  method: string[];
}

const EMPTY: GenericScope = { type: [], method: [] };

export class Names {
  private readonly nestedIn = new Map<number, number>();
  private readonly genericParams = new Map<string, string[]>();

  constructor(private readonly md: Metadata) {
    const nested = md.tables.get(T.NestedClass) ?? [];
    for (let i = 1; i < nested.length; i++) this.nestedIn.set(num(nested[i], 'nested'), num(nested[i], 'enclosing'));
    const gps = md.tables.get(T.GenericParam) ?? [];
    for (let i = 1; i < gps.length; i++) {
      const owner = coded(gps[i], 'owner');
      const key = `${owner.table}:${owner.row}`;
      const list = this.genericParams.get(key) ?? [];
      list[num(gps[i], 'number')] = md.strings(num(gps[i], 'name'));
      this.genericParams.set(key, list);
    }
  }

  enclosing(typeDefRow: number): number | undefined {
    return this.nestedIn.get(typeDefRow);
  }

  genericParamsOf(table: number, row: number): string[] {
    return this.genericParams.get(`${table}:${row}`) ?? [];
  }

  /** Reflection-style full name: "Ns.Outer+Inner`1". */
  typeDefFullName(row: number): string {
    const r = this.md.row(T.TypeDef, row);
    const name = this.md.strings(num(r, 'name'));
    const outer = this.nestedIn.get(row);
    if (outer) return `${this.typeDefFullName(outer)}+${name}`;
    const ns = this.md.strings(num(r, 'namespace'));
    return ns ? `${ns}.${name}` : name;
  }

  /** Namespace + simple metadata name of a TypeDef or TypeRef (outermost namespace for nested). */
  nsAndName(ref: CodedRef): { ns: string; name: string } {
    if (ref.table === T.TypeDef) {
      const r = this.md.row(T.TypeDef, ref.row);
      let outer = ref.row;
      while (this.nestedIn.get(outer)) outer = this.nestedIn.get(outer)!;
      return { ns: this.md.strings(num(this.md.row(T.TypeDef, outer), 'namespace')), name: this.md.strings(num(r, 'name')) };
    }
    if (ref.table === T.TypeRef) {
      const r = this.md.row(T.TypeRef, ref.row);
      let ns = this.md.strings(num(r, 'namespace'));
      let scope = coded(r, 'scope');
      while (!ns && scope.table === T.TypeRef && scope.row) {
        const outer = this.md.row(T.TypeRef, scope.row);
        ns = this.md.strings(num(outer, 'namespace'));
        scope = coded(outer, 'scope');
      }
      return { ns, name: this.md.strings(num(r, 'name')) };
    }
    return { ns: '', name: '' };
  }

  /** C#-like short name of a TypeDef/TypeRef/TypeSpec, e.g. "Outer.Inner", "int", "PXGraph<T>". */
  typeName(ref: CodedRef, scope: GenericScope = EMPTY): string {
    if (ref.table === T.TypeSpec) {
      const sig = this.md.blob(num(this.md.row(T.TypeSpec, ref.row), 'signature'));
      try {
        return new SigReader(sig, this).type(scope);
      } catch {
        return '?';
      }
    }
    if (ref.table === T.TypeDef) {
      const r = this.md.row(T.TypeDef, ref.row);
      const own = stripArity(this.md.strings(num(r, 'name')));
      const outer = this.nestedIn.get(ref.row);
      const ns = this.md.strings(num(r, 'namespace'));
      if (!outer && ns === 'System' && KEYWORDS[own]) return KEYWORDS[own];
      return outer ? `${this.typeName({ table: T.TypeDef, row: outer })}.${own}` : own;
    }
    if (ref.table === T.TypeRef) {
      const r = this.md.row(T.TypeRef, ref.row);
      const own = stripArity(this.md.strings(num(r, 'name')));
      const scopeRef = coded(r, 'scope');
      if (scopeRef.table === T.TypeRef && scopeRef.row) return `${this.typeName(scopeRef)}.${own}`;
      if (this.md.strings(num(r, 'namespace')) === 'System' && KEYWORDS[own]) return KEYWORDS[own];
      return own;
    }
    return '?';
  }

  /** Reflection-style full name of a TypeDef/TypeRef ("System.Collections.Generic.List`1"). */
  fullName(ref: CodedRef): string {
    if (ref.table === T.TypeDef) return this.typeDefFullName(ref.row);
    if (ref.table === T.TypeRef) {
      const r = this.md.row(T.TypeRef, ref.row);
      const name = this.md.strings(num(r, 'name'));
      const scope = coded(r, 'scope');
      if (scope.table === T.TypeRef && scope.row) return `${this.fullName(scope)}+${name}`;
      const ns = this.md.strings(num(r, 'namespace'));
      return ns ? `${ns}.${name}` : name;
    }
    return '';
  }
}

/** Cursor over one signature blob. */
export class SigReader {
  pos = 0;

  constructor(
    readonly b: Uint8Array,
    private readonly names: Names,
  ) {}

  u8(): number {
    const v = this.b[this.pos++];
    if (v === undefined) throw new MetadataError('signature ends early');
    return v;
  }

  peek(): number {
    return this.b[this.pos] ?? -1;
  }

  uint(): number {
    const { value, size } = readCompressedUInt(this.b, this.pos);
    this.pos += size;
    return value;
  }

  typeDefOrRef(): CodedRef {
    const v = this.uint();
    const tag = v & 3;
    return { table: tag === 0 ? T.TypeDef : tag === 1 ? T.TypeRef : T.TypeSpec, row: v >>> 2 };
  }

  /** Skips custom modifiers; returns true if `modreq(IsVolatile)`-style mods were seen. */
  skipMods(): void {
    while (this.peek() === 0x1f || this.peek() === 0x20) {
      this.u8();
      this.typeDefOrRef();
    }
  }

  type(scope: GenericScope): string {
    this.skipMods();
    const e = this.u8();
    const prim = PRIMITIVE[e];
    if (prim) return prim;
    switch (e) {
      case 0x0f:
        return `${this.type(scope)}*`;
      case 0x10:
        return `ref ${this.type(scope)}`;
      case 0x11:
      case 0x12:
        return this.names.typeName(this.typeDefOrRef(), scope);
      case 0x13: {
        const n = this.uint();
        return scope.type[n] ?? `!${n}`;
      }
      case 0x1e: {
        const n = this.uint();
        return scope.method[n] ?? `!!${n}`;
      }
      case 0x14: {
        const el = this.type(scope);
        const rank = this.uint();
        const nSizes = this.uint();
        for (let i = 0; i < nSizes; i++) this.uint();
        const nLo = this.uint();
        for (let i = 0; i < nLo; i++) this.uint();
        return `${el}[${','.repeat(Math.max(0, rank - 1))}]`;
      }
      case 0x1d:
        return `${this.type(scope)}[]`;
      case 0x15: {
        this.u8(); // CLASS or VALUETYPE
        const genRef = this.typeDefOrRef();
        const n = this.uint();
        const args: string[] = [];
        for (let i = 0; i < n; i++) args.push(this.type(scope));
        const { ns, name } = this.names.nsAndName(genRef);
        if (ns === 'System' && name === 'Nullable`1' && args.length === 1) return `${args[0]}?`;
        return `${this.names.typeName(genRef, scope)}<${args.join(', ')}>`;
      }
      case 0x1b: {
        const m = this.methodSig(scope);
        return `delegate*<${[...m.params, m.ret].join(', ')}>`;
      }
      case 0x45:
        return this.type(scope);
      default:
        throw new MetadataError(`unknown element type 0x${e.toString(16)}`);
    }
  }

  /** Method or property signature: return type and parameter types. */
  methodSig(scope: GenericScope): { ret: string; params: string[]; hasThis: boolean; genericCount: number } {
    const head = this.u8();
    const hasThis = (head & 0x20) !== 0;
    const genericCount = head & 0x10 ? this.uint() : 0;
    const n = this.uint();
    const ret = this.type(scope);
    const params: string[] = [];
    for (let i = 0; i < n; i++) {
      if (this.peek() === 0x41) {
        this.u8(); // sentinel (vararg)
        params.push('__arglist');
      }
      params.push(this.type(scope));
    }
    return { ret, params, hasThis, genericCount };
  }
}

export function decodeFieldSig(blob: Uint8Array, names: Names, scope: GenericScope): string {
  const r = new SigReader(blob, names);
  if (r.u8() !== 0x06) throw new MetadataError('not a field signature');
  return r.type(scope);
}

export function decodeMethodSig(blob: Uint8Array, names: Names, scope: GenericScope): ReturnType<SigReader['methodSig']> {
  return new SigReader(blob, names).methodSig(scope);
}

export function decodeLocals(blob: Uint8Array, names: Names, scope: GenericScope): string[] {
  const r = new SigReader(blob, names);
  if (r.u8() !== 0x07) throw new MetadataError('not a local signature');
  const n = r.uint();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let pinned = false;
    r.skipMods();
    if (r.peek() === 0x45) {
      r.u8();
      pinned = true;
    }
    out.push(r.type(scope) + (pinned ? ' pinned' : ''));
  }
  return out;
}

// --- custom attributes -------------------------------------------------------

/** Element type of a custom-attribute argument, as needed to read its value. */
type ArgType =
  | { k: 'prim'; e: number }
  | { k: 'string' }
  | { k: 'type' }
  | { k: 'boxed' }
  | { k: 'enum'; name: string }
  | { k: 'array'; of: ArgType };

function argTypeFromSig(r: SigReader, names: Names): ArgType {
  r.skipMods();
  const e = r.u8();
  if (e === 0x0e) return { k: 'string' };
  if (e === 0x1c) return { k: 'boxed' };
  if (e === 0x1d) return { k: 'array', of: argTypeFromSig(r, names) };
  if (e >= 0x02 && e <= 0x0d) return { k: 'prim', e };
  if (e === 0x11 || e === 0x12) {
    const ref = r.typeDefOrRef();
    const { ns, name } = names.nsAndName(ref);
    if (ns === 'System' && name === 'Type') return { k: 'type' };
    // A value type in an attribute ctor is an enum; its underlying type is
    // unknown without the defining assembly, int32 is by far the common case.
    return { k: 'enum', name: names.typeName(ref) };
  }
  throw new MetadataError('unsupported attribute argument type');
}

class AttrReader {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}

  private need(n: number): void {
    if (this.pos + n > this.b.length) throw new MetadataError('attribute blob ends early');
  }

  u8(): number {
    this.need(1);
    return this.b[this.pos++]!;
  }

  num(e: number): string {
    const sizes: Record<number, number> = { 2: 1, 3: 2, 4: 1, 5: 1, 6: 2, 7: 2, 8: 4, 9: 4, 10: 8, 11: 8, 12: 4, 13: 8 };
    const n = sizes[e] ?? 4;
    this.need(n);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, n);
    this.pos += n;
    switch (e) {
      case 2:
        return v.getUint8(0) ? 'true' : 'false';
      case 3:
        return JSON.stringify(String.fromCharCode(v.getUint16(0, true))).replace(/^"|"$/g, "'");
      case 4:
        return String(v.getInt8(0));
      case 5:
        return String(v.getUint8(0));
      case 6:
        return String(v.getInt16(0, true));
      case 7:
        return String(v.getUint16(0, true));
      case 8:
        return String(v.getInt32(0, true));
      case 9:
        return String(v.getUint32(0, true));
      case 10:
        return String(v.getBigInt64(0, true));
      case 11:
        return String(v.getBigUint64(0, true));
      case 12:
        return String(v.getFloat32(0, true));
      default:
        return String(v.getFloat64(0, true));
    }
  }

  serString(): string | null {
    this.need(1);
    if (this.b[this.pos] === 0xff) {
      this.pos++;
      return null;
    }
    const { value, size } = readCompressedUInt(this.b, this.pos);
    this.pos += size;
    this.need(value);
    const s = utf8.decode(this.b.subarray(this.pos, this.pos + value));
    this.pos += value;
    return s;
  }

  value(t: ArgType): string {
    switch (t.k) {
      case 'prim':
        return this.num(t.e);
      case 'string': {
        const s = this.serString();
        return s === null ? 'null' : JSON.stringify(s);
      }
      case 'type': {
        const s = this.serString();
        return s === null ? 'null' : `typeof(${s.split(',')[0]})`;
      }
      case 'enum':
        return `(${t.name})${this.num(8)}`;
      case 'array': {
        this.need(4);
        const n = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4).getUint32(0, true);
        this.pos += 4;
        if (n === 0xffffffff) return 'null';
        const items: string[] = [];
        for (let i = 0; i < n; i++) items.push(this.value(t.of));
        return `new[] { ${items.join(', ')} }`;
      }
      case 'boxed':
        return this.value(this.fieldOrPropType());
    }
  }

  /** FieldOrPropType (II.23.3) of a named argument or a boxed value. */
  fieldOrPropType(): ArgType {
    const e = this.u8();
    if (e === 0x0e) return { k: 'string' };
    if (e === 0x50) return { k: 'type' };
    if (e === 0x51) return { k: 'boxed' };
    if (e === 0x1d) return { k: 'array', of: this.fieldOrPropType() };
    if (e === 0x55) return { k: 'enum', name: (this.serString() ?? '').split(',')[0]!.split('.').pop() ?? 'enum' };
    if (e >= 0x02 && e <= 0x0d) return { k: 'prim', e };
    throw new MetadataError('unsupported named argument type');
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

export interface DecodedAttribute {
  /** "PXUIField" (Attribute suffix removed). */
  name: string;
  /** Reflection full name of the attribute class. */
  fullName: string;
  /** "PXUIField(DisplayName = \"Route Code\")". */
  text: string;
  /** String values by argument (positional index or named), for DisplayName/PXCacheName. */
  strings: Record<string, string>;
}

/** Decodes one CustomAttribute row: class name plus arguments when the blob parses. */
export function decodeAttribute(md: Metadata, names: Names, ctor: CodedRef, value: Uint8Array): DecodedAttribute {
  let classRef: CodedRef = { table: -1, row: 0 };
  let sig: Uint8Array = new Uint8Array(0);
  if (ctor.table === T.MemberRef) {
    const mr = md.row(T.MemberRef, ctor.row);
    classRef = coded(mr, 'class');
    sig = md.blob(num(mr, 'signature'));
  } else if (ctor.table === T.MethodDef) {
    sig = md.blob(num(md.row(T.MethodDef, ctor.row), 'signature'));
    const owner = listOwner(md, 'methodList', ctor.row);
    if (owner) classRef = { table: T.TypeDef, row: owner };
  }
  const fullName = classRef.table === T.TypeSpec ? names.typeName(classRef) : names.fullName(classRef);
  let short = classRef.table === T.TypeSpec ? fullName : names.typeName(classRef);
  if (short.endsWith('Attribute') && short.length > 'Attribute'.length) short = short.slice(0, -'Attribute'.length);
  const out: DecodedAttribute = { name: short, fullName, text: short, strings: {} };
  if (value.length < 2) return out;
  try {
    const sr = new SigReader(sig, names);
    const head = sr.u8();
    if (head & 0x10) sr.uint();
    const n = sr.uint();
    sr.u8(); // return type: void
    const types: ArgType[] = [];
    for (let i = 0; i < n; i++) types.push(argTypeFromSig(sr, names));
    const ar = new AttrReader(value);
    if (ar.u8() !== 0x01 || ar.u8() !== 0x00) return out;
    const args: string[] = [];
    types.forEach((t, i) => {
      const v = ar.value(t);
      if (t.k === 'string' && v !== 'null') out.strings[String(i)] = JSON.parse(v) as string;
      args.push(v);
    });
    const named = ar.u8() | (ar.u8() << 8);
    for (let i = 0; i < named; i++) {
      ar.u8(); // 0x53 field / 0x54 property
      const t = ar.fieldOrPropType();
      const name = ar.serString() ?? '?';
      const v = ar.value(t);
      if (t.k === 'string' && v !== 'null') out.strings[name] = JSON.parse(v) as string;
      args.push(`${name} = ${v}`);
    }
    out.text = args.length ? `${short}(${args.join(', ')})` : short;
  } catch {
    // Keep the bare name when the blob uses something we can't size (e.g. a non-int enum).
  }
  return out;
}
