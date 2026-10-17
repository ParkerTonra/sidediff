// Builds AssemblyInfo (types, members, attributes, Acumatica roles) from the
// metadata, and searches it. Pure; runs in the assembly worker and in tests.
import { T, coded, listRange, num, readMetadata, token } from './metadata';
import type { CodedRef, Metadata } from './metadata';
import { Disassembler, stringUses } from './il';
import { Names, SigReader, decodeAttribute, decodeFieldSig, decodeMethodSig, stripArity } from './signatures';
import type { DecodedAttribute, GenericScope } from './signatures';
import type { AcumaticaRole, AsmMember, AsmSearchHit, AsmType, AssemblyInfo, SearchOptions } from '../types';

export interface LoadedAssembly {
  md: Metadata;
  names: Names;
  info: AssemblyInfo;
  dis: Disassembler;
  /** #US entries with the MethodDef rows that load them. */
  strings: { offset: number; text: string; methods: number[] }[];
  /** MethodDef row → [type full name, member name]. */
  methodHome: Map<number, [string, string]>;
}

const ACCESS = ['', 'private', 'private protected', 'internal', 'protected', 'protected internal', 'public'];
/** Framework base types themselves get no role badge (relevant when PX stubs live in the same assembly). */
const FRAMEWORK = new Set(['PXGraph', 'PXGraphExtension', 'PXCacheExtension', 'IBqlTable', 'PXBqlTable', 'PXEventSubscriberAttribute']);

/** Members whose names start with '<' are compiler-generated (backing fields, closures). */
const generated = (name: string): boolean => name.startsWith('<');

function rank(access: string): number {
  return ['private', 'private protected', 'internal', 'protected', 'protected internal', 'public'].indexOf(access);
}

export function loadAssembly(bytes: Uint8Array): LoadedAssembly {
  const md = readMetadata(bytes);
  if (!md.rows(T.TypeDef) && !md.rows(T.Assembly)) throw new Error('This file has no .NET metadata.');
  const names = new Names(md);
  const dis = new Disassembler(md, names);

  // CustomAttribute rows by parent.
  const attrsOf = new Map<string, DecodedAttribute[]>();
  const caRows = md.tables.get(T.CustomAttribute) ?? [];
  for (let i = 1; i < caRows.length; i++) {
    const parent = coded(caRows[i], 'parent');
    const key = `${parent.table}:${parent.row}`;
    const list = attrsOf.get(key) ?? [];
    list.push(decodeAttribute(md, names, coded(caRows[i], 'type'), md.blob(num(caRows[i], 'value'))));
    attrsOf.set(key, list);
  }
  const attrs = (table: number, row: number): DecodedAttribute[] =>
    (attrsOf.get(`${table}:${row}`) ?? []).filter((a) => !a.fullName.startsWith('System.Runtime.CompilerServices.'));

  // Accessor methods (hidden from the method list) and their owners.
  const accessors = new Set<number>();
  /** Property/Event row key → its accessor methods with their semantics. */
  const accessorsOf = new Map<string, { method: number; semantics: number }[]>();
  const sem = md.tables.get(T.MethodSemantics) ?? [];
  for (let i = 1; i < sem.length; i++) {
    const method = num(sem[i], 'method');
    const assoc = coded(sem[i], 'association');
    accessors.add(method);
    const key = `${assoc.table}:${assoc.row}`;
    accessorsOf.set(key, [...(accessorsOf.get(key) ?? []), { method, semantics: num(sem[i], 'semantics') }]);
  }
  const propertyMapOf = parentIndex(md, T.PropertyMap);
  const eventMapOf = parentIndex(md, T.EventMap);

  // Constants (const field values).
  const constants = new Map<number, string>();
  const consts = md.tables.get(T.Constant) ?? [];
  for (let i = 1; i < consts.length; i++) {
    const parent = coded(consts[i], 'parent');
    if (parent.table !== T.Field) continue;
    const v = constantText(num(consts[i], 'type') & 0xff, md.blob(num(consts[i], 'value')));
    if (v !== null) constants.set(parent.row, v);
  }

  const interfacesOf = new Map<number, CodedRef[]>();
  const ifaces = md.tables.get(T.InterfaceImpl) ?? [];
  for (let i = 1; i < ifaces.length; i++) {
    const cls = num(ifaces[i], 'class');
    interfacesOf.set(cls, [...(interfacesOf.get(cls) ?? []), coded(ifaces[i], 'interface')]);
  }

  /** Generic base: the open type ref plus type-argument texts, or the plain ref. */
  const baseOf = (ref: CodedRef, scope: GenericScope): { ref: CodedRef; args: string[] } => {
    if (ref.table !== T.TypeSpec) return { ref, args: [] };
    const r = new SigReader(md.blob(num(md.row(T.TypeSpec, ref.row), 'signature')), names);
    try {
      if (r.u8() !== 0x15) return { ref, args: [] };
      r.u8();
      const open = r.typeDefOrRef();
      const n = r.uint();
      const args: string[] = [];
      for (let i = 0; i < n; i++) args.push(r.type(scope));
      return { ref: open, args };
    } catch {
      return { ref, args: [] };
    }
  };

  const roleOf = (row: number): { role?: AcumaticaRole; extends?: string } => {
    const own = stripArity(md.strings(num(md.row(T.TypeDef, row), 'name')));
    if (FRAMEWORK.has(own)) return {};
    let implementsTable = false;
    let current = row;
    const seen = new Set<number>();
    for (let depth = 0; depth < 32 && current && !seen.has(current); depth++) {
      seen.add(current);
      for (const i of interfacesOf.get(current) ?? []) if (stripArity(names.nsAndName(baseOf(i, { type: [], method: [] }).ref).name) === 'IBqlTable') implementsTable = true;
      const ext = coded(md.row(T.TypeDef, current), 'extends');
      if (!ext.row) break;
      const scope = { type: names.genericParamsOf(T.TypeDef, current), method: [] };
      const { ref, args } = baseOf(ext, scope);
      const { name } = names.nsAndName(ref);
      const bare = stripArity(name);
      const arity = name.includes('`');
      const last = args[args.length - 1];
      if (bare === 'PXGraphExtension' && arity) return { role: 'graphExtension', ...(last ? { extends: last } : {}) };
      if (bare === 'PXCacheExtension' && arity) return { role: 'dacExtension', ...(last ? { extends: last } : {}) };
      if (bare === 'PXGraph') return { role: 'graph' };
      if (bare === 'PXEventSubscriberAttribute') return { role: 'attribute' };
      if (bare === 'PXBqlTable') return { role: 'dac' };
      current = ref.table === T.TypeDef ? ref.row : 0;
    }
    return implementsTable ? { role: 'dac' } : {};
  };

  const methodHome = new Map<number, [string, string]>();
  const types: AsmType[] = [];
  const nTypes = md.rows(T.TypeDef);
  for (let row = 1; row <= nTypes; row++) {
    const tr = md.row(T.TypeDef, row);
    const rawName = md.strings(num(tr, 'name'));
    if (rawName === '<Module>' || generated(rawName)) continue;
    let enclosing = names.enclosing(row);
    let hidden = false;
    while (enclosing) {
      if (generated(md.strings(num(md.row(T.TypeDef, enclosing), 'name')))) hidden = true;
      enclosing = names.enclosing(enclosing);
    }
    if (hidden) continue;
    const flags = num(tr, 'flags');
    const typeParams = names.genericParamsOf(T.TypeDef, row);
    const scope: GenericScope = { type: typeParams, method: [] };
    const ext = coded(tr, 'extends');
    const baseName = ext.row ? names.nsAndName(baseOf(ext, scope).ref) : { ns: '', name: '' };
    const sys = baseName.ns === 'System';
    const kind: AsmType['kind'] =
      flags & 0x20
        ? 'interface'
        : sys && baseName.name === 'Enum'
          ? 'enum'
          : sys && baseName.name === 'ValueType'
            ? 'struct'
            : sys && baseName.name === 'MulticastDelegate'
              ? 'delegate'
              : 'class';
    const vis = flags & 7;
    const fullName = names.typeDefFullName(row);
    const ns = md.strings(num(tr, 'namespace'));
    const outerPrefix = (() => {
      const parts: string[] = [];
      let o = names.enclosing(row);
      while (o) {
        parts.unshift(stripArity(md.strings(num(md.row(T.TypeDef, o), 'name'))));
        o = names.enclosing(o);
      }
      return parts.length ? parts.join('.') + '.' : '';
    })();
    const display = outerPrefix + stripArity(rawName) + (typeParams.length ? `<${typeParams.join(', ')}>` : '');
    const role = roleOf(row);
    const members: AsmMember[] = [];
    const isInterface = kind === 'interface';

    // Fields.
    const [f0, f1] = listRange(md, T.TypeDef, 'fieldList', row, T.Field);
    for (let f = f0; f < f1; f++) {
      const fr = md.row(T.Field, f);
      const name = md.strings(num(fr, 'name'));
      if (generated(name) || (kind === 'enum' && name === 'value__')) continue;
      const ff = num(fr, 'flags');
      let type = '?';
      try {
        type = decodeFieldSig(md.blob(num(fr, 'signature')), names, scope);
      } catch {
        /* keep ? */
      }
      const value = constants.get(f);
      const signature =
        kind === 'enum'
          ? `${name}${value !== undefined ? ` = ${value}` : ''}`
          : [
              ACCESS[ff & 7],
              ff & 0x40 ? 'const' : ff & 0x10 ? 'static' : '',
              ff & 0x20 && !(ff & 0x40) ? 'readonly' : '',
              type,
              name + (value !== undefined ? ` = ${value}` : ''),
            ]
              .filter(Boolean)
              .join(' ');
      members.push({ kind: 'field', name, signature, attributes: attrs(T.Field, f).map((a) => a.text), token: token(T.Field, f) });
    }

    // Methods (accessors are listed under their property/event).
    const [m0, m1] = listRange(md, T.TypeDef, 'methodList', row, T.MethodDef);
    for (let m = m0; m < m1; m++) {
      const mr = md.row(T.MethodDef, m);
      const name = md.strings(num(mr, 'name'));
      methodHome.set(m, [fullName, name]);
      if (generated(name) || accessors.has(m)) continue;
      const mf = num(mr, 'flags');
      const mScope: GenericScope = { type: typeParams, method: names.genericParamsOf(T.MethodDef, m) };
      let sig = { ret: '?', params: [] as string[], hasThis: true, genericCount: 0 };
      try {
        sig = decodeMethodSig(md.blob(num(mr, 'signature')), names, mScope);
      } catch {
        /* keep ? */
      }
      const pNames = paramNames(md, m, sig.params.length);
      const params = sig.params.map((t, i) => `${t} ${pNames[i] ?? `p${i}`}`).join(', ');
      const access = isInterface ? '' : ACCESS[mf & 7]!;
      const isCtor = name === '.ctor' || name === '.cctor';
      const shortType = stripArity(rawName);
      let signature: string;
      if (name === '.cctor') signature = `static ${shortType}()`;
      else if (name === '.ctor') signature = `${access} ${shortType}(${params})`.trim();
      else {
        const mods = isInterface ? [] : modifiers(mf);
        const gen = mScope.method.length ? `<${mScope.method.join(', ')}>` : '';
        signature = [access, ...mods, sig.ret, `${name}${gen}(${params})`].filter(Boolean).join(' ');
      }
      members.push({ kind: isCtor ? 'ctor' : 'method', name, signature, attributes: attrs(T.MethodDef, m).map((a) => a.text), token: token(T.MethodDef, m) });
    }

    // Properties.
    const pm = propertyMapOf.get(row) ?? 0;
    if (pm) {
      const [p0, p1] = listRange(md, T.PropertyMap, 'propertyList', pm, T.Property);
      for (let p = p0; p < p1; p++) {
        const pr = md.row(T.Property, p);
        const name = md.strings(num(pr, 'name'));
        if (generated(name)) continue;
        let type = '?';
        let indexParams: string[] = [];
        try {
          const s = decodeMethodSig(md.blob(num(pr, 'type')), names, scope);
          type = s.ret;
          indexParams = s.params;
        } catch {
          /* keep ? */
        }
        let get: number | undefined;
        let set: number | undefined;
        for (const a of accessorsOf.get(`${T.Property}:${p}`) ?? []) {
          if (a.semantics & 0x2) get = a.method;
          if (a.semantics & 0x1) set = a.method;
        }
        const accFlags = [get, set].filter((x): x is number => x !== undefined).map((m) => num(md.row(T.MethodDef, m), 'flags'));
        const best = accFlags.map((f) => ACCESS[f & 7]!).sort((x, y) => rank(y) - rank(x))[0] ?? 'private';
        const mods = isInterface || accFlags[0] === undefined ? [] : modifiers(accFlags[0]);
        const label = name === 'Item' && indexParams.length ? `this[${indexParams.join(', ')}]` : name;
        const acc = [get !== undefined ? 'get;' : '', set !== undefined ? 'set;' : ''].filter(Boolean).join(' ');
        const signature = [isInterface ? '' : best, ...mods, type, `${label} { ${acc} }`].filter(Boolean).join(' ');
        members.push({ kind: 'property', name, signature, attributes: attrs(T.Property, p).map((a) => a.text), token: token(T.Property, p) });
      }
    }

    // Events.
    const em = eventMapOf.get(row) ?? 0;
    if (em) {
      const [e0, e1] = listRange(md, T.EventMap, 'eventList', em, T.Event);
      for (let e = e0; e < e1; e++) {
        const er = md.row(T.Event, e);
        const name = md.strings(num(er, 'name'));
        const type = names.typeName(coded(er, 'eventType'), scope);
        let access = 'public';
        for (const a of accessorsOf.get(`${T.Event}:${e}`) ?? []) access = ACCESS[num(md.row(T.MethodDef, a.method), 'flags') & 7]!;
        members.push({ kind: 'event', name, signature: `${isInterface ? '' : access + ' '}event ${type} ${name}`, attributes: attrs(T.Event, e).map((a) => a.text), token: token(T.Event, e) });
      }
    }

    const baseType =
      ext.row && kind === 'class' && !(sys && baseName.name === 'Object') ? names.typeName(ext, scope) : undefined;
    types.push({
      fullName,
      namespace: ns || (names.enclosing(row) ? nsOfOutermost(md, names, row) : ''),
      name: display,
      kind,
      visibility: vis === 1 ? 'public' : vis === 0 ? 'internal' : 'nested',
      ...(baseType ? { baseType } : {}),
      interfaces: (interfacesOf.get(row) ?? []).map((i) => names.typeName(i, scope)),
      attributes: attrs(T.TypeDef, row).map((a) => a.text),
      ...(role.role ? { acumatica: role.role } : {}),
      ...(role.extends ? { extends: role.extends } : {}),
      members,
      token: token(T.TypeDef, row),
    });
  }

  const asm = md.row(T.Assembly, 1);
  const version = asm ? `${num(asm, 'major')}.${num(asm, 'minor')}.${num(asm, 'build')}.${num(asm, 'revision')}` : '';
  const references: { name: string; version: string }[] = [];
  for (let i = 1; i <= md.rows(T.AssemblyRef); i++) {
    const r = md.row(T.AssemblyRef, i);
    references.push({ name: md.strings(num(r, 'name')), version: `${num(r, 'major')}.${num(r, 'minor')}.${num(r, 'build')}.${num(r, 'revision')}` });
  }
  const tfm = (attrsOf.get(`${T.Assembly}:1`) ?? []).find((a) => a.fullName === 'System.Runtime.Versioning.TargetFrameworkAttribute');
  const uses = stringUses(md);
  const strings = md.userStrings().map((s) => ({ ...s, methods: uses.get(s.offset) ?? [] }));
  types.sort((a, b) => a.fullName.localeCompare(b.fullName));
  const info: AssemblyInfo = {
    name: asm ? md.strings(num(asm, 'name')) : md.strings(num(md.row(T.Module, 1), 'name')),
    version,
    ...(tfm?.strings['0'] ? { targetFramework: tfm.strings['0'] } : {}),
    references,
    types,
    stringCount: strings.length,
  };
  return { md, names, info, dis, strings, methodHome };
}

function modifiers(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x10) out.push('static');
  if (flags & 0x400) out.push('abstract');
  else if (flags & 0x40) {
    if (flags & 0x100) {
      if (!(flags & 0x20)) out.push('virtual');
    } else out.push(flags & 0x20 ? 'sealed override' : 'override');
  }
  return out;
}

function paramNames(md: Metadata, methodRow: number, count: number): string[] {
  const [p0, p1] = listRange(md, T.MethodDef, 'paramList', methodRow, T.Param);
  const out: string[] = new Array<string>(count);
  for (let p = p0; p < p1; p++) {
    const pr = md.row(T.Param, p);
    const seq = num(pr, 'sequence');
    if (seq > 0 && seq <= count) out[seq - 1] = md.strings(num(pr, 'name'));
  }
  return out;
}

/** PropertyMap/EventMap: parent TypeDef row → map row. */
function parentIndex(md: Metadata, table: number): Map<number, number> {
  const out = new Map<number, number>();
  const n = md.rows(table);
  for (let i = 1; i <= n; i++) out.set(num(md.row(table, i), 'parent'), i);
  return out;
}

function nsOfOutermost(md: Metadata, names: Names, row: number): string {
  let o = row;
  while (names.enclosing(o)) o = names.enclosing(o)!;
  return md.strings(num(md.row(T.TypeDef, o), 'namespace'));
}

function constantText(type: number, b: Uint8Array): string | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    switch (type) {
      case 0x02:
        return v.getUint8(0) ? 'true' : 'false';
      case 0x03:
        return `'${String.fromCharCode(v.getUint16(0, true))}'`;
      case 0x04:
        return String(v.getInt8(0));
      case 0x05:
        return String(v.getUint8(0));
      case 0x06:
        return String(v.getInt16(0, true));
      case 0x07:
        return String(v.getUint16(0, true));
      case 0x08:
        return String(v.getInt32(0, true));
      case 0x09:
        return String(v.getUint32(0, true));
      case 0x0a:
        return String(v.getBigInt64(0, true));
      case 0x0b:
        return String(v.getBigUint64(0, true));
      case 0x0c:
        return String(v.getFloat32(0, true));
      case 0x0d:
        return String(v.getFloat64(0, true));
      case 0x0e:
        return JSON.stringify(new TextDecoder('utf-16le').decode(b));
      case 0x12:
        return 'null';
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// --- search -------------------------------------------------------------------

export function makeMatcher(query: string, options: SearchOptions = {}): (s: string) => number {
  if (options.regex) {
    const re = new RegExp(query, options.caseSensitive ? '' : 'i');
    return (s) => s.search(re);
  }
  if (options.caseSensitive) return (s) => s.indexOf(query);
  const q = query.toLowerCase();
  return (s) => s.toLowerCase().indexOf(q);
}

function preview(text: string, at: number, max = 160): string {
  const flat = text.replace(/\s+/g, ' ');
  if (flat.length <= max) return flat;
  const start = Math.max(0, Math.min(at - 40, flat.length - max));
  return (start > 0 ? '…' : '') + flat.slice(start, start + max) + (start + max < flat.length ? '…' : '');
}

export function searchAssembly(a: LoadedAssembly, query: string, options: SearchOptions = {}): AsmSearchHit[] {
  if (!query) return [];
  const match = makeMatcher(query, options);
  const limit = options.limit ?? 500;
  const hits: AsmSearchHit[] = [];
  const add = (h: AsmSearchHit): boolean => {
    hits.push(h);
    return hits.length >= limit;
  };
  for (const t of a.info.types) {
    const typeText = [t.fullName, t.name, ...t.attributes].find((s) => match(s) >= 0);
    if (typeText !== undefined && add({ kind: 'type', typeFullName: t.fullName, token: t.token, preview: preview(typeText, match(typeText)) })) return hits;
    for (const m of t.members) {
      const text = [m.name, m.signature, ...m.attributes].find((s) => match(s) >= 0);
      if (text !== undefined && add({ kind: 'member', typeFullName: t.fullName, memberName: m.name, token: m.token, preview: preview(text, match(text)) })) return hits;
    }
  }
  for (const s of a.strings) {
    const at = match(s.text);
    if (at < 0) continue;
    const homes = s.methods.length ? s.methods : [0];
    for (const m of homes) {
      const home = a.methodHome.get(m);
      const hit: AsmSearchHit = { kind: 'string', typeFullName: home?.[0] ?? '', preview: preview(s.text, at) };
      if (home) {
        hit.memberName = home[1];
        hit.token = token(T.MethodDef, m);
      }
      if (add(hit)) return hits;
    }
  }
  return hits;
}

export function ilListing(a: LoadedAssembly, methodToken: number): string {
  if (methodToken >>> 24 !== T.MethodDef) throw new Error('IL is available for methods only.');
  return a.dis.method(methodToken & 0xffffff);
}

export { loadAssembly as buildAssembly };
