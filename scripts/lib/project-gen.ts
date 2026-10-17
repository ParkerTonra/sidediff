// Deterministic Acumatica project.xml pair for the project explorer
// (docs/INTERFACES.md "Project explorer and whole-text undo"). Pure apart from
// node:zlib (Page pageSource is base64 of raw-deflate, as in real exports).
//
// Shaped like a real export: no <?xml> header, CRLF line endings, very long
// attribute lines, entities in attribute values, self-closing items. Each item
// is a small element model; B is a mutated copy. The expected item list (id,
// group, status, ...) is derived from the models with the contract's rules, so
// the sidecar never depends on the app's scanner. All names are invented.

import { deflateRawSync } from 'node:zlib';
import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { csharpUnit, mutateLine } from './fixture-gen.ts';
import type { ItemStatus, ItemViewKind, ProjectGroup } from '../../src/types.ts';

export const PROJECT_SEED = 0x5d1f_0100;
export const EOL = '\r\n';

type Part =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'cdata'; name: string; body: string[]; indent?: string }
  /** CDATA directly inside the element, no <CDATA name> wrapper (EditorUpdatedFields). */
  | { kind: 'bare'; body: string[] }
  /** A <Field> of a <DAC>, with an optional TextAttributes CDATA. */
  | { kind: 'field'; attrs: [string, string][]; body: string[] | null };

interface El {
  tag: string;
  attrs: [string, string][];
  parts: Part[];
  /** Page only: the ASPX that pageSource encodes. */
  aspx?: string[];
}

interface Item {
  key: string;
  /** Overrides `${tag}:${key}` (EntityEndpoint name@version). */
  idBase?: string;
  group: ProjectGroup;
  name: string;
  detail: string;
  screenId?: string;
  /** Fields the contract leaves open for this element kind (oracles skip them). */
  loose?: ('name' | 'detail' | 'screenId' | 'views' | 'ranges')[];
  a: El | null;
  b: El | null;
}

export interface ExpectedItem {
  id: string;
  element: string;
  key: string;
  group: ProjectGroup;
  name: string;
  /** From A when present, else B. */
  detail: string;
  screenId: string | null;
  status: ItemStatus;
  views: ItemViewKind['id'][];
  /** 1-based inclusive element line ranges, null when absent on that side. */
  a: { startLine: number; endLine: number } | null;
  b: { startLine: number; endLine: number } | null;
  /** Present when the contract leaves some fields open for this kind; compare the rest. */
  loose?: ('name' | 'detail' | 'screenId' | 'views' | 'ranges')[];
}

export interface ProjectPair {
  a: string;
  b: string;
  root: { a: Record<string, string>; b: Record<string, string> };
  items: ExpectedItem[];
  counts: { total: number; byStatus: Record<ItemStatus, number>; byGroup: Partial<Record<ProjectGroup, number>> };
  /** Item whose CDATA is split around "]]>", and a string its joined code must contain. */
  cdataSplit: { id: string; mustContain: string };
  /** Screen with a Page, .aspx/.aspx.cs Files, PerTenantFiles, a SiteMapNode and EditorUpdatedFields. */
  relatedScreen: { screenId: string; ids: string[] };
  /** A Page whose decoded pageSource must contain this text. */
  pageSource: { id: string; mustContain: string };
  edits: Record<string, string[]>;
}

export const GROUP_ORDER: readonly ProjectGroup[] = ['code', 'screens', 'tables', 'sql', 'reports', 'inquiries', 'sitemap', 'integration', 'security', 'files', 'assemblies', 'images', 'other'];

// ---------------------------------------------------------------- rendering

const escAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrs = (list: [string, string][]): string => list.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
/** A literal "]]>" in a CDATA body is split as "]]]]><![CDATA[>" (what the exporter writes). */
const encCdata = (l: string): string => l.replace(/\]\]>/g, ']]]]><![CDATA[>');

function cdataLines(name: string, body: string[], indent = '    '): string[] {
  const enc = body.map(encCdata);
  return [`${indent}<CDATA name="${name}"><![CDATA[${enc[0] ?? ''}`, ...enc.slice(1), ']]></CDATA>'];
}

const pageSource = (aspx: string[]): string => deflateRawSync(Buffer.from(aspx.join(EOL), 'utf8'), { level: 9 }).toString('base64');

function render(el: El): string[] {
  const list: [string, string][] = el.aspx ? [...el.attrs, ['pageSource', pageSource(el.aspx)]] : el.attrs;
  if (el.parts.length === 0) return [`<${el.tag}${attrs(list)} />`];
  const bare = el.parts[0];
  if (el.parts.length === 1 && bare?.kind === 'bare') {
    return `<${el.tag}${attrs(list)}><![CDATA[${bare.body.map(encCdata).join(EOL)}]]></${el.tag}>`.split(EOL);
  }
  const out = [`<${el.tag}${attrs(list)}>`];
  for (const p of el.parts) {
    if (p.kind === 'lines') out.push(...p.lines);
    else if (p.kind === 'cdata') out.push(...cdataLines(p.name, p.body, p.indent));
    else if (p.kind === 'bare') {
      const enc = p.body.map(encCdata);
      out.push(`    <![CDATA[${enc[0] ?? ''}`, ...enc.slice(1));
      out[out.length - 1] += ']]>';
    } else if (p.body === null) out.push(`    <Field${attrs(p.attrs)} />`);
    else out.push(`    <Field${attrs(p.attrs)}>`, ...cdataLines('TextAttributes', p.body, '        '), '    </Field>');
  }
  out.push(`</${el.tag}>`);
  return out;
}

const clone = (el: El): El => JSON.parse(JSON.stringify(el)) as El;
const getAttr = (list: [string, string][], k: string): string => list.find(([n]) => n === k)?.[1] ?? '';
type CdataPart = Extract<Part, { kind: 'cdata' }>;
const cdatas = (el: El): CdataPart[] => el.parts.filter((p): p is CdataPart => p.kind === 'cdata');

/** The default view's text per the contract (line arrays; CR differences don't matter). */
function defaultView(el: El): string[] {
  if (el.tag === 'Page') return el.aspx ?? render(el);
  if (el.tag === 'DAC') {
    const blocks = el.parts.flatMap((p) =>
      p.kind === 'field' ? [[`// ${getAttr(p.attrs, 'FieldName')} : ${getAttr(p.attrs, 'TypeName')} (${getAttr(p.attrs, 'StorageName')})`, ...(p.body ?? [])]] : [],
    );
    return blocks.flatMap((b, i) => (i === 0 ? b : ['', ...b]));
  }
  if (el.tag === 'EditorUpdatedFields') {
    const bare = el.parts.find((p): p is Extract<Part, { kind: 'bare' }> => p.kind === 'bare');
    const raw = (bare?.body ?? []).join('\n');
    try {
      return JSON.stringify(JSON.parse(raw), null, 2).split('\n');
    } catch {
      return raw.split('\n');
    }
  }
  const c = cdatas(el);
  if (c.length === 0) return render(el);
  if (c.length === 1) return c[0]?.body ?? [];
  return c.flatMap((x) => [`// ---- ${x.name} ----`, ...x.body]);
}

function textViews(el: El): ExpectedItem['views'] {
  if (el.tag === 'Page') return el.parts.length ? ['code', 'changes', 'xml'] : ['code', 'xml'];
  if (el.tag === 'DAC' || el.tag === 'EditorUpdatedFields') return ['code', 'xml'];
  return cdatas(el).length ? ['code', 'xml'] : ['xml'];
}

/** Kinds whose summary view is listed first (Phase 5); every other item has it last ("Facts"). */
export function summaryFirst(tag: string, attrs: [string, string][]): boolean {
  const ft = attrs.find(([k]) => k === 'FileType')?.[1] ?? '';
  if (tag === 'Graph') return ft === 'ExistingDac' || ft === 'NewDac';
  if (tag === 'Sql') return attrs.some(([k]) => k === 'TableSchemaXml');
  if (tag === 'Page') return true; // every fixture Page has a pageSource
  return ['DAC', 'Table', 'GenericInquiryScreen', 'GIDesign', 'ScreenWithRights', 'SiteMapNode', 'MobileSiteMap'].includes(tag);
}

/** Views in order: a summary first or last, then the text views (status comes from the first text view). */
export function withSummary(text: ExpectedItem['views'], first: boolean): ExpectedItem['views'] {
  return first ? ['summary', ...text] : [...text, 'summary'];
}

function views(el: El): ExpectedItem['views'] {
  return withSummary(textViews(el), summaryFirst(el.tag, el.attrs));
}

function status(a: El | null, b: El | null): ItemStatus {
  if (!a) return 'only-b';
  if (!b) return 'only-a';
  const x = defaultView(a);
  const y = defaultView(b);
  if (x.join('\n') === y.join('\n')) return 'same';
  if (x.length === y.length && x.every((l, i) => l.trim() === (y[i] ?? '').trim())) return 'whitespace';
  return 'modified';
}

// ---------------------------------------------------------------- content

const WORDS = ['Order', 'Customer', 'Inventory', 'Vendor', 'Shipment', 'Freight', 'Margin', 'Rebate', 'Contract', 'Approval', 'Credit', 'Batch', 'Route', 'Carrier', 'Region', 'Commission', 'Allocation', 'Backorder', 'Warranty', 'Lot'];
const GRAPHS = ['SOOrderEntry', 'POOrderEntry', 'ARInvoiceEntry', 'APInvoiceEntry', 'INReceiptEntry', 'InventoryItemMaint', 'CustomerMaint', 'ProjectEntry', 'SOShipmentEntry', 'CRCaseMaint'];
const DACS = ['SOOrder', 'SOLine', 'POOrder', 'POLine', 'ARInvoice', 'APInvoice', 'INTran', 'InventoryItem', 'BAccount', 'PMTask', 'SOShipment', 'CRCase'];
const DAC_NS: Record<string, string> = { SO: 'PX.Objects.SO', PO: 'PX.Objects.PO', AR: 'PX.Objects.AR', AP: 'PX.Objects.AP', IN: 'PX.Objects.IN', BA: 'PX.Objects.CR', PM: 'PX.Objects.PM', CR: 'PX.Objects.CR' };
const MODS = ['so', 'po', 'ar', 'ap', 'in', 'pm', 'cr'];
const FILE_TYPES: [string, string][] = [
  ['ExistingGraph', 'Graph extension'],
  ['NewGraph', 'New graph'],
  ['ExistingDac', 'DAC extension'],
  ['NewDac', 'New DAC'],
  ['NewFile', 'Code file'],
];
export const RELATED_SCREEN = 'SO301000';

const guid = (rng: Rng): string => {
  const h = (n: number): string => Array.from({ length: n }, () => '0123456789abcdef'.charAt(rng.int(0, 15))).join('');
  return `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`;
};

function aspxPage(rng: Rng, screen: string, controls: number): string[] {
  const graph = rng.pick(GRAPHS);
  const out = [
    `<%@ Page Language="C#" MasterPageFile="~/MasterPages/FormDetail.master" AutoEventWireup="true" ValidateRequest="false" CodeFile="${screen}.aspx.cs" Inherits="Page_${screen}" Title="Untitled Page" %>`,
    '<%@ MasterType VirtualPath="~/MasterPages/FormDetail.master" %>',
    '<asp:Content ID="cont1" ContentPlaceHolderID="phDS" runat="Server">',
    `    <px:PXDataSource ID="ds" runat="server" Visible="True" Width="100%" TypeName="PX.Objects.${screen.slice(0, 2)}.${graph}" PrimaryView="Document">`,
    '    </px:PXDataSource>',
    '</asp:Content>',
    '<asp:Content ID="cont2" ContentPlaceHolderID="phF" runat="Server">',
    '    <px:PXFormView ID="form" runat="server" DataSourceID="ds" Width="100%" DataMember="Document">',
    '        <Template>',
  ];
  for (let i = 0; i < controls; i++) {
    const f = `Usr${rng.pick(WORDS)}${rng.pick(WORDS)}${i}`;
    out.push(`            <px:PX${rng.pick(['TextEdit', 'NumberEdit', 'CheckBox', 'Selector', 'DateTimeEdit'])} ID="ed${f}" runat="server" DataField="${f}" CommitChanges="True" />`);
  }
  out.push('        </Template>', '    </px:PXFormView>', '</asp:Content>');
  return out;
}

function columns(rng: Rng, table: string, n: number, salt: string): string[] {
  return Array.from({ length: n }, (_, i) => {
    const t = rng.pick(['nvarchar', 'decimal', 'int', 'bit', 'datetime']);
    const extra = t === 'nvarchar' ? ` MaxLength="${rng.int(10, 255)}" IsUnicode="True"` : t === 'decimal' ? ` DecimalPrecision="${rng.int(0, 6)}"` : '';
    return `    <Column TableName="${table}" ColumnName="Usr${rng.pick(WORDS)}${rng.pick(WORDS)}${salt}${i}" ColumnType="${t}"${extra} AllowNull="True" IsNewColumn="True" />`;
  });
}

function schemaXml(rng: Rng, table: string, n: number): string[] {
  return [
    `<table name="${table}">`,
    '  <col name="CompanyID" type="Int" default="Zero" />',
    '  <col name="RecordID" type="Int" identity="true" />',
    ...Array.from({ length: n }, (_, i) => `  <col name="Usr${rng.pick(WORDS)}${i}" type="${rng.pick(['NVarChar(50)', 'Decimal(19,6)', 'Int', 'Bit', 'DateTime'])}" nullable="true" />`),
    '  <col name="tstamp" type="Timestamp" />',
    `  <index name="${table}_PK" clustered="true" isPrimary="true">`,
    '    <col name="CompanyID" />',
    '    <col name="RecordID" />',
    '  </index>',
    '</table>',
  ];
}

function reportBody(rng: Rng, name: string, n: number): string[] {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Report Name="${name}">`,
    '  <Tables>',
    `    <ReportTable Name="${rng.pick(DACS)}" />`,
    '  </Tables>',
    '  <Sections>',
    '    <PageHeader Name="pageHeaderSection1" Height="56px">',
    '      <Items>',
    ...Array.from({ length: n }, (_, i) => `        <TextBox Name="textBox${i}" Left="${rng.int(0, 600)}px" Top="${rng.int(0, 40)}px" Value="=[${rng.pick(DACS)}.Usr${rng.pick(WORDS)}]" />`),
    '      </Items>',
    '    </PageHeader>',
    '  </Sections>',
    '</Report>',
  ];
}

/** A data-set (site map, generic inquiry): relations, layout and nested <row> data. */
function dataSet(mainTable: string, data: string[]): string[] {
  return [
    '    <data-set>',
    `        <relations format-version="3" relations-version="20240201" main-table="${mainTable}">`,
    `            <link from="${mainTable}Rights (ScreenID)" to="${mainTable} (ScreenID)" />`,
    '        </relations>',
    '        <layout>',
    `            <table name="${mainTable}" />`,
    '        </layout>',
    '        <data>',
    ...data.map((r) => `            ${r}`),
    '        </data>',
    '    </data-set>',
  ];
}

function siteMapRows(rng: Rng, screen: string, title: string): string[] {
  return ['<SiteMap>', `    <row Position="${rng.int(1, 900)}" Title="${escAttr(title)}" Url="~/Pages/${screen.slice(0, 2)}/${screen}.aspx" ScreenID="${screen}" NodeID="${guid(rng)}" ParentID="${guid(rng)}" />`, '</SiteMap>'];
}

// ---------------------------------------------------------------- items

function buildItems(rng: Rng): Item[] {
  const items: Item[] = [];
  const add = (it: Omit<Item, 'b'>): Item => {
    const item: Item = { ...it, b: it.a ? clone(it.a) : null };
    items.push(item);
    return item;
  };

  // Graphs: all FileTypes, C# in CDATA "Source".
  for (let i = 0; i < 54; i++) {
    const t = i % 9 === 3 ? 1 : i % 9 === 5 ? 2 : i % 13 === 6 ? 3 : i % 17 === 8 ? 4 : 0;
    const [fileType, detail] = FILE_TYPES[t] as [string, string];
    const cls = fileType.endsWith('Dac') ? `${rng.pick(DACS)}Ext_${rng.pick(WORDS)}${i}` : `${rng.pick(GRAPHS)}_${rng.pick(WORDS)}Ext${i}`;
    add({
      key: cls, group: 'code', name: cls, detail,
      a: { tag: 'Graph', attrs: [['ClassName', cls], ['Source', '#CDATA'], ['IsNew', fileType.startsWith('New') ? 'True' : 'False'], ['FileType', fileType]], parts: [{ kind: 'cdata', name: 'Source', body: csharpUnit(PROJECT_SEED + 1000 + i, rng.int(80, 400)) }] },
    });
  }
  // DAC customizations: <Field>s with TextAttributes CDATA (one self-closing).
  for (let i = 0; i < 6; i++) {
    const dac = DACS[(i * 5) % DACS.length] ?? 'SOOrder';
    const type = `${DAC_NS[dac.slice(0, 2).toUpperCase()] ?? 'PX.Objects.CS'}.${dac}`;
    const parts: Part[] = Array.from({ length: rng.int(2, 7) }, (_, k): Part => {
      const f = `Usr${rng.pick(WORDS)}${k}`;
      const typeName = rng.pick(['string', 'decimal?', 'int?', 'bool?']);
      const body = [`[PXDB${typeName === 'string' ? 'String(256)' : 'Decimal(4)'}]`, `[PXUIField(DisplayName="${f.slice(3)}")]`];
      return { kind: 'field', attrs: [['FieldName', f], ['TypeName', typeName], ['MapDbTable', dac], ['TextAttributes', '#CDATA'], ['StorageName', 'AddColumn']], body };
    });
    add({ key: type, group: 'code', name: dac, detail: `DAC customization · ${parts.length} fields`, a: { tag: 'DAC', attrs: [['type', type]], parts } });
  }
  // Files with C# content (code).
  for (let i = 0; i < 26; i++) {
    const nm = `${rng.pick(DACS)}${rng.pick(WORDS)}${i}`;
    const path = `App_Code\\Caches\\${nm}.cs`;
    add({ key: path, group: 'code', name: `${nm}.cs`, detail: path, a: { tag: 'File', attrs: [['AppRelativePath', path]], parts: [{ kind: 'cdata', name: 'Content', body: csharpUnit(PROJECT_SEED + 2000 + i, rng.int(60, 320)) }] } });
  }
  // Files with non-C# content (files).
  const withContent: [string, string[]][] = [
    ['Web.config.transform', ['<configuration>', '  <appSettings>', '    <add key="ContosoFeatureFlag" value="true" />', '  </appSettings>', '</configuration>']],
    ['Scripts\\contoso-grid.js', ['(function () {', "  'use strict';", '  window.contosoGrid = { pageSize: 50 };', '})();']],
    ['Docs\\README.txt', ['Contoso customization', 'Install after the base update.']],
  ];
  for (const [path, body] of withContent) {
    add({ key: path, group: 'files', name: path.split('\\').pop() ?? path, detail: path, a: { tag: 'File', attrs: [['AppRelativePath', path]], parts: [{ kind: 'cdata', name: 'Content', body }] } });
  }
  // Content-less file references, as in real exports (the files live in the zip).
  for (const path of [`Pages\\SO\\${RELATED_SCREEN}.aspx`, `Pages\\SO\\${RELATED_SCREEN}.aspx.cs`, 'Pages\\PO\\PO302000.aspx', 'Bin\\Contoso.Extensions.dll', 'Images\\contoso-logo.png']) {
    const screenId = /Pages\\\w\w\\(\w\w\d{6})\.aspx/.exec(path)?.[1];
    add({ key: path, group: path.endsWith('.cs') ? 'code' : 'files', name: path.split('\\').pop() ?? path, detail: path, ...(screenId ? { screenId } : {}), a: { tag: 'File', attrs: [['AppRelativePath', path]], parts: [] } });
  }
  // Modern UI per-tenant files.
  for (const [screen, file] of [[RELATED_SCREEN, 'SO301000.ts'], [RELATED_SCREEN, 'SO301000.html'], ['PO302000', 'PO302000.ts']] as const) {
    const path = `screens\\${screen.slice(0, 2)}\\${screen}\\${file}`;
    add({ key: path, group: 'files', name: file, detail: `Modern UI file · ${path}`, screenId: screen, a: { tag: 'PerTenantFile', attrs: [['AppRelativePath', path], ['ScreenId', screen]], parts: [] } });
  }
  // Pages (screens): pageSource = base64(raw deflate(ASPX)). Every 4th carries a control delta.
  for (let i = 0; i < 22; i++) {
    const mod = i === 0 ? 'so' : rng.pick(MODS);
    const screen = i === 0 ? RELATED_SCREEN : `${mod.toUpperCase()}${i === 1 ? 302001 : rng.int(100000, 509999)}`;
    const path = `~/Pages/${mod.toUpperCase()}/${screen}.aspx`;
    // Page 4 is big, so its pageSource line is tens of thousands of characters, as in real exports.
    const aspx = aspxPage(rng, screen, i === 4 ? 1400 : rng.int(4, 40));
    const delta = i % 4 === 0 ? [`    <PXFormView ID="form"><Children Key="Template"><PXNumberEdit ID="edUsr${rng.pick(WORDS)}" DataField="Usr${rng.pick(WORDS)}" /></Children></PXFormView>`] : [];
    add({
      key: path, group: 'screens', name: screen, detail: delta.length ? 'Screen customization' : 'Page', screenId: screen,
      a: { tag: 'Page', attrs: [['path', path]], parts: delta.length ? [{ kind: 'lines', lines: delta }] : [], aspx },
    });
  }
  // A Modern UI only page: deflated HTML.
  {
    const html = ['<template>', '    <qp-template id="form-Document" name="17-17-14">', ...Array.from({ length: 12 }, (_, k) => `        <field name="Usr${rng.pick(WORDS)}${k}"></field>`), '    </qp-template>', '</template>'];
    const path = '~/Scripts/Screens/PO302000.html';
    add({ key: path, group: 'screens', name: 'PO302000', detail: 'Modern UI page', screenId: 'PO302000', a: { tag: 'Page', attrs: [['path', path], ['isModernUIOnlyNode', 'True']], parts: [], aspx: html } });
  }
  // Modern UI editor metadata: bare CDATA with JSON.
  for (const screen of [RELATED_SCREEN, 'PO302000', 'AR303000']) {
    const json = JSON.stringify({ screen, fields: Array.from({ length: rng.int(2, 6) }, (_, k) => ({ field: `Usr${rng.pick(WORDS)}${k}`, view: 'Document', visible: k % 2 === 0 })) });
    add({ key: screen, group: 'screens', name: `${screen} editor fields`, detail: 'Modern UI editor metadata', screenId: screen, a: { tag: 'EditorUpdatedFields', attrs: [['ScreenId', screen]], parts: [{ kind: 'bare', body: [json] }] } });
  }
  // Tables, with a duplicate identity (SOLine twice).
  for (let i = 0; i < 20; i++) {
    const t = i === 0 || i === 13 ? 'SOLine' : `${rng.pick(DACS)}${rng.pick(WORDS)}${i}`;
    const n = rng.int(2, 14);
    add({ key: t, group: 'tables', name: t, detail: `${n} columns`, a: { tag: 'Table', attrs: [['TableName', t]], parts: [{ kind: 'lines', lines: columns(rng, t, n, `T${i}`) }] } });
  }
  // Sql: CDATA TableSchemaXml; one schema has "]]>" in a comment.
  for (let i = 0; i < 7; i++) {
    const t = `Usr${rng.pick(WORDS)}History${i}`;
    const body = schemaXml(rng, t, rng.int(4, 20));
    if (i === 2) body.splice(1, 0, '  <!-- the exporter splits a literal ]]> like this one -->');
    add({ key: t, group: 'sql', name: t, detail: 'Table schema', a: { tag: 'Sql', attrs: [['TableName', t], ['TableSchemaXml', '#CDATA']], parts: [{ kind: 'cdata', name: 'TableSchemaXml', body }] } });
  }
  // Reports (CDATA XML).
  for (let i = 0; i < 4; i++) {
    const r = `SO64${1000 + i * 10}.rpx`;
    add({ key: r, group: 'reports', name: r, detail: '', a: { tag: 'Report', attrs: [['ReportName', r]], parts: [{ kind: 'cdata', name: 'Xml', body: reportBody(rng, r, rng.int(10, 40)) }] } });
  }
  // Site map nodes: identity = first <row> with ScreenID; detail = its Title (entities decoded).
  for (let i = 0; i < 7; i++) {
    const screen = i === 0 ? RELATED_SCREEN : `${rng.pick(MODS).toUpperCase()}${rng.int(100000, 509999)}`;
    const title = i === 0 ? 'Orders & Returns' : i === 3 ? 'Route "Express" Audit' : `${rng.pick(WORDS)} ${rng.pick(WORDS)}`;
    add({ key: screen, group: 'sitemap', name: screen, detail: title, screenId: screen, a: { tag: 'SiteMapNode', attrs: [], parts: [{ kind: 'lines', lines: dataSet('SiteMap', siteMapRows(rng, screen, title)) }] } });
  }
  // Generic inquiries: nested <row>s; identity = first <row> with Name.
  for (let i = 0; i < 5; i++) {
    const name = `CT-${rng.pick(WORDS)}${rng.pick(WORDS)}${i}`;
    const id = guid(rng);
    const rows = [
      '<GIDesign>',
      `    <row DesignID="${id}" Name="${name}" FilterColCount="3" PageSize="0" ExportTop="0" NewRecordCreationEnabled="False">`,
      ...Array.from({ length: rng.int(2, 5) }, (_, k) => `        <GITable LineNbr="${k + 1}" Alias="${rng.pick(DACS)}${k}" Name="PX.Objects.SO.${rng.pick(DACS)}" />`),
      ...Array.from({ length: rng.int(3, 9) }, (_, k) => `        <GIResult LineNbr="${k + 1}" ObjectName="${rng.pick(DACS)}" Field="${rng.pick(WORDS).toLowerCase()}Nbr" IsVisible="True" />`),
      '    </row>',
      '</GIDesign>',
    ];
    add({ key: name, group: 'inquiries', name, detail: 'Generic inquiry', a: { tag: 'GenericInquiryScreen', attrs: [], parts: [{ kind: 'lines', lines: dataSet('GIDesign', rows) }] } });
  }
  // Endpoints: the same name in two versions, plus another one.
  for (const [nm, ver] of [['ContosoEndpoint', '23.200.001'], ['ContosoEndpoint', '24.200.001'], ['ContosoMobile', '24.200.001']] as const) {
    // The 24.200.001 ContosoEndpoint is made B-only below.
    const lines = [
      `    <Endpoint xmlns="http://www.acumatica.com/entity/maintenance/5.31" name="${nm}" version="${ver}" systemContractVersion="4">`,
      ...Array.from({ length: rng.int(4, 12) }, (_, k) => `        <TopLevelEntity name="${rng.pick(WORDS)}${k}" screen="${rng.pick(MODS).toUpperCase()}${rng.int(100000, 509999)}" />`),
      '    </Endpoint>',
    ];
    add({ key: nm, idBase: `EntityEndpoint:${nm}@${ver}`, group: 'integration', name: nm, detail: `Version ${ver}`, a: { tag: 'EntityEndpoint', attrs: [['Name', nm], ['Version', ver]], parts: [{ kind: 'lines', lines }] } });
  }
  // Phase 5 kinds seen in real packages. Name/detail/screenId the contract leaves open follow the
  // classifier's choices (src/project/classify.ts); still-open ones are marked loose.
  // Access rights per screen: identity = ScreenID of the first row.
  for (const [screen, title] of [[RELATED_SCREEN, 'Orders & Returns'], ['PO302000', 'Purchase Receipts'], ['AR303000', 'Customer Credit']] as const) {
    const rows = [
      '<SiteMap>',
      `    <row Position="${rng.int(1, 900)}" Title="${escAttr(title)}" Url="~/Pages/${screen.slice(0, 2)}/${screen}.aspx" ScreenID="${screen}" NodeID="${guid(rng)}" ParentID="${guid(rng)}">`,
      ...['Administrator', 'Contoso Sales', 'Contoso Warehouse'].map((role, k) => `        <RolesInGraph Rolename="${role}" ApplicationName="/" Accessrights="${4 - k}" />`),
      '    </row>',
      '</SiteMap>',
    ];
    const lines = dataSet('SiteMap', rows).map((l, k) => (k === 1 ? l.replace('">', '" stable-sharing="True" file-name="(ScreenID)">') : l));
    add({ key: screen, group: 'security', name: screen, detail: `Access rights · ${title}`, screenId: screen, a: { tag: 'ScreenWithRights', attrs: [['accessRightsMergeRule', 'ApplyPermissionsFromCustomizationProject']], parts: [{ kind: 'lines', lines }] } });
  }
  // Workflow (automation) definitions: identity = ScreenID.
  for (const screen of [RELATED_SCREEN, 'PO302000']) {
    const steps = ['Hold', 'Open', 'Completed'].flatMap((st) => [`    <Step StepID="${st}" Description="${st} state">`, `        <Action ActionName="${rng.pick(['releaseFromHold', 'putOnHold', 'complete', 'reopen'])}" IsActive="True" />`, '    </Step>']);
    add({ key: screen, group: 'screens', name: `${screen} automation`, detail: '', screenId: screen, loose: ['detail'], a: { tag: 'Automation', attrs: [['ScreenID', screen]], parts: [{ kind: 'lines', lines: steps }] } });
  }
  // Mobile site map.
  add({ key: RELATED_SCREEN, group: 'sitemap', name: RELATED_SCREEN, detail: 'Mobile site map', screenId: RELATED_SCREEN, a: { tag: 'MobileSiteMap', attrs: [['ScreenID', RELATED_SCREEN]], parts: [{ kind: 'lines', lines: [`    <Screen Id="${RELATED_SCREEN}" Type="SimpleScreen" DisplayName="Sales Orders" Icon="system://Cart" />`, '    <Workspace Name="Sales" />'] }] } });
  // Import/export scenarios (integration, identity = Name).
  for (const nm of ['Contoso Import Routes', 'Contoso Export Carriers']) {
    const rows = ['<SYMapping>', `    <row Name="${nm}" ScreenID="SM206025" GraphName="PX.Api.SYImportProcess" IsActive="True">`, ...Array.from({ length: rng.int(3, 8) }, (_, k) => `        <SYMappingField LineNbr="${k + 1}" ObjectName="Document" FieldName="Usr${rng.pick(WORDS)}${k}" Value="=[Route${k}]" />`), '    </row>', '</SYMapping>'];
    add({ key: nm, group: 'integration', name: nm, detail: 'Scenario · SM206025', screenId: 'SM206025', a: { tag: 'XportScenario', attrs: [['Name', nm]], parts: [{ kind: 'lines', lines: dataSet('SYMapping', rows) }] } });
  }
  // User-defined attributes (tables, identity = AttributeID of the first row).
  for (const [id, desc, values] of [['CTCOLOR', 'Route Color', ['RED', 'GREEN', 'BLUE']], ['CTZONE', 'Delivery Zone', ['NORTH', 'SOUTH']]] as const) {
    const rows = ['<CSAttribute>', `    <row AttributeID="${id}" Description="${desc}" ControlType="2" IsInternal="False" ContainsPersonalData="False">`, ...values.map((v, k) => `        <CSAttributeDetail ValueID="${v}" Description="${v.charAt(0)}${v.slice(1).toLowerCase()}" SortOrder="${k + 1}" Disabled="False" />`), '    </row>', '</CSAttribute>'];
    add({ key: id, group: 'tables', name: id, detail: `Attribute · ${desc}`, a: { tag: 'CSAttribute', attrs: [], parts: [{ kind: 'lines', lines: dataSet('CSAttribute', rows) }] } });
  }
  // Modern dashboards (inquiries, identity = Name of the first row).
  {
    const nm = 'Contoso Sales Overview';
    const rows = ['<Dashboard>', `    <row DashboardID="${guid(rng)}" Name="${nm}" Owner="admin" AllowCopy="True">`, ...Array.from({ length: 4 }, (_, k) => `        <DashboardWidget WidgetID="${guid(rng)}" Type="${rng.pick(['Chart', 'Table', 'Scorecard'])}" Caption="Widget ${k + 1}" Row="${k}" Column="0" />`), '    </row>', '</Dashboard>'];
    add({ key: nm, group: 'inquiries', name: nm, detail: 'Dashboard', a: { tag: 'DashboardV2', attrs: [], parts: [{ kind: 'lines', lines: dataSet('Dashboard', rows) }] } });
  }
  // Unknown elements: land in "other" with detail = element name.
  for (let i = 0; i < 2; i++) {
    const nm = `${rng.pick(MODS).toUpperCase()}${rng.int(100000, 509999)}`;
    add({ key: nm, group: 'other', name: nm, detail: 'MobileSiteMapNode', a: { tag: 'MobileSiteMapNode', attrs: [['Name', nm]], parts: [{ kind: 'lines', lines: [`    <Screen Id="${nm}" Type="SimpleScreen" DisplayName="${rng.pick(WORDS)}" Icon="system://Box" />`] }] } });
  }
  return items;
}

// ---------------------------------------------------------------- B mutations

function editCode(el: El, rng: Rng, kind: 'csToken' | 'whitespace', count: number): void {
  const part = cdatas(el)[0];
  if (!part) throw new Error(`${el.tag} has no CDATA`);
  const candidates = part.body.map((_, i) => i).filter((i) => (part.body[i] ?? '').trim().length > 20);
  rng.shuffle(candidates);
  let done = 0;
  for (const i of candidates) {
    if (done >= count) break;
    const before = part.body[i] ?? '';
    const after = kind === 'whitespace' ? `    ${before}` : mutateLine('csToken', before, false, rng);
    if (after === null || after === before) continue;
    if (kind === 'csToken' && after.trim() === before.trim()) continue;
    part.body[i] = after;
    done++;
  }
  if (done < count) throw new Error(`could not apply ${count} ${kind} edits to ${el.tag}`);
}

function buildPair(): ProjectPair {
  const rng = createRng(PROJECT_SEED);
  const items = buildItems(rng);
  const edits: Record<string, string[]> = { onlyA: [], onlyB: [], modified: [], whitespace: [], moved: [], sameAfterJsonReformat: [] };
  const by = (tag: string): Item[] => items.filter((it) => (it.a ?? it.b)?.tag === tag);
  const pick = (list: Item[], i: number): Item => {
    const it = list[i];
    if (!it) throw new Error(`no item ${i}`);
    return it;
  };
  const graphs = by('Graph');
  const csFiles = by('File').filter((it) => it.group === 'code' && it.a?.parts.length);
  const pages = by('Page');
  const tables = by('Table');
  const B = (it: Item): El => {
    if (!it.b) throw new Error(`${it.key} has no B`);
    return it.b;
  };
  const mod = (it: Item, f: (el: El) => void): void => {
    f(B(it));
    edits.modified?.push(it.key);
  };

  // One endpoint name in a second version, only in B (distinct item, no merge).
  {
    const it = pick(by('EntityEndpoint'), 1);
    it.a = null;
    edits.onlyB?.push(`${it.key}@24.200.001`);
  }
  // Only in A.
  for (const it of [pick(graphs, 5), pick(pages, 3), pick(tables, 4), pick(csFiles, 2), pick(by('SiteMapNode'), 1), pick(by('MobileSiteMapNode'), 1), pick(by('PerTenantFile'), 2)]) {
    it.b = null;
    edits.onlyA?.push(it.key);
  }
  // Modified code: single-token C# changes.
  for (const i of [0, 1, 2, 8, 9, 15, 21, 30]) mod(pick(graphs, i), (el) => editCode(el, rng, 'csToken', rng.int(1, 4)));
  for (const i of [0, 7]) mod(pick(csFiles, i), (el) => editCode(el, rng, 'csToken', 2));
  // Other modifications, at least one per kind.
  mod(pick(pages, 1), (el) => el.aspx?.splice(10, 0, '            <px:PXCheckBox ID="chkUsrRush" runat="server" DataField="UsrRush" />'));
  mod(pick(pages, 4), (el) => {
    if (el.aspx) el.aspx[3] = (el.aspx[3] ?? '').replace('Visible="True"', 'Visible="False"');
  });
  mod(pick(by('DAC'), 0), (el) => {
    const f = el.parts.find((p): p is Extract<Part, { kind: 'field' }> => p.kind === 'field' && p.body !== null);
    if (f?.body) f.body[0] = (f.body[0] ?? '').replace(/\((\d+)/, (_, n: string) => `(${Number(n) + 10}`);
  });
  mod(pick(by('DAC'), 1), (el) => el.parts.push({ kind: 'field', attrs: [['FieldName', 'UsrAddedInB'], ['TypeName', 'bool?'], ['MapDbTable', 'SOOrder'], ['TextAttributes', '#CDATA'], ['StorageName', 'AddColumn']], body: ['[PXDBBool]', '[PXUIField(DisplayName="Added In B")]'] }));
  mod(pick(by('EditorUpdatedFields'), 0), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'bare') p.body = [(p.body[0] ?? '').replace('"visible":true', '"visible":"maybe"')];
  });
  mod(pick(tables, 6), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines.push(`    <Column TableName="${getAttr(el.attrs, 'TableName')}" ColumnName="UsrAddedInB" ColumnType="bit" AllowNull="True" IsNewColumn="True" />`);
  });
  // The second SOLine (duplicate identity) changes; the first does not.
  mod(pick(tables, 13), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines.pop();
  });
  mod(pick(by('Sql'), 1), (el) => cdatas(el)[0]?.body.splice(3, 0, '  <col name="UsrAddedInB" type="NVarChar(30)" nullable="true" />'));
  mod(pick(by('Report'), 0), (el) => {
    const c = cdatas(el)[0];
    if (c) c.body[1] = (c.body[1] ?? '').replace('">', '" Landscape="True">');
  });
  mod(pick(by('SiteMapNode'), 2), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines = p.lines.map((l) => l.replace(/Position="(\d+)"/, (_, n: string) => `Position="${Number(n) + 1}"`));
  });
  mod(pick(by('GenericInquiryScreen'), 0), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') {
      const at = p.lines.findLastIndex((l) => l.includes('<GIResult '));
      p.lines.splice(at + 1, 0, '                        <GIResult LineNbr="99" ObjectName="SOOrder" Field="orderTotal" IsVisible="True" />');
    }
  });
  mod(pick(by('EntityEndpoint'), 0), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines.splice(1, 1);
  });
  mod(pick(by('File').filter((it) => it.group === 'files' && it.a?.parts.length), 0), (el) => {
    const c = cdatas(el)[0];
    if (c) c.body[2] = (c.body[2] ?? '').replace('value="true"', 'value="false"');
  });

  // Phase 5 kinds: rights changed, a UDF value added, a scenario only in A.
  mod(pick(by('ScreenWithRights'), 0), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines = p.lines.map((l) => (l.includes('Rolename="Contoso Sales"') ? l.replace(/Accessrights="\d"/, 'Accessrights="1"') : l));
  });
  mod(pick(by('CSAttribute'), 1), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') {
      const at = p.lines.findIndex((l) => l.includes('</row>'));
      p.lines.splice(at, 0, '                        <CSAttributeDetail ValueID="EAST" Description="East" SortOrder="3" Disabled="False" />');
    }
  });
  {
    const it = pick(by('XportScenario'), 1);
    it.b = null;
    edits.onlyA?.push(it.key);
  }

  // Whitespace-only.
  for (const i of [3, 4]) {
    editCode(B(pick(graphs, i)), rng, 'whitespace', 3);
    edits.whitespace?.push(pick(graphs, i).key);
  }
  {
    const it = pick(tables, 2);
    const p = B(it).parts[0];
    if (p?.kind === 'lines') p.lines[0] = `  ${p.lines[0] ?? ''}`;
    edits.whitespace?.push(it.key);
  }
  {
    const it = pick(csFiles, 5);
    const c = cdatas(B(it))[0];
    if (c) c.body[c.body.length - 3] = `${c.body[c.body.length - 3] ?? ''}   `;
    edits.whitespace?.push(it.key);
  }
  // Reformatted JSON (identical after pretty-printing) is "same".
  {
    const it = pick(by('EditorUpdatedFields'), 1);
    const p = B(it).parts[0];
    if (p?.kind === 'bare') p.body = JSON.stringify(JSON.parse(p.body.join('\n')), null, 1).split('\n');
    edits.sameAfterJsonReformat?.push(it.key);
  }

  // The CDATA split: a Graph whose C# contains "]]>" on both sides.
  const split = pick(graphs, 6);
  const splitLine = '            if (lines[idx[0]]> 0) return; // indexer of an indexer';
  for (const el of [split.a, split.b]) {
    const c = el ? cdatas(el)[0] : undefined;
    if (c) c.body.splice(Math.floor(c.body.length / 2), 0, splitLine);
  }

  // Only in B.
  const added: Item[] = [
    { key: 'SOOrderExt_AddedInB', group: 'code', name: 'SOOrderExt_AddedInB', detail: 'New DAC', a: null, b: { tag: 'Graph', attrs: [['ClassName', 'SOOrderExt_AddedInB'], ['Source', '#CDATA'], ['IsNew', 'True'], ['FileType', 'NewDac']], parts: [{ kind: 'cdata', name: 'Source', body: csharpUnit(PROJECT_SEED + 9001, 120) }] } },
    { key: 'UsrRouteAudit', group: 'sql', name: 'UsrRouteAudit', detail: 'Table schema', a: null, b: { tag: 'Sql', attrs: [['TableName', 'UsrRouteAudit'], ['TableSchemaXml', '#CDATA']], parts: [{ kind: 'cdata', name: 'TableSchemaXml', body: schemaXml(rng, 'UsrRouteAudit', 6) }] } },
    { key: 'SO509999', group: 'sitemap', name: 'SO509999', detail: 'Route Audit', screenId: 'SO509999', a: null, b: { tag: 'SiteMapNode', attrs: [], parts: [{ kind: 'lines', lines: dataSet('SiteMap', siteMapRows(rng, 'SO509999', 'Route Audit')) }] } },
    { key: 'fr-FR', group: 'other', name: 'fr-FR', detail: 'Locale', a: null, b: { tag: 'Locale', attrs: [['Name', 'fr-FR'], ['IsActive', 'True']], parts: [{ kind: 'lines', lines: ['    <Translation Source="Route" Target="Itinéraire" />'] }] } },
  ];
  items.push(...added);
  edits.onlyB?.push(...added.map((it) => it.key));

  // Order: A in build order; B moves one Table and one Graph, and inserts the new items.
  const orderA = items.filter((it) => it.a);
  const orderB = items.filter((it) => it.b && !added.includes(it));
  const moveTable = pick(tables, 8);
  const moveGraph = pick(graphs, 20);
  const movePage = pick(pages, 9);
  const move = (list: Item[], it: Item, to: number): void => {
    list.splice(list.indexOf(it), 1);
    list.splice(to, 0, it);
  };
  move(orderB, moveTable, orderB.length);
  move(orderB, moveGraph, 3);
  move(orderB, movePage, 20);
  edits.moved?.push(moveTable.key, moveGraph.key, movePage.key);
  orderB.splice(40, 0, added[0] as Item);
  orderB.splice(orderB.length - 10, 0, ...added.slice(1));

  const rootA: Record<string, string> = { level: '99', description: '', 'product-version': '24.212' };
  const rootB: Record<string, string> = { ...rootA, 'product-version': '25.201' };

  const ranges = new Map<Item, { a?: { startLine: number; endLine: number }; b?: { startLine: number; endLine: number } }>();
  const doc = (order: Item[], side: 'a' | 'b', root: Record<string, string>): string => {
    const out = [`<Customization${attrs(Object.entries(root))}>`];
    order.forEach((it, i) => {
      if (i === 10) out.push('<!-- items below were merged from an older project -->');
      const el = it[side];
      if (!el) return;
      const start = out.length + 1;
      out.push(...render(el));
      const r = ranges.get(it) ?? {};
      r[side] = { startLine: start, endLine: out.length };
      ranges.set(it, r);
    });
    out.push('</Customization>');
    return out.join(EOL) + EOL;
  };
  const a = doc(orderA, 'a', rootA);
  const b = doc(orderB, 'b', rootB);

  const seen = new Map<string, number>();
  const expected: ExpectedItem[] = items.map((it) => {
    const el = (it.a ?? it.b) as El;
    const base = it.idBase ?? `${el.tag}:${it.key}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const r = ranges.get(it) ?? {};
    return {
      id: n === 1 ? base : `${base}#${n}`,
      element: el.tag,
      key: it.key,
      group: it.group,
      name: it.name,
      // From A when present, else B (the item list is built from A first).
      detail: it.detail,
      screenId: it.screenId ?? null,
      status: status(it.a, it.b),
      views: views(el),
      a: r.a ?? null,
      b: r.b ?? null,
      ...(it.loose ? { loose: it.loose } : {}),
    };
  });
  expected.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));

  const byStatus: Record<ItemStatus, number> = { same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 };
  const byGroup: Partial<Record<ProjectGroup, number>> = {};
  for (const e of expected) {
    byStatus[e.status]++;
    byGroup[e.group] = (byGroup[e.group] ?? 0) + 1;
  }
  const idOf = (it: Item): string => expected.find((e) => e.key === it.key && e.element === (it.a ?? it.b)?.tag)?.id ?? '';
  return {
    a,
    b,
    root: { a: rootA, b: rootB },
    items: expected,
    counts: { total: expected.length, byStatus, byGroup },
    cdataSplit: { id: idOf(split), mustContain: 'idx[0]]> 0' },
    relatedScreen: { screenId: RELATED_SCREEN, ids: expected.filter((e) => e.screenId === RELATED_SCREEN).map((e) => e.id) },
    pageSource: { id: idOf(pick(pages, 0)), mustContain: `Inherits="Page_${RELATED_SCREEN}"` },
    edits,
  };
}

let cached: ProjectPair | undefined;
/** The project pair. Deterministic; cached because tests call it repeatedly. */
export function generateProjectPair(): ProjectPair {
  return (cached ??= buildPair());
}
