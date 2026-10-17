// Dev-only fakes for Phase 5: a PackageReader that serves a synthetic package,
// and an AssemblyBrowser with made-up metadata. The real ones live in
// src/package/ (Languages) and src/assembly/ (Editor). Nothing here reads
// real customer packages.
import type {
  AsmMember,
  AsmSearchHit,
  AsmType,
  AssemblyBrowser,
  AssemblyInfo,
  FileKind,
  PackageEntry,
  PackageReader,
  PackageSource,
  SearchOptions,
} from '../../types';
import { genProject } from './fake-project';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Marker inside a fake .zip blob so the harness can "drop" a package without a real zip. */
export const FAKE_ZIP_MARKER = 'SIDEDIFF-FAKE-PACKAGE:';

function kindOf(path: string): FileKind {
  if (/\.(dll|exe)$/i.test(path)) return 'assembly';
  if (/\.(png|jpe?g|gif|svg|ico|bmp|webp)$/i.test(path)) return 'image';
  if (/\.(cs|aspx|ascx|ts|js|html?|css|scss|xml|config|json|txt|esc|rpx|sql|resx|md)$/i.test(path)) return 'text';
  return 'binary';
}

/** A small real PNG drawn at runtime, so the image preview decodes something genuine. */
async function makePng(variant: 'a' | 'b'): Promise<Uint8Array> {
  const c = new OffscreenCanvas(96, 64);
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#1f6feb';
    g.fillRect(0, 0, 96, 64);
    g.fillStyle = variant === 'a' ? '#f2cc60' : '#7ee787';
    g.beginPath();
    g.arc(48, 32, 22, 0, Math.PI * 2);
    g.fill();
  }
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

function fakeDll(variant: 'a' | 'b'): Uint8Array {
  const out = new Uint8Array(4096);
  out[0] = 0x4d; // M
  out[1] = 0x5a; // Z
  out[2] = variant === 'a' ? 1 : 2;
  for (let i = 3; i < out.length; i++) out[i] = (i * 31 + (variant === 'a' ? 7 : 11)) & 0xff;
  return out;
}

/** A synthetic package: project.xml from genProject plus files at their AppRelativePath and a few extras. */
export function genPackage(variant: 'a' | 'b', n = 120): PackageSource {
  const pair = genProject(n, 11);
  const extra = [
    '  <Page path="~/pages/so/so301000.aspx" ScreenTitle="Sales Orders">',
    '    <PXField DataMember="Document" DataField="UsrCarrier" CommitChanges="True" />',
    `    <PXField DataMember="Document" DataField="UsrRoute" CommitChanges="${variant === 'a' ? 'False' : 'True'}" />`,
    '    <PXField DataMember="Transactions" DataField="UsrZone" CommitChanges="False" />',
    '  </Page>',
    '  <SiteMapNode ScreenID="SO301000" Title="Sales Orders" Url="~/pages/so/so301000.aspx" />',
    '  <ScreenWithRights ScreenID="SO301000">',
    '    <row RoleName="Administrator" Rights="Delete" />',
    `    <row RoleName="SalesClerk" Rights="${variant === 'a' ? 'Edit' : 'View'}" />`,
    ...(variant === 'b' ? ['    <row RoleName="Warehouse" Rights="View" />'] : []),
    '  </ScreenWithRights>',
  ].join('\n');
  const projectXml = (variant === 'a' ? pair.a : pair.b).replace('</Customization>', `${extra}\n</Customization>`);
  const files = new Map<string, Uint8Array>();
  // Files the project references (App_Code/*.cs) get real content in the zip; one is left out (a warning).
  const refs = [...projectXml.matchAll(/AppRelativePath="([^"]+)"/g)].map((m) => (m[1] ?? '').replace(/\\/g, '/'));
  refs.forEach((path, i) => {
    if (i === 0) return; // missing from the zip
    const cls = path.split('/').pop()?.replace(/\.\w+$/, '') ?? 'X';
    const body = path.endsWith('.cs')
      ? `using PX.Data;\n\nnamespace Fake.Package\n{\n    public class ${cls} : PXCacheExtension<SOOrder>\n    {\n        [PXDBString(30)]\n        [PXUIField(DisplayName = "${variant === 'b' && i % 3 === 0 ? 'Carrier code' : 'Carrier'}")]\n        public virtual string UsrCarrier { get; set; }\n    }\n}\n`
      : `// ${path}\nconsole.log("${cls}");\n`;
    files.set(path, enc.encode(body));
  });
  files.set('Bin/Fake.Customization.dll', fakeDll(variant));
  files.set('Images/logo.png', new Uint8Array(0)); // drawn on first read
  files.set('App_Data/SnapshotConfigs/demo.esc', enc.encode(`<SnapshotConfig name="demo">\n  <Table name="SOOrder" />\n  <Table name="${variant === 'a' ? 'SOLine' : 'SOLineSplit'}" />\n</SnapshotConfig>\n`));
  files.set('Bin/license.dat', Uint8Array.from({ length: 700 }, (_, i) => (i * 7 + (variant === 'a' ? 0 : 1)) & 0xff));
  if (variant === 'b') files.set('screens/SO/SO301000/SO301000.ts', enc.encode('export class SO301000 extends PXScreen {}\n'));
  const entries: PackageEntry[] = [...files.entries()].map(([path, bytes]) => ({ path, size: bytes.length || 1400, compressedSize: Math.ceil((bytes.length || 1400) * 0.6), kind: kindOf(path) }));
  return {
    name: `Fake.Customization.${variant === 'a' ? '24R2' : '25R1'}.zip`,
    kind: 'zip',
    bytes: entries.reduce((s, e) => s + e.compressedSize, 0) + projectXml.length,
    projectXml,
    entries,
    async read(path) {
      const b = files.get(path);
      if (!b) throw new Error(`${path} is not in the package`);
      if (path === 'Images/logo.png' && b.length === 0) {
        const png = await makePng(variant);
        files.set(path, png);
        return png;
      }
      return b;
    },
    async readText(path) {
      return dec.decode(await this.read(path));
    },
  };
}

/** Builds a Blob the fake reader recognises as package `variant`. */
export function fakeZipBlob(variant: 'a' | 'b'): Blob {
  return new Blob([`${FAKE_ZIP_MARKER}${variant}`], { type: 'application/zip' });
}

export function createFakePackageReader(): PackageReader & { opened: string[] } {
  const reader = {
    opened: [] as string[],
    async open(file: Blob, name: string): Promise<PackageSource> {
      reader.opened.push(name);
      if (/\.zip$/i.test(name)) {
        const head = await file.slice(0, 64).text();
        if (!head.startsWith(FAKE_ZIP_MARKER)) throw new Error(`${name}: the dev fake only opens its own synthetic packages`);
        return genPackage(head.endsWith('b') ? 'b' : 'a');
      }
      const text = await file.text();
      return {
        name, kind: 'xml', bytes: file.size, projectXml: text, entries: [],
        async read() { throw new Error('a bare project.xml has no files'); },
        async readText() { throw new Error('a bare project.xml has no files'); },
      };
    },
  };
  return reader;
}

// ---------- assemblies ----------

function member(kind: AsmMember['kind'], name: string, signature: string, token: number, attributes: string[] = []): AsmMember {
  return { kind, name, signature, attributes, token };
}

function typesFor(variant: number): AsmType[] {
  let tok = 0x06000001;
  const t = (fullName: string, rest: Partial<AsmType>): AsmType => {
    const i = fullName.lastIndexOf('.');
    return { fullName, namespace: fullName.slice(0, i), name: fullName.slice(i + 1), kind: 'class', visibility: 'public', interfaces: [], attributes: [], members: [], token: 0x02000000 + (tok++ & 0xff), ...rest };
  };
  const types: AsmType[] = [
    t('Fake.Customization.SOOrderEntryExt', {
      baseType: 'PXGraphExtension<SOOrderEntry>', acumatica: 'graphExtension', extends: 'SOOrderEntry', attributes: ['PXProtectedAccess'],
      members: [
        member('method', 'IsActive', 'public static bool IsActive()', tok++),
        member('field', 'assignCarrier', 'public PXAction<SOOrder> assignCarrier', tok++),
        member('method', 'AssignCarrier', 'public virtual IEnumerable AssignCarrier(PXAdapter adapter)', tok++, ['PXButton', 'PXUIField(DisplayName = "Assign Carrier")']),
        member('method', 'Persist', variant === 1 ? 'public virtual void Persist(PersistDelegate baseMethod)' : 'public virtual void Persist(PersistDelegate baseMethod, bool validate)', tok++, ['PXOverride']),
      ],
    }),
    t('Fake.Customization.SOOrderExt', {
      baseType: 'PXCacheExtension<SOOrder>', acumatica: 'dacExtension', extends: 'SOOrder',
      members: [
        member('property', 'UsrCarrier', 'public virtual string UsrCarrier { get; set; }', tok++, ['PXDBString(30)', 'PXUIField(DisplayName = "Carrier")']),
        member('property', 'UsrRoute', 'public virtual int? UsrRoute { get; set; }', tok++, ['PXDBInt']),
      ],
    }),
    t('Fake.Customization.CarrierMaint', {
      baseType: 'PXGraph<CarrierMaint, FakeCarrier>', acumatica: 'graph',
      members: [member('field', 'Carriers', 'public SelectFrom<FakeCarrier>.View Carriers', tok++), member('ctor', '.ctor', 'public CarrierMaint()', tok++)],
    }),
    t('Fake.Customization.FakeCarrier', {
      baseType: 'PXBqlTable', interfaces: ['IBqlTable'], acumatica: 'dac', attributes: ['PXCacheName("Carrier")', 'Serializable'],
      members: [member('property', 'CarrierID', 'public virtual string CarrierID { get; set; }', tok++, ['PXDBString(15, IsKey = true)'])],
    }),
    t('Fake.Customization.Helpers.RouteCalculator', {
      baseType: 'object', visibility: 'internal',
      members: [member('method', 'Calculate', 'internal static int Calculate(string zip)', tok++)],
    }),
    t('Fake.Customization.Attributes.CarrierSelectorAttribute', {
      baseType: 'PXSelectorAttribute', acumatica: 'attribute',
      members: [member('ctor', '.ctor', 'public CarrierSelectorAttribute()', tok++)],
    }),
  ];
  if (variant === 2) types.push(t('Fake.Customization.Helpers.ZoneLookup', { baseType: 'object', members: [member('method', 'Find', 'public static string Find(int route)', tok++)] }));
  return types;
}

export function createFakeAssemblyBrowser(opts: { loadDelayMs?: number; allDelayMs?: number } = {}): AssemblyBrowser & { decompileCalls: number } {
  const loaded = new Map<string, AssemblyInfo>();
  let ready = false;
  const strings = ['Carrier is required.', 'Route {0} not found', 'SO301000', 'Assign Carrier'];
  const browser = {
    decompileCalls: 0,
    async load(key: string, bytes: Uint8Array): Promise<AssemblyInfo> {
      await new Promise((r) => setTimeout(r, 60));
      if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`${key} is not a .NET assembly`);
      const variant = bytes[2] === 2 ? 2 : 1;
      const info: AssemblyInfo = {
        name: 'Fake.Customization', version: variant === 1 ? '1.4.0.0' : '1.5.0.0', targetFramework: '.NETFramework,Version=v4.8',
        references: [{ name: 'PX.Data', version: '1.0.0.0' }, { name: 'PX.Objects', version: '1.0.0.0' }, { name: 'mscorlib', version: '4.0.0.0' }],
        types: typesFor(variant), stringCount: strings.length,
      };
      loaded.set(key, info);
      return info;
    },
    async search(key: string, query: string, options: SearchOptions = {}): Promise<AsmSearchHit[]> {
      const info = loaded.get(key);
      if (!info || !query) return [];
      const re = options.regex ? new RegExp(query, options.caseSensitive ? '' : 'i') : null;
      const hit = (s: string): boolean => (re ? re.test(s) : options.caseSensitive ? s.includes(query) : s.toLowerCase().includes(query.toLowerCase()));
      const out: AsmSearchHit[] = [];
      for (const t of info.types) {
        if (hit(t.fullName)) out.push({ kind: 'type', typeFullName: t.fullName, preview: t.fullName });
        for (const m of t.members) if (hit(m.signature) || m.attributes.some(hit)) out.push({ kind: 'member', typeFullName: t.fullName, memberName: m.name, token: m.token, preview: m.signature });
      }
      strings.filter(hit).forEach((s) => out.push({ kind: 'string', typeFullName: 'Fake.Customization.SOOrderEntryExt', memberName: 'AssignCarrier', preview: `"${s}"` }));
      return out.slice(0, options.limit ?? 500);
    },
    async decompile(key: string, typeFullName: string | null): Promise<string> {
      browser.decompileCalls++;
      if (!ready) {
        await new Promise((r) => setTimeout(r, opts.loadDelayMs ?? 1200));
        ready = true;
      }
      // Whole assemblies are slow for real (a 793-type DLL took ~17 s): simulate a few seconds.
      if (typeFullName === null) await new Promise((r) => setTimeout(r, opts.allDelayMs ?? 3500));
      const info = loaded.get(key);
      if (!info) throw new Error(`${key} is not loaded`);
      const types = typeFullName ? info.types.filter((t) => t.fullName === typeFullName) : info.types;
      return types.map((t) => [
        `namespace ${t.namespace}`, '{',
        ...t.attributes.map((a) => `    [${a}]`),
        `    ${t.visibility === 'internal' ? 'internal' : 'public'} class ${t.name}${t.baseType && t.baseType !== 'object' ? ` : ${t.baseType}` : ''}`, '    {',
        ...t.members.flatMap((m) => [...m.attributes.map((a) => `        [${a}]`), `        ${m.signature}${m.kind === 'method' || m.kind === 'ctor' ? '\n        {\n            // decompiled body (fake)\n        }' : m.kind === 'field' ? ';' : ''}`, '']),
        '    }', '}', '',
      ].join('\n')).join('\n');
    },
    async il(key: string, methodToken: number): Promise<string> {
      const info = loaded.get(key);
      const m = info?.types.flatMap((t) => t.members.map((mm) => ({ t, mm }))).find((x) => x.mm.token === methodToken);
      if (!m) throw new Error(`no method 0x${methodToken.toString(16)}`);
      return [`// ${m.t.fullName}::${m.mm.name}`, `// token 0x${methodToken.toString(16).padStart(8, '0')}`, '.maxstack 8', 'IL_0000: nop', 'IL_0001: ldarg.0', `IL_0002: call instance void ${m.t.baseType ?? 'object'}::.ctor()`, 'IL_0007: ldstr "Carrier is required."', 'IL_000c: pop', 'IL_000d: ret'].join('\n');
    },
    decompilerReady: () => ready,
    dispose(): void {
      loaded.clear();
    },
  };
  return browser;
}
