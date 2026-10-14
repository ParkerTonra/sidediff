// Deterministic generator for Acumatica-shaped customization XML and C#
// fixture pairs. Pure: no file system access, so unit tests can call it.
//
// The A side is built line by line with flags saying which edit kinds each
// line can take. The B side applies scattered single-line edits (spaced so
// they never merge into one hunk) plus one block insert, one block delete and
// one moved element, and the expected stats are derived by construction.

import { createRng } from './rng.ts';
import type { Rng } from './rng.ts';
import { countHunks } from './diff-stats.ts';
import type { CountedStats, Hunk } from './diff-stats.ts';

export type FixtureKind = 'xml' | 'cs';

export interface FixtureSpec {
  name: string;
  kind: FixtureKind;
  /** Approximate line count of the A side. */
  targetLines: number;
  seed: number;
}

export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  { name: 'small', kind: 'xml', targetLines: 2_000, seed: 0x5d1f_0001 },
  { name: 'medium', kind: 'xml', targetLines: 30_000, seed: 0x5d1f_0002 },
  { name: 'large', kind: 'xml', targetLines: 150_000, seed: 0x5d1f_0003 },
  { name: 'stress', kind: 'xml', targetLines: 500_000, seed: 0x5d1f_0004 },
  { name: 'csharp-large', kind: 'cs', targetLines: 150_000, seed: 0x5d1f_0005 },
];

// Line flags: which single-line edits a line can take.
const ATTR = 1; // has an attribute value (XML) or string literal (C#) to change
const REORDER = 2; // has two or more attributes / named arguments to swap
const TOKEN = 4; // C# line with an identifier or operator to change
const WS = 8; // has enough content for a leading/trailing whitespace edit
const CS = 16; // the line is C# source (in a .cs file or inside CDATA)

type Range = [start: number, end: number]; // [start, end) line indices

interface Builder {
  lines: string[];
  flags: number[];
  /** Self-contained ranges that can be moved elsewhere. */
  movables: Range[];
  /** Indices before which a movable can be inserted. */
  boundaries: number[];
  /** Free-text ranges (CDATA bodies, class bodies) safe for block insert/delete. */
  regions: Range[];
}

const newBuilder = (): Builder => ({ lines: [], flags: [], movables: [], boundaries: [], regions: [] });

const XML_ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const CS_LITERAL_RE = /"([^"\\]+)"/g;
const CS_NAMED_ARG_RE = /\b\w+ = (?:"[^"]*"|[\w.]+)/g;
const CS_IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;
const CS_KEYWORDS = new Set(
  ('abstract as base bool break case catch class const continue decimal default delegate do double else enum event ' +
    'explicit false finally for foreach get if implicit in int interface internal is let lock long namespace new null ' +
    'object operator out override params private protected public readonly ref return sealed set short static string ' +
    'struct switch this throw true try typeof uint ulong unchecked unsafe using var virtual void volatile where while ' +
    'select from orderby descending ascending not region endregion')
    .split(' '),
);

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s)) n++;
  return n;
}

function flagsFor(text: string, mode: 'xml' | 'cs' | 'none'): number {
  if (mode === 'none') return 0;
  const trimmed = text.trim();
  let f = 0;
  if (trimmed.length >= 10) f |= WS;
  if (mode === 'xml') {
    const attrs = countMatches(XML_ATTR_RE, text);
    if (attrs >= 1) f |= ATTR;
    if (attrs >= 2 && trimmed.startsWith('<') && !trimmed.startsWith('</')) f |= REORDER;
    return f;
  }
  f |= CS;
  if (trimmed.startsWith('//')) return f;
  if (countMatches(CS_LITERAL_RE, text) >= 1) f |= ATTR;
  if (trimmed.startsWith('[') && countMatches(CS_NAMED_ARG_RE, text) >= 2) f |= REORDER;
  if (trimmed.length >= 12 && /[A-Za-z]/.test(trimmed)) f |= TOKEN;
  return f;
}

function push(b: Builder, text: string, mode: 'xml' | 'cs' | 'none'): void {
  b.lines.push(text);
  b.flags.push(flagsFor(text, mode));
}

// ---------------------------------------------------------------- vocabulary

const WORDS = [
  'Order', 'Customer', 'Inventory', 'Vendor', 'Shipment', 'Line', 'Qty', 'Amount', 'Status', 'Branch',
  'Warehouse', 'Location', 'Lot', 'Serial', 'Project', 'Task', 'Cost', 'Price', 'Discount', 'Tax',
  'Freight', 'Margin', 'Rebate', 'Contract', 'Approval', 'Credit', 'Batch', 'Route', 'Carrier', 'Region',
  'Unit', 'Weight', 'Volume', 'Commission', 'Allocation', 'Reserve', 'Backorder', 'Promise', 'Due', 'Ship',
];
const DACS = ['SOOrder', 'SOLine', 'POOrder', 'POLine', 'ARInvoice', 'APInvoice', 'INTran', 'InventoryItem', 'BAccount', 'PMTask', 'SOShipment', 'CRCase'];
const GRAPHS = ['SOOrderEntry', 'POOrderEntry', 'ARInvoiceEntry', 'APInvoiceEntry', 'INReceiptEntry', 'InventoryItemMaint', 'CustomerMaint', 'ProjectEntry', 'SOShipmentEntry', 'CRCaseMaint'];
const MODULES = ['so', 'po', 'ar', 'ap', 'in', 'pm', 'cr', 'gl'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

interface Names {
  rng: Rng;
  counter: number;
}

function ident(n: Names, parts = 2): string {
  let s = '';
  for (let i = 0; i < parts; i++) s += n.rng.pick(WORDS);
  n.counter++;
  return `${s}${n.counter.toString(36)}`;
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const display = (s: string): string => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[0-9a-z]+$/, (m) => m.replace(/\d.*$/, ''));

function base64(rng: Rng, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += B64.charAt(Math.floor(rng.next() * 64));
  const pad = len % 4;
  return pad === 0 ? s : s.slice(0, len - pad) + '='.repeat(4 - pad);
}

// ---------------------------------------------------------------- C# source

const I1 = '    ';
const I2 = I1 + I1;
const I3 = I2 + I1;
const I4 = I3 + I1;
const I5 = I4 + I1;

/** One graph-extension member (method, action, view), as lines. */
function graphMember(n: Names, dac: string, graph: string): string[] {
  const { rng } = n;
  const name = ident(n);
  const p1 = ident(n, 1);
  const p2 = ident(n, 1);
  const p3 = ident(n, 1);
  const k = rng.int(1, 999);
  switch (rng.int(0, 5)) {
    case 0:
      return [
        `${I2}protected virtual void _(Events.FieldUpdated<${dac}, ${dac}.${lower(p1)}> e)`,
        `${I2}{`,
        `${I3}var row = e.Row;`,
        `${I3}if (row == null || row.${p1} == null) return;`,
        `${I3}var ext = row.GetExtension<${dac}Ext>();`,
        `${I3}decimal? total${name} = Base.Transactions.Select().RowCast<${dac}>()`,
        `${I4}.Where(l => l.${p2} != null && l.${p3} > ${k}m)`,
        `${I4}.Sum(l => l.Cury${p1}Amt ?? 0m);`,
        `${I3}ext.Usr${name} = total${name} * ${rng.int(2, 9)};`,
        `${I3}e.Cache.SetValueExt<${dac}Ext.usr${name}>(row, ext.Usr${name});`,
        `${I2}}`,
        '',
      ];
    case 1:
      return [
        `${I2}public PXAction<${dac}> ${lower(name)};`,
        `${I2}[PXButton(CommitChanges = true, Category = "${rng.pick(WORDS)} Processing")]`,
        `${I2}[PXUIField(DisplayName = "${display(name)}", MapEnableRights = PXCacheRights.Update, MapViewRights = PXCacheRights.Select)]`,
        `${I2}protected virtual IEnumerable ${name}(PXAdapter adapter)`,
        `${I2}{`,
        `${I3}var docs${k} = adapter.Get<${dac}>().ToList();`,
        `${I3}PXLongOperation.StartOperation(Base, () =>`,
        `${I3}{`,
        `${I4}foreach (var doc in docs${k})`,
        `${I4}{`,
        `${I5}var graph = PXGraph.CreateInstance<${graph}>();`,
        `${I5}graph.Document.Current = graph.Document.Search<${dac}.${lower(p1)}>(doc.${p1});`,
        `${I5}graph.Actions.PressSave();`,
        `${I4}}`,
        `${I3}});`,
        `${I3}return docs${k};`,
        `${I2}}`,
        '',
      ];
    case 2:
      return [
        `${I2}public virtual IEnumerable<${dac}> Get${name}Rows(int? ${lower(p1)}ID, decimal minimum${k})`,
        `${I2}{`,
        `${I3}var query = from line in PXSelect<${dac}, Where<${dac}.${lower(p1)}ID, Equal<Required<${dac}.${lower(p1)}ID>>>>.Select(Base, ${lower(p1)}ID)`,
        `${I4}let item = (${dac})line`,
        `${I4}where item.${p2} > minimum${k} && item.${p3} != null`,
        `${I4}orderby item.${p2} descending`,
        `${I4}select item;`,
        `${I3}return query.Take(${rng.int(5, 500)}).ToList();`,
        `${I2}}`,
        '',
      ];
    case 3:
      return [
        `${I2}public delegate void Persist${name}Delegate();`,
        `${I2}[PXOverride]`,
        `${I2}public void Persist(Persist${name}Delegate baseMethod)`,
        `${I2}{`,
        `${I3}using (var ts = new PXTransactionScope())`,
        `${I3}{`,
        `${I4}baseMethod();`,
        `${I4}foreach (${dac} row in Base.Caches[typeof(${dac})].Updated)`,
        `${I4}{`,
        `${I5}PXTrace.WriteInformation("${display(name)} updated {0}", row.${p1});`,
        `${I4}}`,
        `${I4}ts.Complete();`,
        `${I3}}`,
        `${I2}}`,
        '',
      ];
    case 4:
      return [
        `${I2}protected virtual void _(Events.RowSelected<${dac}> e, PXRowSelected baseHandler)`,
        `${I2}{`,
        `${I3}baseHandler?.Invoke(e.Cache, e.Args);`,
        `${I3}if (e.Row is not ${dac} row) return;`,
        `${I3}bool is${name} = row.Status == "${rng.pick(['N', 'H', 'C', 'R', 'O'])}";`,
        `${I3}PXUIFieldAttribute.SetEnabled<${dac}Ext.usr${p1}>(e.Cache, row, is${name});`,
        `${I3}PXUIFieldAttribute.SetVisible<${dac}Ext.usr${p2}>(e.Cache, row, !is${name} && row.Hold != true);`,
        `${I2}}`,
        '',
      ];
    default:
      return [
        `${I2}public SelectFrom<${dac}>.Where<${dac}.${lower(p1)}.IsEqual<${dac}.${lower(p1)}.FromCurrent>.And<${dac}.${lower(p2)}.IsGreater<@P.AsDecimal>>>.View Usr${name}View;`,
        '',
      ];
  }
}

/** One DAC-extension field, as lines. */
function dacField(n: Names): string[] {
  const { rng } = n;
  const name = ident(n);
  const type = rng.pick([
    ['String', 'string', `PXDBString(${rng.int(1, 255)}, IsUnicode = true, InputMask = "")`, '""'],
    ['Decimal', 'decimal', `PXDBDecimal(${rng.int(0, 6)})`, 'TypeCode.Decimal, "0.0"'],
    ['Bool', 'bool', 'PXDBBool', 'false'],
    ['Int', 'int', 'PXDBInt', `${rng.int(0, 100)}`],
  ] as const);
  return [
    `${I2}#region Usr${name}`,
    `${I2}[${type[2]}]`,
    `${I2}[PXUIField(DisplayName = "${display(name)}", Visibility = PXUIVisibility.${rng.pick(['Visible', 'SelectorVisible'])}, Enabled = ${rng.chance(0.5)})]`,
    `${I2}[PXDefault(${type[3]}, PersistingCheck = PXPersistingCheck.Nothing)]`,
    `${I2}public virtual ${type[1]}? Usr${name} { get; set; }`,
    `${I2}public abstract class usr${name} : PX.Data.BQL.Bql${type[0]}.Field<usr${name}> { }`,
    `${I2}#endregion`,
    '',
  ];
}

const USINGS = [
  'using System;',
  'using System.Collections;',
  'using System.Collections.Generic;',
  'using System.Linq;',
  'using PX.Data;',
  'using PX.Data.BQL;',
  'using PX.Data.BQL.Fluent;',
  'using PX.Objects.CS;',
  'using PX.Objects.SO;',
  'using PX.Objects.IN;',
];

/**
 * Emits one C# compilation unit (namespace + one extension class) of about
 * `target` lines. Members are recorded as movables and boundaries when
 * `trackMembers` (the pure C# fixture); otherwise only the body region is kept.
 */
function emitCSharpUnit(b: Builder, n: Names, target: number, withUsings: boolean, trackMembers: boolean): void {
  const { rng } = n;
  const start = b.lines.length;
  const isGraph = rng.chance(0.55);
  const dac = rng.pick(DACS);
  const graph = rng.pick(GRAPHS);
  if (withUsings) {
    for (const u of USINGS) push(b, u, 'cs');
    push(b, '', 'cs');
  }
  push(b, `namespace Contoso.Customizations.${rng.pick(MODULES).toUpperCase()}${n.counter++}`, 'cs');
  push(b, '{', 'cs');
  const cls = isGraph ? `${graph}_${ident(n, 1)}Ext` : `${dac}Ext_${ident(n, 1)}`;
  push(b, isGraph ? `${I1}public class ${cls} : PXGraphExtension<${graph}>` : `${I1}public sealed class ${cls} : PXCacheExtension<${dac}>`, 'cs');
  push(b, `${I1}{`, 'cs');
  push(b, `${I2}public static bool IsActive() => PXAccess.FeatureInstalled<FeaturesSet.${lower(ident(n, 1))}>();`, 'cs');
  push(b, '', 'cs');
  const bodyStart = b.lines.length;
  while (b.lines.length - start < target - 3) {
    const member = isGraph ? graphMember(n, dac, graph) : dacField(n);
    const ms = b.lines.length;
    if (trackMembers) b.boundaries.push(ms);
    for (const line of member) push(b, line, 'cs');
    if (trackMembers) b.movables.push([ms, b.lines.length]);
  }
  b.regions.push([bodyStart, b.lines.length]);
  push(b, `${I1}}`, 'cs');
  push(b, '}', 'cs');
}

// ---------------------------------------------------------------- XML elements

function emitCdata(b: Builder, n: Names, cdataName: string, target: number): void {
  const inner = newBuilder();
  emitCSharpUnit(inner, n, target, true, false);
  const first = inner.lines[0] ?? '';
  push(b, `    <CDATA name="${cdataName}"><![CDATA[${first}`, 'none');
  const offset = b.lines.length - 1;
  for (let i = 1; i < inner.lines.length; i++) {
    b.lines.push(inner.lines[i] ?? '');
    b.flags.push(inner.flags[i] ?? 0);
  }
  b.regions.push([offset + 1, b.lines.length]);
  push(b, ']]></CDATA>', 'none');
}

function emitGraph(b: Builder, n: Names): void {
  const graph = n.rng.pick(GRAPHS);
  push(b, `<Graph ClassName="${graph}" Source="#CDATA" IsNew="${n.rng.chance(0.3) ? 'True' : 'False'}" FileType="ExistingGraph">`, 'xml');
  emitCdata(b, n, 'Source', n.rng.int(55, 380)); // members overshoot by <= 20 lines
  push(b, '</Graph>', 'xml');
}

function emitFile(b: Builder, n: Names): void {
  const name = ident(n, 1);
  push(b, `<File AppRelativePath="App_Code\\Caches\\${name}.cs" FileType="CSharp" Description="${display(name)} extension">`, 'xml');
  emitCdata(b, n, 'Content', n.rng.int(55, 380)); // members overshoot by <= 20 lines
  push(b, '</File>', 'xml');
}

function emitTable(b: Builder, n: Names): void {
  const { rng } = n;
  const dac = rng.pick(DACS);
  push(b, `<Table TableName="${dac}">`, 'xml');
  const cols = rng.int(2, 12);
  for (let i = 0; i < cols; i++) {
    const t = rng.pick(['nvarchar', 'decimal', 'int', 'bit', 'datetime']);
    const extra = t === 'nvarchar' ? ` MaxLength="${rng.int(1, 255)}" IsUnicode="True"` : t === 'decimal' ? ` DecimalPrecision="${rng.int(0, 6)}" DecimalLength="${rng.int(10, 19)}"` : '';
    push(b, `    <Column TableName="${dac}" ColumnName="Usr${ident(n)}" ColumnType="${t}"${extra} AllowNull="True" IsNewColumn="True" />`, 'xml');
  }
  push(b, '</Table>', 'xml');
}

function emitPage(b: Builder, n: Names): void {
  const { rng } = n;
  const mod = rng.pick(MODULES);
  const screen = `${mod.toUpperCase()}${rng.int(100000, 509999)}`;
  const title = display(ident(n));
  // 500+ character attribute line with a base64-looking pageSource.
  push(
    b,
    `<Page path="~/pages/${mod}/${screen.toLowerCase()}.aspx" ScreenID="${screen}" ScreenTitle="${title}" Description="Customized ${title} screen" pageSource="${base64(rng, rng.int(420, 900))}">`,
    'xml',
  );
  const fields = rng.int(1, 6);
  for (let i = 0; i < fields; i++) {
    push(
      b,
      `    <PXField DataMember="${rng.pick(DACS)}" DataField="Usr${ident(n)}" CommitChanges="${rng.chance(0.5) ? 'True' : 'False'}" LabelWidth="${rng.int(80, 200)}" ControlSize="${rng.pick(['XS', 'S', 'SM', 'M', 'XM', 'L'])}" />`,
      'xml',
    );
  }
  if (rng.chance(0.7)) push(b, `    <Content encoding="base64">${base64(rng, rng.int(600, 3200))}</Content>`, 'xml');
  push(b, '</Page>', 'xml');
}

function buildXml(n: Names, target: number): Builder {
  const b = newBuilder();
  push(b, '<?xml version="1.0" encoding="utf-8"?>', 'none');
  push(b, `<Customization level="100" description="SideDiff fixture ${n.counter} generated customization project" product-version="24.200.0000">`, 'none');
  const smallPages = target < 5_000;
  while (b.lines.length < target - 1) {
    const roll = n.rng.next();
    const start = b.lines.length;
    b.boundaries.push(start);
    if (roll < 0.17) emitGraph(b, n);
    else if (roll < 0.36) emitFile(b, n);
    else if (roll < 0.62 || smallPages) emitTable(b, n);
    else emitPage(b, n);
    if (b.lines[start]?.startsWith('<Table') || b.lines[start]?.startsWith('<Page')) b.movables.push([start, b.lines.length]);
  }
  b.boundaries.push(b.lines.length);
  push(b, '</Customization>', 'none');
  return b;
}

function buildCs(n: Names, target: number): Builder {
  const b = newBuilder();
  for (const u of USINGS) push(b, u, 'cs');
  push(b, '', 'cs');
  while (b.lines.length < target) emitCSharpUnit(b, n, n.rng.int(150, 900), false, true);
  return b;
}

// ---------------------------------------------------------------- edits

export type EditKind = 'attrValue' | 'csToken' | 'whitespace' | 'attrReorder';

function swapTwo(line: string, re: RegExp, rng: Rng): string | null {
  re.lastIndex = 0;
  const ms: { i: number; s: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) ms.push({ i: m.index, s: m[0] });
  if (ms.length < 2) return null;
  const k = rng.int(0, ms.length - 2);
  const x = ms[k];
  const y = ms[k + 1];
  if (!x || !y || x.s === y.s) return null;
  return line.slice(0, x.i) + y.s + line.slice(x.i + x.s.length, y.i) + x.s + line.slice(y.i + y.s.length);
}

function mutateValue(v: string): string {
  if (/^\d+$/.test(v)) return String(Number(v) + 1);
  if (v === 'True') return 'False';
  if (v === 'False') return 'True';
  const last = v.charAt(v.length - 1);
  if (/\d/.test(last)) return v.slice(0, -1) + String((Number(last) + 1) % 10);
  return v + 'X';
}

function replaceNth(line: string, re: RegExp, pick: (count: number) => number, f: (m: RegExpExecArray) => string): string | null {
  re.lastIndex = 0;
  const ms: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) ms.push(m);
  if (ms.length === 0) return null;
  const hit = ms[pick(ms.length)];
  if (!hit) return null;
  return line.slice(0, hit.index) + f(hit) + line.slice(hit.index + hit[0].length);
}

function editLine(kind: EditKind, line: string, isXml: boolean, rng: Rng): string | null {
  const nth = (count: number): number => rng.int(0, count - 1);
  switch (kind) {
    case 'attrValue':
      return isXml
        ? replaceNth(line, XML_ATTR_RE, nth, (m) => `${m[1]}="${mutateValue(m[2] ?? '')}"`)
        : replaceNth(line, CS_LITERAL_RE, nth, (m) => `"${mutateValue(m[1] ?? '')}"`);
    case 'attrReorder':
      return swapTwo(line, isXml ? / [\w:-]+="[^"]*"/g : CS_NAMED_ARG_RE, rng);
    case 'whitespace': {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      const body = line.slice(indent.length);
      const op = rng.int(0, 3);
      if (op === 0) return `${indent}    ${body}`;
      if (op === 1 && indent.length >= 2) return indent.slice(2) + body;
      if (op === 2 && indent.startsWith('    ')) return `\t${indent.slice(4)}${body}`;
      return `${line}  `;
    }
    case 'csToken': {
      const r = rng.int(0, 3);
      if (r === 0 && line.includes(' == ')) return line.replace(' == ', ' != ');
      if (r === 0 && line.includes(' != ')) return line.replace(' != ', ' == ');
      if (r === 1 && line.includes(' && ')) return line.replace(' && ', ' || ');
      if (r === 2 && /\b\d+m?\b/.test(line)) return replaceNth(line, /\b(\d+)(m?)\b/g, nth, (m) => `${Number(m[1]) + 1}${m[2] ?? ''}`);
      if (r === 3 && / true\b/.test(line)) return line.replace(/ true\b/, ' false');
      // Rename one identifier (not a keyword, not inside a string literal).
      CS_IDENT_RE.lastIndex = 0;
      const idents: RegExpExecArray[] = [];
      let m: RegExpExecArray | null;
      const quoted = (i: number): boolean => (line.slice(0, i).match(/"/g)?.length ?? 0) % 2 === 1;
      while ((m = CS_IDENT_RE.exec(line))) if (!CS_KEYWORDS.has(m[0]) && !quoted(m.index)) idents.push(m);
      const hit = idents.length > 0 ? idents[nth(idents.length)] : undefined;
      if (!hit) return null;
      return `${line.slice(0, hit.index)}${hit[0]}Alt${line.slice(hit.index + hit[0].length)}`;
    }
  }
}

const KIND_FLAG: Record<EditKind, number> = { attrValue: ATTR, csToken: TOKEN, whitespace: WS, attrReorder: REORDER };
/** Share of the single-line edits that goes to each kind. */
const KIND_SHARE: Record<EditKind, number> = { attrValue: 0.3, csToken: 0.35, whitespace: 0.25, attrReorder: 0.1 };
// Rarest candidates first, so dense XML attribute lines are not used up by commoner kinds.
const EDIT_KINDS: readonly EditKind[] = ['attrReorder', 'attrValue', 'csToken', 'whitespace'];

/** Unchanged lines kept between any two edits so hunks never merge. */
export const EDIT_GAP = 12;
/** Share of lines that get a scattered single-line edit. */
export const SINGLE_EDIT_RATE = 0.015;

export interface ExpectedStats {
  trimWhitespace: CountedStats;
  noTrimWhitespace: CountedStats;
}

export interface FixtureEdits {
  attrValue: number;
  csToken: number;
  whitespace: number;
  attrReorder: number;
  blockInsert: { lines: number; beforeLineA: number };
  blockDelete: { lines: number; fromLineA: number };
  move: { lines: number; fromLineA: number; toBeforeLineA: number };
}

export interface GeneratedPair {
  spec: FixtureSpec;
  a: string;
  b: string;
  edits: FixtureEdits;
  /** Stats derived from the edit list (no diff algorithm involved). */
  constructed: ExpectedStats;
}

function insertedBlock(n: Names, lines: number, isXml: boolean): string[] {
  const b = newBuilder();
  // Members of a fresh class body; trimmed to the exact length.
  const dac = n.rng.pick(DACS);
  const graph = n.rng.pick(GRAPHS);
  while (b.lines.length < lines) {
    const member = n.rng.chance(0.5) ? graphMember(n, dac, graph) : dacField(n);
    for (const line of member) push(b, line, 'cs');
  }
  const out = b.lines.slice(0, lines);
  // A blank last line could slide the hunk; keep the block's edges non-blank and unique.
  out[0] = `${I2}// inserted block ${n.counter++}: ${isXml ? 'xml' : 'cs'}`;
  out[lines - 1] = `${I2}// end of inserted block ${n.counter++}`;
  return out;
}

/** Generates the A/B pair for a spec. Deterministic in `spec.seed`. */
export function generatePair(spec: FixtureSpec): GeneratedPair {
  const rng = createRng(spec.seed);
  const n: Names = { rng, counter: 0 };
  const isXml = spec.kind === 'xml';
  const doc = isXml ? buildXml(n, spec.targetLines) : buildCs(n, spec.targetLines);
  const N = doc.lines.length;
  const blockLines = Math.min(300, Math.floor(N / 20));

  // Occupancy: lines that may no longer take an edit.
  const busy = new Uint8Array(N + 1);
  const reserve = (s: number, e: number): void => {
    for (let i = Math.max(0, s - EDIT_GAP); i < Math.min(N + 1, e + EDIT_GAP); i++) busy[i] = 1;
  };
  const free = (s: number, e: number): boolean => {
    for (let i = Math.max(0, s - EDIT_GAP); i < Math.min(N + 1, e + EDIT_GAP); i++) if (busy[i]) return false;
    return true;
  };

  // Block delete: inside the largest region in the first half.
  const pickRegion = (lo: number, hi: number, min: number): Range => {
    const fits = doc.regions.filter(([s, e]) => s >= lo && e <= hi && e - s >= min);
    if (fits.length === 0) throw new Error(`${spec.name}: no region of ${min} lines in [${lo}, ${hi})`);
    return rng.pick(fits);
  };
  const delRegion = pickRegion(Math.floor(N * 0.15), Math.floor(N * 0.5), blockLines + 2 * EDIT_GAP);
  const delFrom = rng.int(delRegion[0] + EDIT_GAP, delRegion[1] - EDIT_GAP - blockLines);
  reserve(delFrom, delFrom + blockLines);

  // Block insert: inside a region in the second half.
  let insRegion: Range;
  do insRegion = pickRegion(Math.floor(N * 0.5), Math.floor(N * 0.85), 2 * EDIT_GAP + 2);
  while (!free(insRegion[0], insRegion[1]));
  const insBefore = rng.int(insRegion[0] + EDIT_GAP, insRegion[1] - EDIT_GAP);
  reserve(insBefore, insBefore);

  // Moved element: a small movable near the start goes near the end.
  const movables = doc.movables.filter(([s, e]) => e - s >= 3 && e - s <= 20 && s < N * 0.3 && free(s, e));
  const move = rng.pick(movables);
  const targets = doc.boundaries.filter((i) => i > N * 0.88 && free(i, i));
  const moveTo = rng.pick(targets);
  reserve(move[0], move[1]);
  reserve(moveTo, moveTo);

  // Scattered single-line edits.
  const replaced = new Map<number, string>();
  const totalSingles = Math.round(N * SINGLE_EDIT_RATE);
  const counts: Record<EditKind, number> = { attrValue: 0, csToken: 0, whitespace: 0, attrReorder: 0 };
  for (const kind of EDIT_KINDS) {
    const want = Math.max(1, Math.round(totalSingles * KIND_SHARE[kind]));
    const flag = KIND_FLAG[kind];
    const candidates: number[] = [];
    for (let i = 0; i < N; i++) if ((doc.flags[i] ?? 0) & flag) candidates.push(i);
    rng.shuffle(candidates);
    for (const i of candidates) {
      if (counts[kind] >= want) break;
      if (!free(i, i + 1)) continue;
      const before = doc.lines[i] ?? '';
      const after = editLine(kind, before, !((doc.flags[i] ?? 0) & CS), rng);
      if (after === null || after === before) continue;
      const wsOnly = after.trim() === before.trim();
      if (wsOnly !== (kind === 'whitespace')) continue;
      replaced.set(i, after);
      reserve(i, i + 1);
      counts[kind]++;
    }
  }

  // Assemble B.
  const inserted = insertedBlock(n, blockLines, isXml);
  const moved = doc.lines.slice(move[0], move[1]);
  const out: string[] = [];
  for (let i = 0; i <= N; i++) {
    if (i === insBefore) out.push(...inserted);
    if (i === moveTo) out.push(...moved);
    if (i === N) break;
    if (i >= delFrom && i < delFrom + blockLines) continue;
    if (i >= move[0] && i < move[1]) continue;
    out.push(replaced.get(i) ?? doc.lines[i] ?? '');
  }

  const moveLen = move[1] - move[0];
  const hardHunks: Hunk[] = [
    { a: 0, b: blockLines },
    { a: blockLines, b: 0 },
    { a: moveLen, b: 0 },
    { a: 0, b: moveLen },
  ];
  const visible = counts.attrValue + counts.csToken + counts.attrReorder;
  const one: Hunk = { a: 1, b: 1 };
  const constructed: ExpectedStats = {
    trimWhitespace: countHunks([...hardHunks, ...Array<Hunk>(visible).fill(one)]),
    noTrimWhitespace: countHunks([...hardHunks, ...Array<Hunk>(visible + counts.whitespace).fill(one)]),
  };

  return {
    spec,
    a: doc.lines.join('\n') + '\n',
    b: out.join('\n') + '\n',
    edits: {
      ...counts,
      blockInsert: { lines: blockLines, beforeLineA: insBefore + 1 },
      blockDelete: { lines: blockLines, fromLineA: delFrom + 1 },
      move: { lines: moveLen, fromLineA: move[0] + 1, toBeforeLineA: moveTo + 1 },
    },
    constructed,
  };
}
