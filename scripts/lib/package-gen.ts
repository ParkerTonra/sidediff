// Deterministic customization package pair (Phase 5): package-a.zip and
// package-b.zip, each project.xml (the `project` fixture) plus files at their
// AppRelativePath with "/" separators, like a real export. Synthetic only.
//
// Expected items = the project items, with File/PerTenantFile items that have
// zip content now compared by content, plus `Zip:<path>` items for files
// project.xml doesn't reference. Pure: the static bytes (DLLs, JPEG) are
// passed in.

import { createRng } from './rng.ts';
import { generateProjectPair, GROUP_ORDER, RELATED_SCREEN, withSummary } from './project-gen.ts';
import type { ExpectedItem } from './project-gen.ts';
import { png, writeZip } from './zip.ts';
import type { ZipInput } from './zip.ts';
import type { ItemStatus, ProjectGroup, Side } from '../../src/types.ts';

export const PACKAGE_SEED = 0x5d1f_0200;
const EOL = '\r\n';

export interface PackageStatics {
  dllA: Uint8Array;
  dllB: Uint8Array;
  jpg: Uint8Array;
}

export interface ExpectedOverview {
  name: string;
  kind: 'zip';
  bytes: number;
  attributes: Record<string, string>;
  counts: Partial<Record<ProjectGroup, number>>;
  /** Screens the overview must list (from pages and the site map), at least these. */
  screensInclude: string[];
  assemblies: { path: string; size: number }[];
  /** Each must appear in some warning (missing referenced files). */
  warningsInclude: string[];
}

export interface SearchExpectation {
  query: string;
  /** Where the hit must be (at least this one). */
  itemId: string;
  side: Side;
  /** 1-based line in that item's text view, when it is a zip text file. */
  line?: number;
  what: string;
}

/** A package item: the project item shape plus which sides hold it (zip items have no project.xml lines). */
export type PackageItem = ExpectedItem & { sides: Side[] };

export interface PackagePair {
  zips: Record<Side, Buffer>;
  entries: Record<Side, { path: string; size: number }[]>;
  items: PackageItem[];
  counts: { total: number; byStatus: Record<ItemStatus, number>; byGroup: Partial<Record<ProjectGroup, number>> };
  overview: Record<Side, ExpectedOverview>;
  searches: SearchExpectation[];
  edits: Record<string, string[]>;
}

const text = (lines: string[]): Uint8Array => Buffer.from(lines.join(EOL) + EOL, 'utf8');

function aspx(variant: Side): string[] {
  const fields = ['UsrRouteCode', 'UsrCarrierAccount', 'UsrMaxWeight', ...(variant === 'b' ? ['UsrRushOrder'] : [])];
  return [
    `<%@ Page Language="C#" MasterPageFile="~/MasterPages/FormDetail.master" AutoEventWireup="true" ValidateRequest="false" CodeFile="${RELATED_SCREEN}.aspx.cs" Inherits="Page_${RELATED_SCREEN}" Title="Untitled Page" %>`,
    '<%@ MasterType VirtualPath="~/MasterPages/FormDetail.master" %>',
    '<asp:Content ID="cont1" ContentPlaceHolderID="phDS" runat="Server">',
    '    <px:PXDataSource ID="ds" runat="server" Visible="True" Width="100%" TypeName="PX.Objects.SO.SOOrderEntry" PrimaryView="Document">',
    '    </px:PXDataSource>',
    '</asp:Content>',
    '<asp:Content ID="cont2" ContentPlaceHolderID="phF" runat="Server">',
    '    <px:PXFormView ID="form" runat="server" DataSourceID="ds" Width="100%" DataMember="Document">',
    '        <Template>',
    ...fields.map((f) => `            <px:PXTextEdit ID="ed${f}" runat="server" DataField="${f}" CommitChanges="True" />`),
    '        </Template>',
    '    </px:PXFormView>',
    '</asp:Content>',
  ];
}

const codeBehind = [
  'using System;',
  'using PX.Web.UI;',
  '',
  `public partial class Page_${RELATED_SCREEN} : PX.Web.UI.PXPage`,
  '{',
  '    protected void Page_Load(object sender, EventArgs e)',
  '    {',
  '        // CONTOSO-PAGE-MARKER-5520',
  '    }',
  '}',
];

function modernTs(screen: string, variant: Side): string[] {
  const fields = ['UsrRouteCode', 'UsrCarrierAccount', ...(variant === 'b' ? ['UsrRushOrder'] : [])];
  return [
    'import { PXFieldState, PXFieldOptions, viewInfo } from "client-controls";',
    `import { ${screen}, Document } from "src/screens/${screen.slice(0, 2)}/${screen}/${screen}";`,
    '',
    `export interface ${screen}_Contoso extends ${screen} {}`,
    `export class ${screen}_Contoso {`,
    '    @viewInfo({ containerName: "Document" })',
    '    Document = createSingle(Document);',
    '}',
    '',
    'export interface Document_Contoso extends Document {}',
    'export class Document_Contoso {',
    ...fields.map((f) => `    ${f}: PXFieldState<PXFieldOptions.CommitChanges>;`),
    '}',
  ];
}

const modernHtml = [
  '<template>',
  '    <field after="#form-Document [name=\'CustomerID\']" name="UsrRouteCode"></field>',
  '    <field after="#form-Document [name=\'UsrRouteCode\']" name="UsrCarrierAccount"></field>',
  '</template>',
];

const snapshotConfig = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<SnapshotConfig Name="Contoso Routes" Version="1" Description="CONTOSO-SNAPSHOT-ZONE tables">',
  '    <Table Name="SOOrder" Filter="UsrRouteCode IS NOT NULL" />',
  '    <Table Name="ContosoRoute" />',
  '</SnapshotConfig>',
];

const releaseNotes = [
  'Contoso customization release notes',
  '',
  '1.0.0  Route codes on sales orders.',
  '1.0.1  Carrier account on routes. CONTOSO-RELEASE-NOTE-0042',
];

function zipInputs(side: Side, project: string, statics: PackageStatics): ZipInput[] {
  const rng = createRng(PACKAGE_SEED);
  const blob = Buffer.alloc(2048);
  for (let i = 0; i < blob.length; i++) blob[i] = rng.int(0, 255);
  const logo = png(32, 32, (x, y) => [(x * 8) & 255, (y * 8) & 255, 160]);
  const files: ZipInput[] = [
    { path: 'project.xml', data: Buffer.from(project, 'utf8') },
    { path: `Pages/SO/${RELATED_SCREEN}.aspx`, data: text(aspx(side)) },
    { path: `Pages/SO/${RELATED_SCREEN}.aspx.cs`, data: text(codeBehind) },
    // Pages/PO/PO302000.aspx is referenced by project.xml but missing: a warning.
    { path: `screens/SO/${RELATED_SCREEN}/${RELATED_SCREEN}.ts`, data: text(modernTs(RELATED_SCREEN, side)) },
    { path: `screens/SO/${RELATED_SCREEN}/${RELATED_SCREEN}.html`, data: text(modernHtml) },
    ...(side === 'a' ? [{ path: 'screens/PO/PO302000/PO302000.ts', data: text(modernTs('PO302000', 'a')) }] : []),
    { path: 'Bin/Contoso.Extensions.dll', data: side === 'a' ? statics.dllA : statics.dllB },
    { path: 'Images/contoso-logo.png', data: logo },
    ...(side === 'a' ? [{ path: 'Images/contoso-banner.jpg', data: statics.jpg }] : []),
    { path: 'App_Data/SnapshotConfigs/ContosoRoutes.esc', data: text(snapshotConfig) },
    // Unreferenced extras: one text, one binary.
    { path: 'Docs/release-notes.txt', data: text(releaseNotes) },
    { path: 'Data/routes.bin', data: blob, store: true },
  ];
  return files;
}

const sameBytes = (x: Uint8Array, y: Uint8Array): boolean => Buffer.compare(Buffer.from(x), Buffer.from(y)) === 0;

/** Same bytes → same; text that differs only in leading/trailing whitespace per line → whitespace; else modified. */
function fileStatus(kind: string, a: Uint8Array, b: Uint8Array): ItemStatus {
  if (sameBytes(a, b)) return 'same';
  if (kind !== 'code') return 'modified';
  const la = Buffer.from(a).toString('utf8').split(/\r?\n/);
  const lb = Buffer.from(b).toString('utf8').split(/\r?\n/);
  return la.length === lb.length && la.every((l, i) => l.trim() === (lb[i] ?? '').trim()) ? 'whitespace' : 'modified';
}

export function generatePackagePair(statics: PackageStatics): PackagePair {
  const proj = generateProjectPair();
  const inputs: Record<Side, ZipInput[]> = { a: zipInputs('a', proj.a, statics), b: zipInputs('b', proj.b, statics) };
  const zips: Record<Side, Buffer> = { a: writeZip(inputs.a), b: writeZip(inputs.b) };
  const byPath = (side: Side): Map<string, ZipInput> => new Map(inputs[side].map((e) => [e.path.toLowerCase(), e]));
  const za = byPath('a');
  const zb = byPath('b');

  const kindOf = (path: string): 'code' | 'image' | 'assembly' | 'binary' => {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp'].includes(ext)) return 'image';
    if (['dll', 'exe'].includes(ext)) return 'assembly';
    if (['cs', 'aspx', 'ascx', 'ts', 'js', 'html', 'htm', 'css', 'scss', 'xml', 'config', 'json', 'txt', 'esc', 'rpx', 'sql', 'resx', 'md'].includes(ext)) return 'code';
    return 'binary';
  };

  // Project items, enriched where the zip carries the referenced file.
  const referenced = new Set<string>();
  const sidesOf = (it: ExpectedItem): Side[] => (['a', 'b'] as const).filter((s) => it[s] !== null);
  const items: PackageItem[] = proj.items.map((it) => {
    if (it.element !== 'File' && it.element !== 'PerTenantFile') return { ...it, sides: sidesOf(it) };
    const path = it.key.replace(/\\/g, '/').toLowerCase();
    referenced.add(path);
    const ea = it.a ? za.get(path) : undefined;
    const eb = it.b ? zb.get(path) : undefined;
    if (!ea && !eb) return { ...it, sides: sidesOf(it) }; // reference only on both sides: compare the element
    const kind = kindOf(path);
    // .aspx/.html content gets a screen outline summary first; other files have Facts last.
    const views = withSummary([kind, 'xml'], /\.(aspx|html?)$/.test(path));
    let status: ItemStatus = it.status;
    if (it.a && it.b) status = ea && eb ? fileStatus(kind, ea.data, eb.data) : 'modified';
    // A referenced DLL or image is grouped by kind, like an unreferenced one.
    const group: ProjectGroup = kind === 'assembly' ? 'assemblies' : kind === 'image' ? 'images' : it.group;
    return { ...it, group, views, status, sides: sidesOf(it) };
  });

  // Unreferenced zip entries become Zip:<path> items.
  const zipItems = new Map<string, PackageItem>();
  for (const side of ['a', 'b'] as const) {
    for (const e of inputs[side]) {
      if (e.path === 'project.xml' || referenced.has(e.path.toLowerCase())) continue;
      const id = `Zip:${e.path}`;
      const kind = kindOf(e.path);
      const group: ProjectGroup = kind === 'assembly' ? 'assemblies' : kind === 'image' ? 'images' : 'files';
      const prev = zipItems.get(id);
      if (prev) {
        prev.sides.push('b');
        const ea = za.get(e.path.toLowerCase());
        prev.status = ea ? fileStatus(kind, ea.data, e.data) : 'modified';
        continue;
      }
      zipItems.set(id, {
        id,
        element: 'Zip',
        key: e.path,
        group,
        name: e.path.slice(e.path.lastIndexOf('/') + 1),
        detail: 'not in project.xml',
        screenId: null,
        status: side === 'a' ? 'only-a' : 'only-b',
        views: [kind, 'summary'], // no xml view: not in project.xml
        // No project.xml lines; `sides` says where the file is.
        a: null,
        b: null,
        sides: [side],
        loose: ['views', 'ranges'],
      });
    }
  }
  items.push(...zipItems.values());
  items.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));

  const byStatus: Record<ItemStatus, number> = { same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 };
  const byGroup: Partial<Record<ProjectGroup, number>> = {};
  for (const e of items) {
    byStatus[e.status]++;
    byGroup[e.group] = (byGroup[e.group] ?? 0) + 1;
  }

  const overview = (side: Side): ExpectedOverview => {
    const present = items.filter((i) => i.sides.includes(side));
    const counts: Partial<Record<ProjectGroup, number>> = {};
    for (const i of present) counts[i.group] = (counts[i.group] ?? 0) + 1;
    const screens = [...new Set(present.filter((i) => (i.element === 'Page' || i.element === 'SiteMapNode') && i.screenId).map((i) => i.screenId as string))].sort();
    const dll = inputs[side].find((e) => e.path === 'Bin/Contoso.Extensions.dll');
    return {
      name: `package-${side}.zip`,
      kind: 'zip',
      bytes: zips[side].length,
      attributes: proj.root[side],
      counts,
      screensInclude: screens,
      assemblies: dll ? [{ path: dll.path, size: dll.data.length }] : [],
      warningsInclude: ['Pages/PO/PO302000.aspx'],
    };
  };

  const notes = releaseNotes.findIndex((l) => l.includes('CONTOSO-RELEASE-NOTE-0042')) + 1;
  const searches: SearchExpectation[] = [
    { query: proj.pageSource.mustContain, itemId: proj.pageSource.id, side: 'a', what: 'decoded ASPX (pageSource)' },
    { query: proj.cdataSplit.mustContain, itemId: proj.cdataSplit.id, side: 'a', what: 'CDATA C# body' },
    { query: 'CONTOSO-RELEASE-NOTE-0042', itemId: 'Zip:Docs/release-notes.txt', side: 'a', line: notes, what: 'zip text file' },
    { query: 'CONTOSO-SNAPSHOT-ZONE', itemId: 'Zip:App_Data/SnapshotConfigs/ContosoRoutes.esc', side: 'b', line: 2, what: '.esc text file' },
    { query: 'CONTOSO-PAGE-MARKER-5520', itemId: `File:Pages\\SO\\${RELATED_SCREEN}.aspx.cs`, side: 'a', line: 8, what: 'referenced zip file content' },
    { query: 'CONTOSO-ROUTE-AUDIT-7731', itemId: 'File:Bin\\Contoso.Extensions.dll', side: 'a', what: 'DLL string literal (assembly browser)' },
  ];

  return {
    zips,
    entries: { a: inputs.a.map((e) => ({ path: e.path, size: e.data.length })), b: inputs.b.map((e) => ({ path: e.path, size: e.data.length })) },
    items,
    counts: { total: items.length, byStatus, byGroup },
    overview: { a: overview('a'), b: overview('b') },
    searches,
    edits: {
      changedFiles: [`Pages/SO/${RELATED_SCREEN}.aspx`, `screens/SO/${RELATED_SCREEN}/${RELATED_SCREEN}.ts`, 'Bin/Contoso.Extensions.dll'],
      onlyInA: ['Images/contoso-banner.jpg', 'screens/PO/PO302000/PO302000.ts'],
      missingFromZip: ['Pages/PO/PO302000.aspx'],
      unreferenced: ['Images/contoso-banner.jpg', 'App_Data/SnapshotConfigs/ContosoRoutes.esc', 'Docs/release-notes.txt', 'Data/routes.bin'],
    },
  };
}
