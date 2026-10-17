import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MetadataError, readCompressedUInt } from './metadata';
import { ilListing, loadAssembly, searchAssembly } from './model';
import type { AsmType } from '../types';

// QA's synthetic assembly (fixtures-src/SampleCustomization, committed DLLs).
const A = loadAssembly(readFileSync('fixtures/static/Contoso.Extensions.dll'));
const B = loadAssembly(readFileSync('fixtures/static/Contoso.Extensions.B.dll'));
const type = (a: typeof A, name: string): AsmType => {
  const t = a.info.types.find((x) => x.fullName === `Contoso.Extensions.${name}`);
  if (!t) throw new Error(`no type ${name}`);
  return t;
};
const member = (t: AsmType, name: string) => {
  const m = t.members.find((x) => x.name === name);
  if (!m) throw new Error(`no member ${name}`);
  return m;
};

describe('metadata', () => {
  it('reads compressed integers (II.23.2)', () => {
    expect(readCompressedUInt(Uint8Array.of(0x03), 0)).toEqual({ value: 3, size: 1 });
    expect(readCompressedUInt(Uint8Array.of(0x80, 0x80), 0)).toEqual({ value: 0x80, size: 2 });
    expect(readCompressedUInt(Uint8Array.of(0xc0, 0x00, 0x40, 0x00), 0)).toEqual({ value: 0x4000, size: 4 });
  });

  it('rejects non-.NET files with a readable message', () => {
    expect(() => loadAssembly(new Uint8Array(300))).toThrow(/Not a .NET assembly/);
    const mz = new Uint8Array(300);
    mz[0] = 0x4d;
    mz[1] = 0x5a;
    expect(() => loadAssembly(mz)).toThrow(MetadataError);
  });
});

describe('assembly info', () => {
  it('has name, version, target framework, references and strings', () => {
    expect(A.info.name).toBe('Contoso.Extensions');
    expect(A.info.version).toBe('1.0.0.0');
    expect(A.info.targetFramework).toBe('.NETStandard,Version=v2.0');
    expect(A.info.references.map((r) => r.name)).toContain('netstandard');
    expect(A.info.stringCount).toBeGreaterThan(0);
  });

  it('badges Acumatica roles from the base type chain and sets extends', () => {
    const roles = Object.fromEntries(
      A.info.types.filter((t) => t.namespace === 'Contoso.Extensions').map((t) => [t.name, [t.acumatica, t.extends]]),
    );
    expect(roles).toEqual({
      ContosoRoute: ['dac', undefined],
      ContosoRouteExt: ['dacExtension', 'ContosoRoute'],
      ContosoRouteMaint: ['graph', undefined],
      ContosoRouteMaintExt: ['graphExtension', 'ContosoRouteMaint'],
      RouteCodeAttribute: ['attribute', undefined],
    });
    // The framework types themselves (stubs compiled into this DLL) get no badge.
    for (const n of ['PX.Data.PXGraph`1', 'PX.Data.PXGraphExtension`1', 'PX.Data.PXCacheExtension`1', 'PX.Data.IBqlTable']) {
      expect(A.info.types.find((t) => t.fullName === n)?.acumatica).toBeUndefined();
    }
  });

  it('decodes kinds, base types, generic names and visibility', () => {
    expect(type(A, 'ContosoRouteMaint').baseType).toBe('PXGraph<ContosoRouteMaint>');
    expect(type(A, 'ContosoRouteExt').baseType).toBe('PXCacheExtension<ContosoRoute>');
    expect(type(A, 'ContosoRoute').interfaces).toEqual(['IBqlTable']);
    expect(A.info.types.find((t) => t.fullName === 'PX.Data.IBqlTable')?.kind).toBe('interface');
    expect(A.info.types.find((t) => t.fullName === 'PX.Data.PXGraph`1')?.name).toBe('PXGraph<TGraph>');
    expect(type(A, 'ContosoRoute').visibility).toBe('public');
  });

  it('member signatures read like C#', () => {
    const dac = type(A, 'ContosoRoute');
    expect(member(dac, 'MaxWeight').signature).toBe('public virtual decimal? MaxWeight { get; set; }');
    const graph = type(A, 'ContosoRouteMaint');
    expect(member(graph, 'AuditMessage').signature).toBe('public const string AuditMessage = "CONTOSO-ROUTE-AUDIT-7731"');
    expect(member(graph, 'Persist').signature).toBe('public override void Persist()');
    expect(member(graph, 'TotalWeight').signature).toBe('public decimal TotalWeight(string mode)');
    expect(member(graph, 'Routes').signature).toBe('public List<ContosoRoute> Routes { get; }');
    expect(member(graph, '.ctor').kind).toBe('ctor');
    // Accessors and compiler-generated backing fields are not listed separately.
    expect(graph.members.some((m) => m.name.startsWith('get_') || m.name.startsWith('<'))).toBe(false);
  });

  it('decodes attribute arguments, including PXUIField DisplayName and PXCacheName', () => {
    const dac = type(A, 'ContosoRoute');
    expect(dac.attributes).toEqual(['PXCacheName("Contoso Route")']);
    expect(member(dac, 'RouteCode').attributes).toEqual(['PXDBString(15, IsUnicode = true)', 'PXUIField(DisplayName = "Route Code")']);
    expect(member(type(B, 'ContosoRoute'), 'Description').attributes).toContain('PXUIField(DisplayName = "Route Description")');
  });

  it('variant B has the extra method', () => {
    expect(type(A, 'ContosoRouteMaintExt').members.some((m) => m.name === 'HasRoute')).toBe(false);
    expect(member(type(B, 'ContosoRouteMaintExt'), 'HasRoute').signature).toBe('public bool HasRoute(string code)');
  });
});

describe('search', () => {
  it('finds string literals with the method that uses them', () => {
    const hits = searchAssembly(A, 'route-audit');
    const str = hits.find((h) => h.kind === 'string');
    expect(str).toMatchObject({ typeFullName: 'Contoso.Extensions.ContosoRouteMaint', memberName: 'Persist' });
    expect((str?.token ?? 0) >>> 24).toBe(0x06);
    expect(hits.some((h) => h.kind === 'member' && h.memberName === 'AuditMessage')).toBe(true);
  });

  it('finds types, members and attributes; options apply', () => {
    expect(searchAssembly(A, 'ContosoRouteExt').some((h) => h.kind === 'type')).toBe(true);
    expect(searchAssembly(A, 'Carrier Account').some((h) => h.kind === 'member' && h.memberName === 'UsrCarrierAccount')).toBe(true);
    expect(searchAssembly(A, 'route-audit', { caseSensitive: true })).toHaveLength(0);
    expect(searchAssembly(A, 'Weight\\(string', { regex: true }).some((h) => h.memberName === 'TotalWeight')).toBe(true);
    expect(searchAssembly(A, 'e', { limit: 3 })).toHaveLength(3);
    expect(searchAssembly(A, '')).toEqual([]);
  });
});

describe('IL', () => {
  it('disassembles a method with locals, branches, strings and a try/finally', () => {
    const il = ilListing(A, member(type(A, 'ContosoRouteMaint'), 'TotalWeight').token);
    expect(il).toContain('.locals init (');
    expect(il).toContain('ldstr "max"');
    expect(il).toMatch(/IL_[0-9a-f]{4}: brtrue\.s IL_[0-9a-f]{4}/);
    expect(il).toContain('call instance List<ContosoRoute> ContosoRouteMaint::get_Routes()');
    expect(il).toMatch(/\.try IL_\w+ to IL_\w+ finally handler/);
    expect(il).toContain('newobj instance void PXException::.ctor(string)');
    expect(il.trimEnd().endsWith('}')).toBe(true);
  });

  it('rejects non-method tokens', () => {
    expect(() => ilListing(A, type(A, 'ContosoRoute').token)).toThrow(/methods only/);
  });
});
