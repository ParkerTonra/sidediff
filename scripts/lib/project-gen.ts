// Deterministic Acumatica project.xml pair for the project explorer
// (docs/INTERFACES.md "Project explorer and whole-text undo"). Pure.
//
// Each item is built as a small element model; B is a mutated copy. The
// expected item list (id, group, status, ...) is derived from the models with
// the contract's rules, so the sidecar never depends on the app's scanner.

import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { csharpUnit, mutateLine } from './fixture-gen.ts';
import type { ItemStatus, ProjectGroup } from '../../src/types.ts';

export const PROJECT_SEED = 0x5d1f_0100;

type Part = { kind: 'lines'; lines: string[] } | { kind: 'cdata'; name: string; body: string[] };

interface El {
  tag: string;
  attrs: [string, string][];
  parts: Part[];
}

interface Item {
  /** Identity per the contract's key rules (before duplicate suffixes). */
  key: string;
  group: ProjectGroup;
  name: string;
  /** null when the contract leaves it unspecified. */
  detail: string | null;
  a: El | null;
  b: El | null;
}

export interface ExpectedItem {
  id: string;
  element: string;
  key: string;
  group: ProjectGroup;
  name: string;
  detail: string | null;
  status: ItemStatus;
  views: ('code' | 'xml')[];
  /** 1-based inclusive element line ranges in each file, null when absent. */
  a: { startLine: number; endLine: number } | null;
  b: { startLine: number; endLine: number } | null;
}

export interface ProjectPair {
  a: string;
  b: string;
  root: { a: Record<string, string>; b: Record<string, string> };
  items: ExpectedItem[];
  counts: { total: number; byStatus: Record<ItemStatus, number>; byGroup: Partial<Record<ProjectGroup, number>> };
  /** Item whose CDATA is split around "]]>", and a string its joined code must contain. */
  cdataSplit: { id: string; mustContain: string };
  edits: Record<string, string[]>;
}

export const GROUP_ORDER: readonly ProjectGroup[] = ['code', 'screens', 'tables', 'sql', 'reports', 'inquiries', 'sitemap', 'integration', 'files', 'other'];

// ---------------------------------------------------------------- rendering

const escAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** CDATA body lines; a literal "]]>" is split as "]]]]><![CDATA[>" (what Acumatica writes). */
function cdataLines(name: string, body: string[]): string[] {
  const enc = body.map((l) => l.replace(/\]\]>/g, ']]]]><![CDATA[>'));
  return [`    <CDATA name="${name}"><![CDATA[${enc[0] ?? ''}`, ...enc.slice(1), ']]></CDATA>'];
}

function render(el: El): string[] {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  const out = [`<${el.tag}${attrs}>`];
  for (const p of el.parts) out.push(...(p.kind === 'lines' ? p.lines : cdataLines(p.name, p.body)));
  out.push(`</${el.tag}>`);
  return out;
}

const clone = (el: El): El => JSON.parse(JSON.stringify(el)) as El;
const attr = (el: El, k: string): string | undefined => el.attrs.find(([n]) => n === k)?.[1];
const setAttr = (el: El, k: string, v: string): void => {
  const a = el.attrs.find(([n]) => n === k);
  if (a) a[1] = v;
  else el.attrs.push([k, v]);
};
const cdatas = (el: El): Extract<Part, { kind: 'cdata' }>[] => el.parts.filter((p): p is Extract<Part, { kind: 'cdata' }> => p.kind === 'cdata');

/** Default view text per the contract: CDATA bodies when present, else the element's lines. */
function defaultView(el: El): { kind: 'code' | 'xml'; text: string[] } {
  const c = cdatas(el);
  if (c.length === 0) return { kind: 'xml', text: render(el) };
  if (c.length === 1) return { kind: 'code', text: c[0]?.body ?? [] };
  return { kind: 'code', text: c.flatMap((x) => [`// ---- ${x.name} ----`, ...x.body]) };
}

function status(a: El | null, b: El | null): ItemStatus {
  if (!a) return 'only-b';
  if (!b) return 'only-a';
  const x = defaultView(a).text;
  const y = defaultView(b).text;
  if (x.join('\n') === y.join('\n')) return 'same';
  if (x.length === y.length && x.every((l, i) => l.trim() === (y[i] ?? '').trim())) return 'whitespace';
  return 'modified';
}

// ---------------------------------------------------------------- content

const WORDS = ['Order', 'Customer', 'Inventory', 'Vendor', 'Shipment', 'Freight', 'Margin', 'Rebate', 'Contract', 'Approval', 'Credit', 'Batch', 'Route', 'Carrier', 'Region', 'Commission', 'Allocation', 'Backorder', 'Warranty', 'Lot'];
const GRAPHS = ['SOOrderEntry', 'POOrderEntry', 'ARInvoiceEntry', 'APInvoiceEntry', 'INReceiptEntry', 'InventoryItemMaint', 'CustomerMaint', 'ProjectEntry', 'SOShipmentEntry', 'CRCaseMaint'];
const DACS = ['SOOrder', 'SOLine', 'POOrder', 'POLine', 'ARInvoice', 'APInvoice', 'INTran', 'InventoryItem', 'BAccount', 'PMTask', 'SOShipment', 'CRCase'];
const MODS = ['so', 'po', 'ar', 'ap', 'in', 'pm', 'cr'];
const FILE_TYPES: [string, string][] = [
  ['ExistingGraph', 'Graph extension'],
  ['NewGraph', 'New graph'],
  ['ExistingDac', 'DAC extension'],
  ['NewDac', 'New DAC'],
];

function columns(rng: Rng, table: string, n: number, salt: string): string[] {
  return Array.from({ length: n }, (_, i) => {
    const t = rng.pick(['nvarchar', 'decimal', 'int', 'bit', 'datetime']);
    const extra = t === 'nvarchar' ? ` MaxLength="${rng.int(10, 255)}" IsUnicode="True"` : t === 'decimal' ? ` DecimalPrecision="${rng.int(0, 6)}"` : '';
    return `    <Column TableName="${table}" ColumnName="Usr${rng.pick(WORDS)}${rng.pick(WORDS)}${salt}${i}" ColumnType="${t}"${extra} AllowNull="True" IsNewColumn="True" />`;
  });
}

function sqlBody(rng: Rng, table: string, n: number): string[] {
  const cols = Array.from({ length: n }, (_, i) => `    [Usr${rng.pick(WORDS)}${i}] ${rng.pick(['NVARCHAR(50)', 'DECIMAL(19,6)', 'INT', 'BIT', 'DATETIME'])} NULL,`);
  return [
    `IF NOT EXISTS (SELECT * FROM sys.objects WHERE name = '${table}')`,
    'BEGIN',
    `  CREATE TABLE [dbo].[${table}] (`,
    '    [CompanyID] INT NOT NULL,',
    '    [RecordID] INT IDENTITY(1,1) NOT NULL,',
    ...cols,
    '    [tstamp] TIMESTAMP NOT NULL,',
    `    CONSTRAINT [PK_${table}] PRIMARY KEY CLUSTERED ([CompanyID], [RecordID])`,
    '  )',
    'END',
    'GO',
  ];
}

function reportBody(rng: Rng, name: string, n: number): string[] {
  const fields = Array.from({ length: n }, (_, i) => `      <TextBox Name="textBox${i}" Left="${rng.int(0, 600)}px" Top="${rng.int(0, 40)}px" Value="=[${rng.pick(DACS)}.Usr${rng.pick(WORDS)}]" />`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Report Name="${name}">`,
    '  <Tables>',
    `    <ReportTable Name="${rng.pick(DACS)}" />`,
    '  </Tables>',
    '  <Sections>',
    '    <PageHeader Name="pageHeaderSection1" Height="56px">',
    '      <Items>',
    ...fields,
    '      </Items>',
    '    </PageHeader>',
    '  </Sections>',
    '</Report>',
  ];
}

function dataSet(mainTable: string, rows: string[]): string[] {
  return [
    '    <data-set>',
    `        <relations format-version="3" relations-version="20240201" main-table="${mainTable}">`,
    `            <link from="${mainTable}Rights (ScreenID)" to="${mainTable} (ScreenID)" />`,
    '        </relations>',
    '        <layout>',
    `            <table name="${mainTable}" />`,
    '        </layout>',
    '        <data>',
    `            <${mainTable}>`,
    ...rows.map((r) => `                ${r}`),
    `            </${mainTable}>`,
    '        </data>',
    '    </data-set>',
  ];
}

const guid = (rng: Rng): string => {
  const h = (n: number): string => Array.from({ length: n }, () => '0123456789abcdef'.charAt(rng.int(0, 15))).join('');
  return `${h(8)}-${h(4)}-${h(4)}-${h(4)}-${h(12)}`;
};

// ---------------------------------------------------------------- items

function buildItems(rng: Rng): Item[] {
  const items: Item[] = [];
  const add = (key: string, group: ProjectGroup, name: string, detail: string | null, a: El): Item => {
    const item: Item = { key, group, name, detail, a, b: clone(a) };
    items.push(item);
    return item;
  };

  // Graphs (code), all FileTypes, C# in CDATA "Source".
  for (let i = 0; i < 50; i++) {
    const [fileType, detail] = FILE_TYPES[i % 7 === 3 ? 1 : i % 7 === 5 ? 2 : i % 11 === 6 ? 3 : 0] as [string, string];
    const cls = fileType.endsWith('Dac') ? `${rng.pick(DACS)}Ext_${rng.pick(WORDS)}${i}` : `${rng.pick(GRAPHS)}_${rng.pick(WORDS)}Ext${i}`;
    const body = csharpUnit(PROJECT_SEED + 1000 + i, rng.int(80, 400));
    add(cls, 'code', cls, detail, {
      tag: 'Graph',
      attrs: [['ClassName', cls], ['Source', '#CDATA'], ['IsNew', fileType.startsWith('New') ? 'True' : 'False'], ['FileType', fileType]],
      parts: [{ kind: 'cdata', name: 'Source', body }],
    });
  }
  // Files: .cs (code) and others (files).
  for (let i = 0; i < 30; i++) {
    const nm = `${rng.pick(DACS)}${rng.pick(WORDS)}${i}`;
    const path = `App_Code\\Caches\\${nm}.cs`;
    add(path, 'code', `${nm}.cs`, path, {
      tag: 'File',
      attrs: [['AppRelativePath', path]],
      parts: [{ kind: 'cdata', name: 'Content', body: csharpUnit(PROJECT_SEED + 2000 + i, rng.int(60, 320)) }],
    });
  }
  const other: [string, string[]][] = [
    ['Pages\\SO\\SO301000Ext.aspx', ['<%@ Page Language="C#" MasterPageFile="~/MasterPages/FormDetail.master" %>', '<asp:Content ID="cont1" ContentPlaceHolderID="phDS" runat="Server">', '    <px:PXDataSource ID="ds" runat="server" TypeName="PX.Objects.SO.SOOrderEntry" PrimaryView="Document" />', '</asp:Content>']],
    ['Web.config.transform', ['<configuration>', '  <appSettings>', '    <add key="ContosoFeatureFlag" value="true" />', '  </appSettings>', '</configuration>']],
    ['Scripts\\contoso-grid.js', ['(function () {', "  'use strict';", '  window.contosoGrid = { pageSize: 50 };', '})();']],
    ['Docs\\README.txt', ['Contoso customization', 'Install after the base 24R2 update.']],
  ];
  for (const [path, body] of other) {
    const nm = path.split('\\').pop() ?? path;
    add(path, 'files', nm, path, { tag: 'File', attrs: [['AppRelativePath', path]], parts: [{ kind: 'cdata', name: 'Content', body }] });
  }
  // Pages (screens). One carries a CDATA pageSource.
  for (let i = 0; i < 22; i++) {
    const mod = rng.pick(MODS);
    const screen = `${mod.toUpperCase()}${i < 2 ? 301000 + i : rng.int(100000, 509999)}`;
    const path = `~/pages/${mod}/${screen.toLowerCase()}.aspx`;
    const title = `${rng.pick(WORDS)} ${rng.pick(WORDS)} ${i}`;
    const fields = Array.from({ length: rng.int(3, 12) }, (_, k) => `    <PXField DataMember="${rng.pick(DACS)}" DataField="Usr${rng.pick(WORDS)}${k}" CommitChanges="True" LabelWidth="${rng.int(80, 200)}" />`);
    const parts: Part[] = [{ kind: 'lines', lines: fields }];
    if (i === 7) parts.push({ kind: 'cdata', name: 'pageSource', body: ['<px:PXFormView ID="form" runat="server" DataMember="Document">', '    <Template>', '        <px:PXTextEdit ID="edUsrRoute" runat="server" DataField="UsrRoute" />', '    </Template>', '</px:PXFormView>'] });
    add(path, 'screens', screen, title, { tag: 'Page', attrs: [['path', path], ['ScreenTitle', title]], parts });
  }
  // Tables, with a duplicate identity (SOLine twice).
  for (let i = 0; i < 20; i++) {
    const t = i === 0 || i === 13 ? 'SOLine' : `${rng.pick(DACS)}${rng.pick(WORDS)}${i}`;
    const n = rng.int(2, 14);
    add(t, 'tables', t, `${n} columns`, { tag: 'Table', attrs: [['TableName', t]], parts: [{ kind: 'lines', lines: columns(rng, t, n, `T${i}`) }] });
  }
  // Sql, one body containing "]]>" in a comment.
  for (let i = 0; i < 7; i++) {
    const t = `Usr${rng.pick(WORDS)}History${i}`;
    const body = sqlBody(rng, t, rng.int(4, 20));
    if (i === 2) body.splice(1, 0, '-- the export splits a literal ]]> like this one');
    add(t, 'sql', t, null, { tag: 'Sql', attrs: [['TableName', t], ['TableSchemaXml', '#CDATA']], parts: [{ kind: 'cdata', name: 'Script', body }] });
  }
  // Reports (CDATA XML).
  for (let i = 0; i < 4; i++) {
    const r = `SO64${1000 + i * 10}.rpx`;
    add(r, 'reports', r, null, { tag: 'Report', attrs: [['ReportName', r]], parts: [{ kind: 'cdata', name: 'Xml', body: reportBody(rng, r, rng.int(10, 40)) }] });
  }
  // Site map nodes (identity: descendant ScreenID).
  for (let i = 0; i < 7; i++) {
    const screen = `${rng.pick(MODS).toUpperCase()}${rng.int(100000, 509999)}`;
    const row = `<row Position="${rng.int(1, 900)}" Title="${rng.pick(WORDS)} ${rng.pick(WORDS)}" Url="~/Pages/${screen.slice(0, 2)}/${screen}.aspx" ScreenID="${screen}" NodeID="${guid(rng)}" ParentID="${guid(rng)}" />`;
    add(screen, 'sitemap', screen, null, { tag: 'SiteMapNode', attrs: [], parts: [{ kind: 'lines', lines: dataSet('SiteMap', [row]) }] });
  }
  // Generic inquiries with nested rows (identity: descendant Name).
  for (let i = 0; i < 5; i++) {
    const name = `CT-${rng.pick(WORDS)}${rng.pick(WORDS)}${i}`;
    const id = guid(rng);
    const rows = [
      `<GIDesign DesignID="${id}" Name="${name}" FilterColCount="3" PageSize="0" ExportTop="0" NewRecordCreationEnabled="False">`,
      ...Array.from({ length: rng.int(2, 6) }, (_, k) => `    <GITable DesignID="${id}" Alias="${rng.pick(DACS)}${k}" Name="PX.Objects.SO.${rng.pick(DACS)}" />`),
      ...Array.from({ length: rng.int(3, 10) }, (_, k) => `    <GIResult DesignID="${id}" LineNbr="${k + 1}" ObjectName="${rng.pick(DACS)}" Field="${rng.pick(WORDS).toLowerCase()}Nbr" IsVisible="True" />`),
      '</GIDesign>',
    ];
    add(name, 'inquiries', name, null, { tag: 'GenericInquiryScreen', attrs: [], parts: [{ kind: 'lines', lines: dataSet('GIDesign', rows) }] });
  }
  // Web service endpoints.
  for (let i = 0; i < 2; i++) {
    const nm = `ContosoEndpoint${i + 1}`;
    const lines = [
      `    <Endpoint xmlns="http://www.acumatica.com/entity/maintenance/5.31" name="${nm}" version="23.200.00${i + 1}" systemContractVersion="4">`,
      ...Array.from({ length: rng.int(4, 12) }, (_, k) => `        <TopLevelEntity name="${rng.pick(WORDS)}${k}" screen="${rng.pick(MODS).toUpperCase()}${rng.int(100000, 509999)}" />`),
      '    </Endpoint>',
    ];
    add(nm, 'integration', nm, null, { tag: 'EntityEndpoint', attrs: [['Name', nm], ['Version', `23.200.00${i + 1}`]], parts: [{ kind: 'lines', lines }] });
  }
  // Unknown elements: land in "other" with detail = element name.
  for (let i = 0; i < 2; i++) {
    const nm = `${rng.pick(MODS).toUpperCase()}${rng.int(100000, 509999)}`;
    add(nm, 'other', nm, 'MobileSiteMapNode', {
      tag: 'MobileSiteMapNode',
      attrs: [['Name', nm]],
      parts: [{ kind: 'lines', lines: [`    <Screen Id="${nm}" Type="SimpleScreen" DisplayName="${rng.pick(WORDS)}" Icon="system://Box" />`] }],
    });
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
  const edits: Record<string, string[]> = { onlyA: [], onlyB: [], modified: [], whitespace: [], moved: [] };
  const by = (group: ProjectGroup, tag?: string): Item[] => items.filter((it) => it.group === group && (!tag || it.a?.tag === tag || it.b?.tag === tag));
  const pick = (list: Item[], i: number): Item => {
    const it = list[i];
    if (!it) throw new Error(`no item ${i}`);
    return it;
  };
  const graphs = by('code', 'Graph');
  const csFiles = by('code', 'File');
  const pages = by('screens');
  const tables = by('tables');

  // Only in A.
  for (const it of [pick(graphs, 5), pick(pages, 3), pick(tables, 4), pick(csFiles, 2), pick(by('sitemap'), 1), pick(by('other'), 1)]) {
    it.b = null;
    edits.onlyA?.push(it.key);
  }
  // Modified code (single-token C# changes) and other content changes.
  for (const i of [0, 1, 2, 8, 9, 15, 21, 30]) {
    const it = pick(graphs, i);
    if (it.b) editCode(it.b, rng, 'csToken', rng.int(1, 4));
    edits.modified?.push(it.key);
  }
  for (const i of [0, 7]) {
    const it = pick(csFiles, i);
    if (it.b) editCode(it.b, rng, 'csToken', 2);
    edits.modified?.push(it.key);
  }
  const mod = (it: Item, f: (el: El) => void): void => {
    if (!it.b) throw new Error(`${it.key} has no B`);
    f(it.b);
    edits.modified?.push(it.key);
  };
  mod(pick(pages, 1), (el) => setAttr(el, 'ScreenTitle', `${attr(el, 'ScreenTitle') ?? ''} (v2)`));
  mod(pick(pages, 7), (el) => {
    const c = cdatas(el)[0];
    if (c) c.body.splice(3, 0, '        <px:PXCheckBox ID="chkUsrRush" runat="server" DataField="UsrRush" />');
  });
  mod(pick(tables, 6), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines.push('    <Column TableName="X" ColumnName="UsrAddedInB" ColumnType="bit" AllowNull="True" IsNewColumn="True" />'.replace('"X"', `"${attr(el, 'TableName') ?? ''}"`));
  });
  // The second SOLine (duplicate identity) changes; the first does not.
  mod(pick(tables, 13), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines.pop();
  });
  mod(pick(by('sql'), 1), (el) => {
    const c = cdatas(el)[0];
    if (c) c.body.splice(5, 0, '    [UsrAddedInB] NVARCHAR(30) NULL,');
  });
  mod(pick(by('reports'), 0), (el) => {
    const c = cdatas(el)[0];
    if (c) c.body[1] = (c.body[1] ?? '').replace('">', '" Landscape="True">');
  });
  mod(pick(by('sitemap'), 2), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines = p.lines.map((l) => l.replace(/Title="([^"]*)"/, 'Title="$1 Renamed"'));
  });
  mod(pick(by('inquiries'), 0), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') {
      const at = p.lines.findIndex((l) => l.includes('</GIDesign>'));
      p.lines.splice(at, 0, '                    <GIResult DesignID="added" LineNbr="99" ObjectName="SOOrder" Field="orderTotal" IsVisible="True" />');
    }
  });
  mod(pick(by('integration'), 0), (el) => {
    const p = el.parts[0];
    if (p?.kind === 'lines') p.lines.splice(1, 1);
  });
  mod(pick(by('files'), 0), (el) => {
    const c = cdatas(el)[0];
    if (c) c.body[2] = (c.body[2] ?? '').replace('PrimaryView="Document"', 'PrimaryView="CurrentDocument"');
  });

  // Whitespace-only.
  for (const i of [3, 4]) {
    const it = pick(graphs, i);
    if (it.b) editCode(it.b, rng, 'whitespace', 3);
    edits.whitespace?.push(it.key);
  }
  {
    const it = pick(tables, 2);
    const p = it.b?.parts[0];
    if (p?.kind === 'lines') p.lines[0] = `  ${p.lines[0] ?? ''}`;
    edits.whitespace?.push(it.key);
  }
  {
    const it = pick(csFiles, 5);
    const c = it.b ? cdatas(it.b)[0] : undefined;
    if (c) c.body[c.body.length - 3] = `${c.body[c.body.length - 3] ?? ''}   `;
    edits.whitespace?.push(it.key);
  }

  // The CDATA split: a Graph whose C# contains "]]>" on both sides.
  const split = pick(graphs, 6);
  const splitLine = '            if (lines[idx[0]]> 0) return; // indexer of an indexer';
  for (const el of [split.a, split.b]) {
    const c = el ? cdatas(el)[0] : undefined;
    if (c) c.body.splice(Math.floor(c.body.length / 2), 0, splitLine);
  }

  // Only in B (appended in B order below).
  const newGraph = 'SOOrderExt_AddedInB';
  const added: Item[] = [
    { key: newGraph, group: 'code', name: newGraph, detail: 'New DAC', a: null, b: { tag: 'Graph', attrs: [['ClassName', newGraph], ['Source', '#CDATA'], ['IsNew', 'True'], ['FileType', 'NewDac']], parts: [{ kind: 'cdata', name: 'Source', body: csharpUnit(PROJECT_SEED + 9001, 120) }] } },
    { key: 'UsrRouteAudit', group: 'sql', name: 'UsrRouteAudit', detail: null, a: null, b: { tag: 'Sql', attrs: [['TableName', 'UsrRouteAudit'], ['TableSchemaXml', '#CDATA']], parts: [{ kind: 'cdata', name: 'Script', body: sqlBody(rng, 'UsrRouteAudit', 6) }] } },
    { key: 'SO509999', group: 'sitemap', name: 'SO509999', detail: null, a: null, b: { tag: 'SiteMapNode', attrs: [], parts: [{ kind: 'lines', lines: dataSet('SiteMap', [`<row Position="12" Title="Route Audit" Url="~/Pages/SO/SO509999.aspx" ScreenID="SO509999" NodeID="${guid(rng)}" ParentID="${guid(rng)}" />`]) }] } },
    { key: 'fr-FR', group: 'other', name: 'fr-FR', detail: 'Locale', a: null, b: { tag: 'Locale', attrs: [['Name', 'fr-FR'], ['IsActive', 'True']], parts: [{ kind: 'lines', lines: ['    <Translation Source="Route" Target="Itinéraire" />'] }] } },
  ];
  items.push(...added);
  edits.onlyB?.push(...added.map((it) => it.key));

  // Order: A in build order; B moves one Table and one Graph to new places.
  const orderA = items.filter((it) => it.a);
  const orderB = items.filter((it) => it.b && !added.includes(it));
  const moveTable = pick(tables, 8);
  const moveGraph = pick(graphs, 20);
  const move = (list: Item[], it: Item, to: number): void => {
    list.splice(list.indexOf(it), 1);
    list.splice(to, 0, it);
  };
  move(orderB, moveTable, orderB.length);
  move(orderB, moveGraph, 3);
  edits.moved?.push(moveTable.key, moveGraph.key);
  orderB.splice(40, 0, added[0] as Item);
  orderB.splice(orderB.length - 10, 0, ...added.slice(1));

  const rootA: Record<string, string> = { level: '0', description: 'Contoso order management (customer copy)', 'product-version': '24.200.0001' };
  const rootB: Record<string, string> = { ...rootA, 'product-version': '25.100.0119', description: 'Contoso order management (dev)' };

  const ranges = new Map<Item, { a?: { startLine: number; endLine: number }; b?: { startLine: number; endLine: number } }>();
  const doc = (order: Item[], side: 'a' | 'b', root: Record<string, string>): string => {
    const rootAttrs = Object.entries(root).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    const out = ['<?xml version="1.0" encoding="utf-8"?>', `<Customization${rootAttrs}>`];
    order.forEach((it, i) => {
      if (i === 10) out.push('<!-- items below were merged from the 24R1 project -->');
      const el = it[side];
      if (!el) return;
      const start = out.length + 1;
      out.push(...render(el));
      const r = ranges.get(it) ?? {};
      r[side] = { startLine: start, endLine: out.length };
      ranges.set(it, r);
    });
    out.push('</Customization>');
    return out.join('\n') + '\n';
  };
  const a = doc(orderA, 'a', rootA);
  const b = doc(orderB, 'b', rootB);

  // Ids: `${element}:${key}`, duplicates get #2, #3 in document order (per side; A and B agree here).
  const seen = new Map<string, number>();
  const expected: ExpectedItem[] = items.map((it) => {
    const el = (it.a ?? it.b) as El;
    const base = `${el.tag}:${it.key}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const views: ('code' | 'xml')[] = cdatas(el).length ? ['code', 'xml'] : ['xml'];
    const r = ranges.get(it) ?? {};
    return {
      id: n === 1 ? base : `${base}#${n}`,
      element: el.tag,
      key: it.key,
      group: it.group,
      name: it.name,
      detail: it.detail,
      status: status(it.a, it.b),
      views,
      a: r.a ?? null,
      b: r.b ?? null,
    };
  });
  expected.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id));

  const byStatus: Record<ItemStatus, number> = { same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 };
  const byGroup: Partial<Record<ProjectGroup, number>> = {};
  for (const e of expected) {
    byStatus[e.status]++;
    byGroup[e.group] = (byGroup[e.group] ?? 0) + 1;
  }
  const splitId = expected.find((e) => e.key === split.key)?.id ?? '';
  return { a, b, root: { a: rootA, b: rootB }, items: expected, counts: { total: expected.length, byStatus, byGroup }, cdataSplit: { id: splitId, mustContain: 'idx[0]]> 0' }, edits };
}

let cached: ProjectPair | undefined;
/** The project pair. Deterministic; cached because tests call it repeatedly. */
export function generateProjectPair(): ProjectPair {
  return (cached ??= buildPair());
}
