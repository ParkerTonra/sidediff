// IL disassembler (ECMA-335 III): method body header, opcode table, operands
// with tokens resolved to names. No .NET needed; also the fallback when the
// decompiler bundle can't load.
import { MetadataError, T, coded, listOwner, num } from './metadata';
import type { CodedRef, Metadata } from './metadata';
import { Names, SigReader, decodeFieldSig, decodeLocals, decodeMethodSig, stripArity } from './signatures';
import type { GenericScope } from './signatures';

type Operand = 'none' | 'i1' | 'i4' | 'i8' | 'r4' | 'r8' | 'tok' | 'str' | 'br1' | 'br4' | 'switch' | 'var1' | 'var2' | 'sig';

const ONE: Record<number, [string, Operand]> = {};
const TWO: Record<number, [string, Operand]> = {};

function def(table: Record<number, [string, Operand]>, entries: [number, string, Operand?][]): void {
  for (const [code, name, op] of entries) table[code] = [name, op ?? 'none'];
}

def(ONE, [
  [0x00, 'nop'], [0x01, 'break'], [0x02, 'ldarg.0'], [0x03, 'ldarg.1'], [0x04, 'ldarg.2'], [0x05, 'ldarg.3'],
  [0x06, 'ldloc.0'], [0x07, 'ldloc.1'], [0x08, 'ldloc.2'], [0x09, 'ldloc.3'], [0x0a, 'stloc.0'], [0x0b, 'stloc.1'],
  [0x0c, 'stloc.2'], [0x0d, 'stloc.3'], [0x0e, 'ldarg.s', 'var1'], [0x0f, 'ldarga.s', 'var1'], [0x10, 'starg.s', 'var1'],
  [0x11, 'ldloc.s', 'var1'], [0x12, 'ldloca.s', 'var1'], [0x13, 'stloc.s', 'var1'], [0x14, 'ldnull'], [0x15, 'ldc.i4.m1'],
  [0x16, 'ldc.i4.0'], [0x17, 'ldc.i4.1'], [0x18, 'ldc.i4.2'], [0x19, 'ldc.i4.3'], [0x1a, 'ldc.i4.4'], [0x1b, 'ldc.i4.5'],
  [0x1c, 'ldc.i4.6'], [0x1d, 'ldc.i4.7'], [0x1e, 'ldc.i4.8'], [0x1f, 'ldc.i4.s', 'i1'], [0x20, 'ldc.i4', 'i4'],
  [0x21, 'ldc.i8', 'i8'], [0x22, 'ldc.r4', 'r4'], [0x23, 'ldc.r8', 'r8'], [0x25, 'dup'], [0x26, 'pop'], [0x27, 'jmp', 'tok'],
  [0x28, 'call', 'tok'], [0x29, 'calli', 'sig'], [0x2a, 'ret'], [0x2b, 'br.s', 'br1'], [0x2c, 'brfalse.s', 'br1'],
  [0x2d, 'brtrue.s', 'br1'], [0x2e, 'beq.s', 'br1'], [0x2f, 'bge.s', 'br1'], [0x30, 'bgt.s', 'br1'], [0x31, 'ble.s', 'br1'],
  [0x32, 'blt.s', 'br1'], [0x33, 'bne.un.s', 'br1'], [0x34, 'bge.un.s', 'br1'], [0x35, 'bgt.un.s', 'br1'], [0x36, 'ble.un.s', 'br1'],
  [0x37, 'blt.un.s', 'br1'], [0x38, 'br', 'br4'], [0x39, 'brfalse', 'br4'], [0x3a, 'brtrue', 'br4'], [0x3b, 'beq', 'br4'],
  [0x3c, 'bge', 'br4'], [0x3d, 'bgt', 'br4'], [0x3e, 'ble', 'br4'], [0x3f, 'blt', 'br4'], [0x40, 'bne.un', 'br4'],
  [0x41, 'bge.un', 'br4'], [0x42, 'bgt.un', 'br4'], [0x43, 'ble.un', 'br4'], [0x44, 'blt.un', 'br4'], [0x45, 'switch', 'switch'],
  [0x46, 'ldind.i1'], [0x47, 'ldind.u1'], [0x48, 'ldind.i2'], [0x49, 'ldind.u2'], [0x4a, 'ldind.i4'], [0x4b, 'ldind.u4'],
  [0x4c, 'ldind.i8'], [0x4d, 'ldind.i'], [0x4e, 'ldind.r4'], [0x4f, 'ldind.r8'], [0x50, 'ldind.ref'], [0x51, 'stind.ref'],
  [0x52, 'stind.i1'], [0x53, 'stind.i2'], [0x54, 'stind.i4'], [0x55, 'stind.i8'], [0x56, 'stind.r4'], [0x57, 'stind.r8'],
  [0x58, 'add'], [0x59, 'sub'], [0x5a, 'mul'], [0x5b, 'div'], [0x5c, 'div.un'], [0x5d, 'rem'], [0x5e, 'rem.un'], [0x5f, 'and'],
  [0x60, 'or'], [0x61, 'xor'], [0x62, 'shl'], [0x63, 'shr'], [0x64, 'shr.un'], [0x65, 'neg'], [0x66, 'not'], [0x67, 'conv.i1'],
  [0x68, 'conv.i2'], [0x69, 'conv.i4'], [0x6a, 'conv.i8'], [0x6b, 'conv.r4'], [0x6c, 'conv.r8'], [0x6d, 'conv.u4'],
  [0x6e, 'conv.u8'], [0x6f, 'callvirt', 'tok'], [0x70, 'cpobj', 'tok'], [0x71, 'ldobj', 'tok'], [0x72, 'ldstr', 'str'],
  [0x73, 'newobj', 'tok'], [0x74, 'castclass', 'tok'], [0x75, 'isinst', 'tok'], [0x76, 'conv.r.un'], [0x79, 'unbox', 'tok'],
  [0x7a, 'throw'], [0x7b, 'ldfld', 'tok'], [0x7c, 'ldflda', 'tok'], [0x7d, 'stfld', 'tok'], [0x7e, 'ldsfld', 'tok'],
  [0x7f, 'ldsflda', 'tok'], [0x80, 'stsfld', 'tok'], [0x81, 'stobj', 'tok'], [0x82, 'conv.ovf.i1.un'], [0x83, 'conv.ovf.i2.un'],
  [0x84, 'conv.ovf.i4.un'], [0x85, 'conv.ovf.i8.un'], [0x86, 'conv.ovf.u1.un'], [0x87, 'conv.ovf.u2.un'], [0x88, 'conv.ovf.u4.un'],
  [0x89, 'conv.ovf.u8.un'], [0x8a, 'conv.ovf.i.un'], [0x8b, 'conv.ovf.u.un'], [0x8c, 'box', 'tok'], [0x8d, 'newarr', 'tok'],
  [0x8e, 'ldlen'], [0x8f, 'ldelema', 'tok'], [0x90, 'ldelem.i1'], [0x91, 'ldelem.u1'], [0x92, 'ldelem.i2'], [0x93, 'ldelem.u2'],
  [0x94, 'ldelem.i4'], [0x95, 'ldelem.u4'], [0x96, 'ldelem.i8'], [0x97, 'ldelem.i'], [0x98, 'ldelem.r4'], [0x99, 'ldelem.r8'],
  [0x9a, 'ldelem.ref'], [0x9b, 'stelem.i'], [0x9c, 'stelem.i1'], [0x9d, 'stelem.i2'], [0x9e, 'stelem.i4'], [0x9f, 'stelem.i8'],
  [0xa0, 'stelem.r4'], [0xa1, 'stelem.r8'], [0xa2, 'stelem.ref'], [0xa3, 'ldelem', 'tok'], [0xa4, 'stelem', 'tok'],
  [0xa5, 'unbox.any', 'tok'], [0xb3, 'conv.ovf.i1'], [0xb4, 'conv.ovf.u1'], [0xb5, 'conv.ovf.i2'], [0xb6, 'conv.ovf.u2'],
  [0xb7, 'conv.ovf.i4'], [0xb8, 'conv.ovf.u4'], [0xb9, 'conv.ovf.i8'], [0xba, 'conv.ovf.u8'], [0xc2, 'refanyval', 'tok'],
  [0xc3, 'ckfinite'], [0xc6, 'mkrefany', 'tok'], [0xd0, 'ldtoken', 'tok'], [0xd1, 'conv.u2'], [0xd2, 'conv.u1'], [0xd3, 'conv.i'],
  [0xd4, 'conv.ovf.i'], [0xd5, 'conv.ovf.u'], [0xd6, 'add.ovf'], [0xd7, 'add.ovf.un'], [0xd8, 'mul.ovf'], [0xd9, 'mul.ovf.un'],
  [0xda, 'sub.ovf'], [0xdb, 'sub.ovf.un'], [0xdc, 'endfinally'], [0xdd, 'leave', 'br4'], [0xde, 'leave.s', 'br1'],
  [0xdf, 'stind.i'], [0xe0, 'conv.u'],
]);

def(TWO, [
  [0x00, 'arglist'], [0x01, 'ceq'], [0x02, 'cgt'], [0x03, 'cgt.un'], [0x04, 'clt'], [0x05, 'clt.un'], [0x06, 'ldftn', 'tok'],
  [0x07, 'ldvirtftn', 'tok'], [0x09, 'ldarg', 'var2'], [0x0a, 'ldarga', 'var2'], [0x0b, 'starg', 'var2'], [0x0c, 'ldloc', 'var2'],
  [0x0d, 'ldloca', 'var2'], [0x0e, 'stloc', 'var2'], [0x0f, 'localloc'], [0x11, 'endfilter'], [0x12, 'unaligned.', 'i1'],
  [0x13, 'volatile.'], [0x14, 'tail.'], [0x15, 'initobj', 'tok'], [0x16, 'constrained.', 'tok'], [0x17, 'cpblk'], [0x18, 'initblk'],
  [0x19, 'no.', 'i1'], [0x1a, 'rethrow'], [0x1c, 'sizeof', 'tok'], [0x1d, 'refanytype'], [0x1e, 'readonly.'],
]);

export interface Instruction {
  offset: number;
  opcode: string;
  operand: Operand;
  /** Raw operand value (token, constant, branch target(s), local index). */
  value?: number | bigint | number[];
}

export interface MethodBody {
  maxStack: number;
  localsToken: number;
  initLocals: boolean;
  code: Uint8Array;
  clauses: { flags: number; tryStart: number; tryEnd: number; handlerStart: number; handlerEnd: number; classOrFilter: number }[];
}

/** Reads the method body at `rva` (II.25.4). */
export function readBody(md: Metadata, rva: number): MethodBody {
  const b = md.bytes;
  let p = md.rvaToOffset(rva);
  const first = b[p]!;
  if ((first & 3) === 2) {
    const size = first >> 2;
    return { maxStack: 8, localsToken: 0, initLocals: false, code: b.subarray(p + 1, p + 1 + size), clauses: [] };
  }
  if ((first & 3) !== 3) throw new MetadataError('bad method header');
  const flags = md.view.getUint16(p, true);
  const headerSize = (flags >> 12) * 4;
  const maxStack = md.view.getUint16(p + 2, true);
  const codeSize = md.view.getUint32(p + 4, true);
  const localsToken = md.view.getUint32(p + 8, true);
  const code = b.subarray(p + headerSize, p + headerSize + codeSize);
  const clauses: MethodBody['clauses'] = [];
  if (flags & 0x08) {
    p = (p + headerSize + codeSize + 3) & ~3;
    for (;;) {
      const kind = b[p]!;
      const fat = (kind & 0x40) !== 0;
      const dataSize = fat ? b[p + 1]! | (b[p + 2]! << 8) | (b[p + 3]! << 16) : b[p + 1]!;
      if (kind & 0x01) {
        const n = fat ? Math.floor((dataSize - 4) / 24) : Math.floor((dataSize - 4) / 12);
        for (let i = 0; i < n; i++) {
          const c = p + 4 + i * (fat ? 24 : 12);
          const v = md.view;
          clauses.push(
            fat
              ? {
                  flags: v.getUint32(c, true),
                  tryStart: v.getUint32(c + 4, true),
                  tryEnd: v.getUint32(c + 4, true) + v.getUint32(c + 8, true),
                  handlerStart: v.getUint32(c + 12, true),
                  handlerEnd: v.getUint32(c + 12, true) + v.getUint32(c + 16, true),
                  classOrFilter: v.getUint32(c + 20, true),
                }
              : {
                  flags: v.getUint16(c, true),
                  tryStart: v.getUint16(c + 2, true),
                  tryEnd: v.getUint16(c + 2, true) + b[c + 4]!,
                  handlerStart: v.getUint16(c + 5, true),
                  handlerEnd: v.getUint16(c + 5, true) + b[c + 7]!,
                  classOrFilter: v.getUint32(c + 8, true),
                },
          );
        }
      }
      p += dataSize;
      if (!(kind & 0x80)) break;
      p = (p + 3) & ~3;
    }
  }
  return { maxStack, localsToken, initLocals: (flags & 0x10) !== 0, code, clauses };
}

/** Decodes the instruction stream. */
export function decode(code: Uint8Array): Instruction[] {
  const out: Instruction[] = [];
  const v = new DataView(code.buffer, code.byteOffset, code.byteLength);
  let p = 0;
  while (p < code.length) {
    const offset = p;
    let op = code[p++]!;
    let entry: [string, Operand] | undefined;
    if (op === 0xfe) {
      op = code[p++]!;
      entry = TWO[op];
    } else entry = ONE[op];
    if (!entry) {
      out.push({ offset, opcode: `.byte 0x${op.toString(16)}`, operand: 'none' });
      continue;
    }
    const [name, operand] = entry;
    const ins: Instruction = { offset, opcode: name, operand };
    switch (operand) {
      case 'i1':
        ins.value = v.getInt8(p);
        p += 1;
        break;
      case 'var1':
        ins.value = v.getUint8(p);
        p += 1;
        break;
      case 'br1':
        ins.value = p + 1 + v.getInt8(p);
        p += 1;
        break;
      case 'var2':
        ins.value = v.getUint16(p, true);
        p += 2;
        break;
      case 'i4':
      case 'tok':
      case 'str':
      case 'sig':
        ins.value = operand === 'i4' ? v.getInt32(p, true) : v.getUint32(p, true);
        p += 4;
        break;
      case 'br4':
        ins.value = p + 4 + v.getInt32(p, true);
        p += 4;
        break;
      case 'r4':
        ins.value = v.getFloat32(p, true);
        p += 4;
        break;
      case 'i8':
        ins.value = v.getBigInt64(p, true);
        p += 8;
        break;
      case 'r8':
        ins.value = v.getFloat64(p, true);
        p += 8;
        break;
      case 'switch': {
        const n = v.getUint32(p, true);
        p += 4;
        const base = p + n * 4;
        const targets: number[] = [];
        for (let i = 0; i < n; i++) targets.push(base + v.getInt32(p + i * 4, true));
        p += n * 4;
        ins.value = targets;
        break;
      }
      default:
        break;
    }
    out.push(ins);
  }
  return out;
}

const label = (n: number): string => `IL_${n.toString(16).padStart(4, '0')}`;

export function methodOwner(md: Metadata, row: number): number {
  return listOwner(md, 'methodList', row);
}

export class Disassembler {
  constructor(
    private readonly md: Metadata,
    private readonly names: Names,
  ) {}

  private methodScope(methodRow: number): GenericScope {
    const owner = methodOwner(this.md, methodRow);
    return {
      type: owner ? this.names.genericParamsOf(T.TypeDef, owner) : [],
      method: this.names.genericParamsOf(T.MethodDef, methodRow),
    };
  }

  /** "int32 Ns.Type::Name(string)" style text for a method/field/type token. */
  tokenText(tok: number, scope: GenericScope): string {
    const table = tok >>> 24;
    const row = tok & 0xffffff;
    const md = this.md;
    try {
      switch (table) {
        case T.TypeDef:
        case T.TypeRef:
        case T.TypeSpec:
          return this.names.typeName({ table, row }, scope);
        case T.Field: {
          const f = md.row(T.Field, row);
          const owner = this.fieldOwner(row);
          const type = decodeFieldSig(md.blob(num(f, 'signature')), this.names, scope);
          return `${type} ${owner ? this.names.typeName({ table: T.TypeDef, row: owner }) + '::' : ''}${md.strings(num(f, 'name'))}`;
        }
        case T.MethodDef: {
          const m = md.row(T.MethodDef, row);
          const owner = methodOwner(md, row);
          const s = decodeMethodSig(md.blob(num(m, 'signature')), this.names, this.methodScope(row));
          return `${s.hasThis ? 'instance ' : ''}${s.ret} ${owner ? this.names.typeName({ table: T.TypeDef, row: owner }) + '::' : ''}${md.strings(num(m, 'name'))}(${s.params.join(', ')})`;
        }
        case T.MemberRef: {
          const m = md.row(T.MemberRef, row);
          const parent = coded(m, 'class');
          const owner = this.parentText(parent, scope);
          const sig = md.blob(num(m, 'signature'));
          const name = md.strings(num(m, 'name'));
          // Generic placeholders in a MemberRef signature belong to the referenced
          // member's type/method, not ours: print them as IL does (!0, !!0).
          const own: GenericScope = { type: [], method: [] };
          if (sig[0] === 0x06) return `${decodeFieldSig(sig, this.names, own)} ${owner}::${name}`;
          const s = decodeMethodSig(sig, this.names, own);
          return `${s.hasThis ? 'instance ' : ''}${s.ret} ${owner}::${name}(${s.params.join(', ')})`;
        }
        case T.MethodSpec: {
          const ms = md.row(T.MethodSpec, row);
          const method = coded(ms, 'method');
          const r = new SigReader(md.blob(num(ms, 'instantiation')), this.names);
          r.u8(); // GENERICINST
          const n = r.uint();
          const args: string[] = [];
          for (let i = 0; i < n; i++) args.push(r.type(scope));
          const base = this.tokenText(((method.table << 24) | method.row) >>> 0, scope);
          // Put the type arguments after the method name: "...::Name<int>(args)".
          const paren = base.lastIndexOf('(');
          return paren > 0 ? `${base.slice(0, paren)}<${args.join(', ')}>${base.slice(paren)}` : base;
        }
        case T.StandAloneSig:
          return `sig 0x${tok.toString(16)}`;
        case 0x70:
          return JSON.stringify(md.userString(row));
        default:
          return `0x${tok.toString(16).padStart(8, '0')}`;
      }
    } catch {
      return `0x${tok.toString(16).padStart(8, '0')}`;
    }
  }

  private parentText(parent: CodedRef, scope: GenericScope): string {
    if (parent.table === T.MethodDef) return this.names.typeName({ table: T.TypeDef, row: methodOwner(this.md, parent.row) });
    if (parent.table === T.ModuleRef) return this.md.strings(num(this.md.row(T.ModuleRef, parent.row), 'name'));
    return this.names.typeName(parent, scope);
  }

  private fieldOwner(row: number): number {
    return listOwner(this.md, 'fieldList', row);
  }

  /** Full listing of one MethodDef (by row). */
  method(row: number): string {
    const md = this.md;
    const m = md.row(T.MethodDef, row);
    if (!m) throw new MetadataError(`No method with token 0x${(0x06000000 | row).toString(16)}.`);
    const scope = this.methodScope(row);
    const name = md.strings(num(m, 'name'));
    const owner = methodOwner(md, row);
    const sig = decodeMethodSig(md.blob(num(m, 'signature')), this.names, scope);
    const lines: string[] = [];
    const typeName = owner ? this.names.typeName({ table: T.TypeDef, row: owner }) : '';
    const generic = scope.method.length ? `<${scope.method.join(', ')}>` : '';
    lines.push(`// ${typeName}::${name}${generic}(${sig.params.join(', ')}) : ${sig.ret}`);
    lines.push(`// token 0x${(0x06000000 | row).toString(16).padStart(8, '0')}`);
    const rva = num(m, 'rva');
    if (!rva) {
      lines.push('// (no body: abstract, extern or runtime-implemented)');
      return lines.join('\n') + '\n';
    }
    const body = readBody(md, rva);
    lines.push('{');
    lines.push(`  .maxstack ${body.maxStack}`);
    if (body.localsToken) {
      try {
        const ls = md.row(T.StandAloneSig, body.localsToken & 0xffffff);
        const locals = decodeLocals(md.blob(num(ls, 'signature')), this.names, scope);
        if (locals.length) {
          lines.push(`  .locals${body.initLocals ? ' init' : ''} (`);
          locals.forEach((l, i) => lines.push(`    [${i}] ${l}${i < locals.length - 1 ? ',' : ''}`));
          lines.push('  )');
        }
      } catch {
        lines.push(`  // locals: signature 0x${body.localsToken.toString(16)}`);
      }
    }
    lines.push('');
    const ins = decode(body.code);
    const tries = new Map<number, string[]>();
    for (const c of body.clauses) {
      const kind = c.flags & 0x0001 ? 'filter' : c.flags & 0x0002 ? 'finally' : c.flags & 0x0004 ? 'fault' : 'catch';
      const what = kind === 'catch' ? ` ${this.tokenText(c.classOrFilter, scope)}` : kind === 'filter' ? ` ${label(c.classOrFilter)}` : '';
      const note = `  // .try ${label(c.tryStart)} to ${label(c.tryEnd)} ${kind}${what} handler ${label(c.handlerStart)} to ${label(c.handlerEnd)}`;
      tries.set(c.tryStart, [...(tries.get(c.tryStart) ?? []), note]);
    }
    for (const i of ins) {
      for (const n of tries.get(i.offset) ?? []) lines.push(n);
      lines.push(`  ${label(i.offset)}: ${i.opcode}${this.operandText(i, scope)}`);
    }
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  private operandText(i: Instruction, scope: GenericScope): string {
    switch (i.operand) {
      case 'none':
        return '';
      case 'br1':
      case 'br4':
        return ` ${label(i.value as number)}`;
      case 'switch':
        return ` (${(i.value as number[]).map(label).join(', ')})`;
      case 'str':
        return ` ${JSON.stringify(this.md.userString((i.value as number) & 0xffffff))}`;
      case 'tok':
        return ` ${this.tokenText(i.value as number, scope)}`;
      case 'sig':
        return ` ${this.tokenText(i.value as number, scope)}`;
      default:
        return ` ${String(i.value)}`;
    }
  }
}

/** ldstr offsets used by each MethodDef row (for "which method uses this string"). */
export function stringUses(md: Metadata): Map<number, number[]> {
  const uses = new Map<number, number[]>();
  const n = md.rows(T.MethodDef);
  for (let row = 1; row <= n; row++) {
    const rva = num(md.row(T.MethodDef, row), 'rva');
    if (!rva) continue;
    let code: Uint8Array;
    try {
      code = readBody(md, rva).code;
    } catch {
      continue;
    }
    for (const ins of decode(code)) {
      if (ins.operand !== 'str') continue;
      const off = (ins.value as number) & 0xffffff;
      const list = uses.get(off) ?? [];
      if (!list.includes(row)) list.push(row);
      uses.set(off, list);
    }
  }
  return uses;
}

export { stripArity };
