import { existsSync, readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildIndex, compareTexts, inflateBase64, sliceViewText, type IndexedItem } from './build';
import { classify, GROUP_ORDER, RULES, screenIdFromPath, wantsFor } from './classify';
import { cdataBody, looksLikeProject, scanProject, type CdataSection } from './scan';
import { createProjectIndexer, type WorkerLike } from './index';
import type { IndexRequest, IndexResponse } from './protocol';

const BOM = String.fromCharCode(0xfeff);
const proj = (body: string, rootAttrs = 'level="100" product-version="24.200.0000"') =>
  `<?xml version="1.0" encoding="utf-8"?>\n<Customization ${rootAttrs}>\n${body}\n</Customization>\n`;

const graph = (cls: string, src: string, type = 'ExistingGraph') =>
  `<Graph ClassName="${cls}" Source="#CDATA" IsNew="True" FileType="${type}">\n    <CDATA name="Source"><![CDATA[${src}]]></CDATA>\n</Graph>`;

const deflate64 = (s: string): string => deflateRawSync(Buffer.from(s, 'utf8')).toString('base64');
const body = (text: string, s: CdataSection | undefined) => (s ? cdataBody(text, s) : undefined);

async function one(xml: string): Promise<IndexedItem & { text: string }> {
  const text = proj(xml);
  const idx = await buildIndex(text, '');
  expect(idx.sides.a.error).toBeUndefined();
  expect(idx.items).toHaveLength(1);
  return { ...(idx.items[0] as IndexedItem), text };
}
const view = async (it: IndexedItem & { text: string }, v: 'code' | 'xml') => (it.slices.a ? sliceViewText(it.text, it.slices.a, v) : null);

describe('scanner', () => {
  it('finds direct children with attrs, line ranges and CDATA', () => {
    const text = proj(`<!-- c -->\n${graph('SOOrderEntry', 'using X;\nclass A {}')}\n<?pi x?>\n<Table TableName="SOLine">\n  <Column ColumnName="UsrA" />\n</Table>`);
    const r = scanProject(text, wantsFor);
    expect(r.isProject).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.rootAttrs).toEqual({ level: '100', 'product-version': '24.200.0000' });
    expect(r.items.map((i) => [i.element, i.startLine, i.endLine, i.childCount])).toEqual([
      ['Graph', 4, 7, 0],
      ['Table', 9, 11, 1],
    ]);
    expect(body(text, r.items[0]?.cdata[0])).toBe('using X;\nclass A {}');
  });

  it('joins a CDATA body split around "]]>"', () => {
    const text = proj('<Graph ClassName="G"><CDATA name="Source"><![CDATA[var s = "a]]]]><![CDATA[>b";]]></CDATA></Graph>');
    const it0 = scanProject(text).items[0];
    expect(it0?.cdata).toHaveLength(1);
    expect(body(text, it0?.cdata[0])).toBe('var s = "a]]>b";');
  });

  it('collects a bare CDATA directly inside the item (split ones joined)', () => {
    const text = proj('<EditorUpdatedFields ScreenId="SO301000"><![CDATA[{"a":"]]]]><![CDATA[>"}]]></EditorUpdatedFields>');
    const it0 = scanProject(text).items[0];
    expect(it0?.cdata.map((c) => c.name)).toEqual(['']);
    expect(body(text, it0?.cdata[0])).toBe('{"a":"]]>"}');
  });

  it('real-export style: no XML header, CRLF, entities, > inside quoted values, self-closing items, BOM', () => {
    const text = `${BOM}<Customization level="0" description="x &amp; y">\r\n<Page path="~/pages/a&amp;b/x.aspx" ScreenTitle="A &gt; B &quot;q&quot; &#233;&#x41;" />\r\n<Table TableName="T" />\r\n</Customization>`;
    const r = scanProject(text);
    expect(r.rootAttrs.description).toBe('x & y');
    expect(r.items[0]?.attrs).toEqual({ path: '~/pages/a&b/x.aspx', ScreenTitle: 'A > B "q" éA' });
    expect(r.items.map((i) => i.startLine)).toEqual([2, 3]);
    expect(looksLikeProject(text)).toBe(true);
  });

  it.each([
    ['plain text', 'hello world'],
    ['C#', 'using System;\nnamespace X {}'],
    ['other XML root', '<?xml version="1.0"?><Project><Graph ClassName="X"/></Project>'],
    ['CustomizationX root', '<CustomizationX/>'],
    ['empty', ''],
  ])('non-project text (%s) → isProject false', async (_n, text) => {
    expect(scanProject(text).isProject).toBe(false);
    expect(looksLikeProject(text)).toBe(false);
    const idx = await buildIndex(text, text);
    expect(idx.sides.a.isProject).toBe(false);
    expect(idx.items).toEqual([]);
  });

  it.each([
    ['truncated inside an item', `<Customization>\n${graph('A', 'x')}\n<Graph ClassName="B"><CDATA name="Source"><![CDATA[unterminated`, /end of text/],
    ['missing </Customization>', '<Customization>\n<Table TableName="T"/>\n', /Customization> is missing/],
    ['mismatched end tag', proj('<Table TableName="T"/>\n<Page path="x"><a></b></Page>'), /Expected <\/a> but found <\/b>/],
    ['unquoted attribute', proj('<Table TableName="T"/>\n<Page path=x/>'), /not quoted/],
    ['stray top-level end tag', proj('<Table TableName="T"/>\n</Graph>'), /Unexpected <\/Graph>/],
  ])('malformed XML (%s) sets error, keeps items so far, never throws', async (_n, text, msg) => {
    const r = scanProject(text);
    expect(r.isProject).toBe(true);
    expect(r.error).toMatch(msg);
    expect(r.error).toMatch(/\(line \d+\)/);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    const idx = await buildIndex(text, '');
    expect(idx.sides.a.error).toBe(r.error);
    expect(idx.items.length).toBe(r.items.length);
  });

  it('every truncation point of a project is handled without throwing', () => {
    const text = proj(`${graph('A', 'class A { string s = "]]]]><![CDATA[>"; }')}\n<DAC type="X.Y"><Field FieldName="F"><CDATA name="TextAttributes"><![CDATA[[PXDBString]]]></CDATA></Field></DAC>\n<!-- x -->`);
    for (let k = 0; k <= text.length; k++) {
      const r = scanProject(text.slice(0, k), wantsFor);
      if (k < text.length - 2 && r.isProject) expect(r.error).toBeDefined();
    }
  });
});

describe('classifier table', () => {
  it('has one row per element; Other is last', () => {
    const els = RULES.flatMap((r) => r.elements);
    expect(new Set(els).size).toBe(els.length);
    expect(GROUP_ORDER.at(-1)).toBe('other');
  });

  it.each([
    ['ExistingGraph', 'Graph extension'],
    ['NewGraph', 'New graph'],
    ['ExistingDac', 'DAC extension'],
    ['NewDac', 'New DAC'],
    ['NewFile', 'Code file'],
    ['Weird', 'Weird'],
  ])('Graph FileType=%s → code, detail %s, C# code view', async (ft, detail) => {
    const it0 = await one(graph('SOOrderEntry_Extension', 'class X {}', ft));
    expect(it0).toMatchObject({ id: 'Graph:SOOrderEntry_Extension', group: 'code', name: 'SOOrderEntry_Extension', detail, element: 'Graph' });
    expect(it0.views).toEqual([
      { id: 'code', label: 'C#', language: 'csharp' },
      { id: 'xml', label: 'XML', language: 'xml' },
    ]);
    expect(await view(it0, 'code')).toBe('class X {}');
  });

  it('DAC → code, name from type, field count, "Fields" view with one block per field', async () => {
    const it0 = await one(
      '<DAC type="PX.Objects.SO.SOOrder+Ext">\n' +
        '  <Field FieldName="UsrA" TypeName="string" StorageName="DBTableColumn">\n    <CDATA name="TextAttributes"><![CDATA[[PXDBString(10)]\n[PXUIField(DisplayName = "A")]]]></CDATA>\n  </Field>\n' +
        '  <Field FieldName="UsrB" TypeName="decimal?" StorageName="NonDB" />\n' +
        '</DAC>',
    );
    expect(it0).toMatchObject({ id: 'DAC:PX.Objects.SO.SOOrder+Ext', group: 'code', name: 'Ext', detail: 'DAC customization · 2 fields' });
    expect(it0.views[0]).toEqual({ id: 'code', label: 'Fields', language: 'csharp' });
    expect(await view(it0, 'code')).toBe('// UsrA : string (DBTableColumn)\n[PXDBString(10)]\n[PXUIField(DisplayName = "A")]\n\n// UsrB : decimal? (NonDB)');
    expect((await one('<DAC type="PX.Objects.PO.POOrder"/>')).name).toBe('POOrder');
  });

  it('Page → screens; pageSource is base64 raw-deflate decoded on demand; detail and labels', async () => {
    const aspx = '<%@ Page Language="C#" %>\r\n<asp:Content runat="server"/>';
    const p1 = await one(`<Page path="~/pages/po/po301000.aspx" pageSource="${deflate64(aspx)}" />`);
    expect(p1).toMatchObject({ id: 'Page:~/pages/po/po301000.aspx', group: 'screens', name: 'PO301000', screenId: 'PO301000', detail: 'Page' });
    expect(p1.views).toEqual([
      { id: 'code', label: 'ASPX', language: 'xml' },
      { id: 'xml', label: 'XML', language: 'xml' },
    ]);
    expect(await view(p1, 'code')).toBe(aspx);

    const p2 = await one(`<Page path="~/pages/so/so301000.aspx" pageSource="${deflate64('<a/>')}">\n  <PXGrid ID="grid"><Columns/></PXGrid>\n</Page>`);
    expect(p2).toMatchObject({ detail: 'Screen customization' });
    expect(p2.views.map((v) => `${v.id}:${v.label}:${v.language}`)).toEqual(['code:ASPX:xml', 'changes:Changes:xml', 'xml:XML:xml']);
    expect(p2.slices.a && (await sliceViewText(p2.text, p2.slices.a, 'changes'))).toBe('  <PXGrid ID="grid"><Columns/></PXGrid>');

    const p3 = await one(`<Page path="~/pages/so/so301000.html" isModernUIOnlyNode="True" pageSource="${deflate64('<b/>')}" />`);
    expect(p3).toMatchObject({ detail: 'Modern UI page', name: 'SO301000' });
    expect(p3.views[0]?.label).toBe('HTML');

    expect((await one('<Page path="~/pages/x/xx100000.aspx" />')).views.map((v) => v.id)).toEqual(['xml']);
    const bad = await one('<Page path="~/pages/x/xx100000.aspx" pageSource="not base64!!" />');
    expect(await view(bad, 'code')).toMatch(/could not decode pageSource/);
  });

  it('Page status: equal base64 → same; different deflate of whitespace-equal text → whitespace', async () => {
    const pg = (s: string) => `<Page path="~/pages/so/so301000.aspx" pageSource="${s}" />`;
    const same = await buildIndex(proj(pg(deflate64('<a>\n x\n</a>'))), proj(pg(deflate64('<a>\n x\n</a>'))));
    expect(same.items[0]?.status).toBe('same');
    const ws = await buildIndex(proj(pg(deflate64('<a>\n x\n</a>'))), proj(pg(deflate64('<a>\n\tx   \n</a>'))));
    expect(ws.items[0]?.status).toBe('whitespace');
    const mod = await buildIndex(proj(pg(deflate64('<a/>'))), proj(pg(deflate64('<b/>'))));
    expect(mod.items[0]?.status).toBe('modified');
    expect(await inflateBase64(deflate64('héllo'))).toBe('héllo');
  });

  it.each([
    ['App_Code\\Caches\\SOLineExt.cs', 'code', 'SOLineExt.cs', 'C#', 'csharp', undefined],
    ['Pages\\SO\\SO301000.aspx', 'files', 'SO301000.aspx', 'Content', 'xml', 'SO301000'],
    ['Pages/AP/ap101000.aspx.cs', 'code', 'ap101000.aspx.cs', 'C#', 'csharp', 'AP101000'],
    ['web.config', 'files', 'web.config', 'Content', 'xml', undefined],
    ['Docs/readme.txt', 'files', 'readme.txt', 'Content', 'plaintext', undefined],
  ])('File %s → %s, name %s, code %s/%s, screenId %s', async (path, group, name, label, lang, screenId) => {
    const it0 = await one(`<File AppRelativePath="${path}">\n<CDATA name="Content"><![CDATA[body]]></CDATA>\n</File>`);
    expect(it0).toMatchObject({ id: `File:${path}`, group, name, detail: path });
    expect(it0.screenId).toBe(screenId);
    expect(it0.views[0]).toEqual({ id: 'code', label, language: lang });
  });

  it('File without content (real exports) → xml view only, status compares the element', async () => {
    const f = '<File AppRelativePath="App_Code\\X.cs" />';
    const it0 = await one(f);
    expect(it0.views.map((v) => v.id)).toEqual(['xml']);
    const idx = await buildIndex(proj(f), proj('<File AppRelativePath="App_Code\\X.cs" Description="changed" />'));
    expect(idx.items[0]?.status).toBe('modified');
    expect(screenIdFromPath('Frames/x.aspx')).toBeUndefined();
  });

  it('PerTenantFile → files, Modern UI detail, screenId from ScreenId, xml only', async () => {
    const it0 = await one('<PerTenantFile AppRelativePath="FrontendSources\\screen\\src\\screens\\SO\\SO301000\\SO301000.ts" ScreenId="so301000" />');
    expect(it0).toMatchObject({ group: 'files', name: 'SO301000.ts', screenId: 'SO301000' });
    expect(it0.detail).toMatch(/^Modern UI file · FrontendSources/);
    expect(it0.views.map((v) => v.id)).toEqual(['xml']);
  });

  it('EditorUpdatedFields → screens; bare CDATA JSON pretty-printed; json language only when available', async () => {
    const xml = '<EditorUpdatedFields ScreenId="SO301000"><![CDATA[{"fields":[{"name":"A"}]}]]></EditorUpdatedFields>';
    const it0 = await one(xml);
    expect(it0).toMatchObject({ id: 'EditorUpdatedFields:SO301000', group: 'screens', name: 'SO301000 editor fields', detail: 'Modern UI editor metadata', screenId: 'SO301000' });
    expect(it0.views[0]).toEqual({ id: 'code', label: 'JSON', language: 'json' });
    expect(await view(it0, 'code')).toBe('{\n  "fields": [\n    {\n      "name": "A"\n    }\n  ]\n}');
    const bad = await one('<EditorUpdatedFields ScreenId="X"><![CDATA[not json]]></EditorUpdatedFields>');
    expect(await view(bad, 'code')).toBe('not json');
    // Through the indexer: json → plaintext unless the pack is installed.
    const { createWorker } = fakeWorkers();
    const without = await createProjectIndexer({ createWorker }).index(proj(xml), '');
    expect(without.items[0]?.views[0]?.language).toBe('plaintext');
    const withJson = await createProjectIndexer({ createWorker, languageAvailable: (id) => id === 'json' }).index(proj(xml), '');
    expect(withJson.items[0]?.views[0]?.language).toBe('json');
  });

  it('Table → tables, detail = N columns, xml view', async () => {
    const t = await one('<Table TableName="SOLine">\n<Column ColumnName="A"/>\n<Column ColumnName="B"/>\n<Column ColumnName="C"></Column>\n</Table>');
    expect(t).toMatchObject({ id: 'Table:SOLine', group: 'tables', name: 'SOLine', detail: '3 columns' });
    expect(t.views.map((v) => v.id)).toEqual(['xml']);
    expect((await one('<Table TableName="X"><Column ColumnName="A"/></Table>')).detail).toBe('1 column');
  });

  it('Sql → sql, "Table schema", Schema view from TableSchemaXml', async () => {
    const s = await one('<Sql TableName="UsrTable" TableSchemaXml="#CDATA">\n<CDATA name="TableSchemaXml"><![CDATA[<table name="UsrTable"/>]]></CDATA>\n</Sql>');
    expect(s).toMatchObject({ id: 'Sql:UsrTable', group: 'sql', name: 'UsrTable', detail: 'Table schema' });
    expect(s.views[0]).toEqual({ id: 'code', label: 'Schema', language: 'xml' });
    expect(await view(s, 'code')).toBe('<table name="UsrTable"/>');
    expect((await one('<Sql Name="Script1"/>')).id).toBe('Sql:Script1');
  });

  it('Report / ReportDefinition → reports, xml code view', async () => {
    const r = await one('<Report ReportName="SO641000.rpx"><CDATA name="Report"><![CDATA[<Report/>]]></CDATA></Report>');
    expect(r).toMatchObject({ id: 'Report:SO641000.rpx', group: 'reports' });
    expect(r.views[0]).toMatchObject({ id: 'code', language: 'xml' });
    expect(await one('<ReportDefinition Name="R1"/>')).toMatchObject({ id: 'ReportDefinition:R1', group: 'reports' });
  });

  it('SiteMapNode → sitemap, identity/screenId from the first <row> with ScreenID, detail its Title', async () => {
    const s = await one('<SiteMapNode>\n<data-set><relations/><layout/><row NodeID="1"/><row Title="Sales Orders" ScreenID="so301000" Url="~/x"/></data-set>\n</SiteMapNode>');
    expect(s).toMatchObject({ id: 'SiteMapNode:so301000', group: 'sitemap', name: 'so301000', detail: 'Sales Orders', screenId: 'SO301000' });
    expect(s.views.map((v) => v.id)).toEqual(['xml']);
    expect((await one('<SiteMapNode><row Title="Only title"/></SiteMapNode>')).id).toBe('SiteMapNode:Only title');
  });

  it.each(['GenericInquiryScreen', 'GIDesign', 'DashboardMaintenance'])('%s → inquiries, identity from the first <row> with Name or DesignID', async (el) => {
    const g = await one(`<${el}>\n<data-set><row Other="x"/><row Name="Open Orders" DesignID="abc-123"/></data-set>\n</${el}>`);
    expect(g).toMatchObject({ id: `${el}:Open Orders`, group: 'inquiries' });
    expect((await one(`<${el}><row DesignID="abc-123"/><row Name="Later"/></${el}>`)).id).toBe(`${el}:abc-123`);
  });

  it.each(['EntityEndpoint', 'XportScenario', 'ImportScenario', 'WebHook', 'BusinessEvent'])('%s → integration by Name', async (el) => {
    expect(await one(`<${el} Name="Sync"/>`)).toMatchObject({ id: `${el}:Sync`, group: 'integration', name: 'Sync' });
  });

  it('EntityEndpoint id is Name@Version when Version is present; other integration elements ignore Version', async () => {
    const both = await buildIndex(proj('<EntityEndpoint Name="Default" Version="23.200.001"/>\n<EntityEndpoint Name="Default" Version="24.200.001"/>'), '');
    expect(both.items.map((i) => [i.id, i.name, i.detail])).toEqual([
      ['EntityEndpoint:Default@23.200.001', 'Default', 'Version 23.200.001'],
      ['EntityEndpoint:Default@24.200.001', 'Default', 'Version 24.200.001'],
    ]);
    expect((await one('<WebHook Name="Hook" Version="2"/>')).id).toBe('WebHook:Hook');
  });

  it('unknown elements → other, name = identity, detail = element; generic keys, descendants, ordinal; CDATA as code', async () => {
    const text = proj('<ScreenWithRights ScreenID="SO301000"/>\n<Localization><Item Key="k1"/></Localization>\n<Mystery/>\n<Mystery/>\n<Wiki><CDATA name="Body"><![CDATA[<p/>]]></CDATA></Wiki>');
    const idx = await buildIndex(text, '');
    expect(idx.items.map((i) => [i.id, i.group, i.name, i.detail])).toEqual([
      ['Mystery:1', 'other', '1', 'Mystery'],
      ['Wiki:1', 'other', '1', 'Wiki'],
      ['Mystery:2', 'other', '2', 'Mystery'],
      ['Localization:k1', 'other', 'k1', 'Localization'],
      ['ScreenWithRights:SO301000', 'other', 'SO301000', 'ScreenWithRights'],
    ]);
    // the <CDATA name="Body"> wrapper is not mistaken for an identity; its body is the code view
    const wiki = idx.items.find((i) => i.element === 'Wiki');
    expect(wiki?.views[0]).toEqual({ id: 'code', label: 'Code', language: 'xml' });
  });

  it('classify falls back to the ordinal for a known element without keys', () => {
    const raw = scanProject(proj('<Graph FileType="NewGraph"/>')).items[0];
    expect(raw && classify(raw, 3).identity).toBe('3');
  });
});

describe('index: ids, matching, status, views', () => {
  it('Page "changes" view: only the child lines; it is the default view (and status) when there is no pageSource', async () => {
    const pg = (kids: string) => `<Page path="~/pages/so/so301000.aspx">\r\n${kids}\r\n</Page>`;
    const kids = '  <PXGrid ID="g">\r\n    <Columns/>\r\n  </PXGrid>\r\n  <PXField ID="f" />';
    const it0 = await one(pg(kids));
    expect(it0.views.map((v) => v.id)).toEqual(['changes', 'xml']);
    expect(it0.slices.a && (await sliceViewText(it0.text, it0.slices.a, 'changes'))).toBe(kids);
    const idx = await buildIndex(proj(pg(kids)), proj(pg(kids.replace('ID="f"', 'ID="h"'))));
    expect(idx.items[0]?.status).toBe('modified');
    const { createWorker } = fakeWorkers();
    const ix = createProjectIndexer({ createWorker });
    await ix.index(proj(pg(kids)), proj('<Table TableName="T"/>'));
    expect(await ix.viewText('Page:~/pages/so/so301000.aspx', 'changes', 'a')).toBe(kids);
    expect(await ix.viewText('Table:T', 'changes', 'b')).toBeNull();
  });

  it('duplicates: identical elements pair first, so a delete/insert/move does not cascade', async () => {
    const t = (v: string) => `<Table TableName="T"><Column ColumnName="${v}"/></Table>`;
    const p = (...vs: string[]) => proj(vs.map(t).join('\n'));
    const st = (idx: Awaited<ReturnType<typeof buildIndex>>) => idx.items.map((i) => `${i.id}=${i.status}`).sort();
    // delete the first of three
    expect(st(await buildIndex(p('x', 'y', 'z'), p('y', 'z')))).toEqual(['Table:T#2=same', 'Table:T#3=same', 'Table:T=only-a']);
    // insert at the front
    expect(st(await buildIndex(p('y', 'z'), p('new', 'y', 'z')))).toEqual(['Table:T#2=same', 'Table:T#3=only-b', 'Table:T=same']);
    // move (reorder) among duplicates
    expect(st(await buildIndex(p('x', 'y', 'z'), p('z', 'x', 'y')))).toEqual(['Table:T#2=same', 'Table:T#3=same', 'Table:T=same']);
    // one modified + one deleted: identical ones pair first, the rest pair in document order
    const idx = await buildIndex(p('x', 'y', 'z'), p('y', 'Z2'));
    expect(st(idx)).toEqual(['Table:T#2=same', 'Table:T#3=only-a', 'Table:T=modified']);
    const paired = idx.items.find((i) => i.id === 'Table:T');
    expect([paired?.a?.startLine, paired?.b?.startLine]).toEqual([3, 4]); // x (A line 3) ↔ Z2 (B line 4)
  });

  it('duplicate ids get #2, #3 in document order', async () => {
    const idx = await buildIndex(proj('<Table TableName="T"/>\n<Table TableName="T"><Column/></Table>\n<Table TableName="T"/>'), '');
    expect(idx.items.map((i) => i.id).sort()).toEqual(['Table:T', 'Table:T#2', 'Table:T#3']);
    expect(idx.items.find((i) => i.id === 'Table:T#2')?.a?.startLine).toBe(4);
  });

  it('a moved element is "same"', async () => {
    const g1 = graph('A', 'class A {}');
    const g2 = graph('B', 'class B {}');
    const idx = await buildIndex(proj(`${g1}\n${g2}`), proj(`${g2}\n<Table TableName="T"/>\n${g1}`));
    expect(Object.fromEntries(idx.items.map((i) => [i.id, i.status]))).toEqual({ 'Graph:A': 'same', 'Graph:B': 'same', 'Table:T': 'only-b' });
    const a = idx.items.find((i) => i.id === 'Graph:A');
    expect([a?.a?.startLine, a?.b?.startLine]).toEqual([3, 7]);
  });

  it('whitespace-only differences → "whitespace"; real ones → "modified"; one side → only-a / only-b', async () => {
    const idx = await buildIndex(
      proj(`${graph('W', 'class W {\n  int x;\n}')}\n${graph('M', 'class M { int x; }')}\n${graph('OA', 'x')}\n<Table TableName="T"><Column ColumnName="A"/></Table>`),
      proj(`${graph('W', 'class W {\r\n\tint x;   \r\n}')}\n${graph('M', 'class M { int y; }')}\n${graph('OB', 'x')}\n<Table TableName="T">  <Column ColumnName="A"/></Table>`),
    );
    const st = Object.fromEntries(idx.items.map((i) => [i.id, i.status]));
    expect(st).toEqual({ 'Graph:W': 'whitespace', 'Graph:M': 'modified', 'Graph:OA': 'only-a', 'Graph:OB': 'only-b', 'Table:T': 'modified' });
    expect(idx.counts).toEqual({ same: 0, whitespace: 1, modified: 2, 'only-a': 1, 'only-b': 1 });
  });

  it('status compares the default view (code), so an attribute change outside CDATA is still "same"', async () => {
    const idx = await buildIndex(proj(graph('G', 'class G {}', 'ExistingGraph')), proj(graph('G', 'class G {}', 'NewGraph')));
    expect(idx.items[0]?.status).toBe('same');
    expect(compareTexts('a\r\nb', 'a\nb')).toBe('whitespace');
  });

  it('items are sorted by group order, then name (numeric-aware)', async () => {
    const idx = await buildIndex(proj('<Mystery Name="z"/>\n<Table TableName="B"/>\n<Page path="x/so2.aspx"/>\n<Page path="x/so10.aspx"/>\n<Table TableName="a"/>\n' + graph('Z', 'x')), '');
    expect(idx.items.map((i) => i.name)).toEqual(['Z', 'SO2', 'SO10', 'a', 'B', 'z']);
  });

  it('code view joins several CDATA sections with separator lines; xml view is the element lines verbatim (CRLF kept)', async () => {
    const it0 = await one('  <Report ReportName="R">\r\n    <CDATA name="Head"><![CDATA[<a/>]]></CDATA>\r\n    <CDATA name="Body"><![CDATA[<b/>]]></CDATA>\r\n  </Report>');
    expect(await view(it0, 'code')).toBe('// ---- Head ----\n<a/>\n// ---- Body ----\n<b/>');
    expect(await view(it0, 'xml')).toBe('  <Report ReportName="R">\r\n    <CDATA name="Head"><![CDATA[<a/>]]></CDATA>\r\n    <CDATA name="Body"><![CDATA[<b/>]]></CDATA>\r\n  </Report>');
  });

  it('side info has root attributes, item counts and timing', async () => {
    const idx = await buildIndex(proj('<Table TableName="T"/>', 'level="100" product-version="24.200.0001" description="d"'), 'plain');
    expect(idx.sides.a).toMatchObject({ isProject: true, attributes: { 'product-version': '24.200.0001', description: 'd' }, items: 1 });
    expect(idx.sides.b).toMatchObject({ isProject: false, items: 0 });
    expect(idx.items[0]?.status).toBe('only-a');
  });
});

// --- createProjectIndexer with an in-process fake worker -----------------------

function fakeWorkers() {
  const made: { terminated: boolean; posted: IndexRequest[] }[] = [];
  const createWorker = (): WorkerLike => {
    const rec = { terminated: false, posted: [] as IndexRequest[] };
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        rec.posted.push(msg);
        // Reply asynchronously, like a real worker, unless terminated first.
        setTimeout(() => {
          void buildIndex(msg.a, msg.b).then((index) => {
            if (rec.terminated) return;
            const res: IndexResponse = { id: msg.id, ok: true, index, workerMs: 0 };
            w.onmessage?.({ data: structuredClone(res) } as MessageEvent<IndexResponse>);
          });
        }, 5);
      },
      terminate() {
        rec.terminated = true;
      },
    };
    made.push(rec);
    return w;
  };
  return { made, createWorker };
}

describe('createProjectIndexer', () => {
  const A = proj(`${graph('G', 'class G {}')}\n<Table TableName="T"/>`);
  const B = proj(`${graph('G', 'class G { int x; }')}`);

  it('indexes in the worker, strips slices, and viewText slices the last texts', async () => {
    const { made, createWorker } = fakeWorkers();
    const ix = createProjectIndexer({ createWorker });
    const idx = await ix.index(A, B);
    expect(made).toHaveLength(1);
    expect(idx.items.map((i) => `${i.id}:${i.status}`)).toEqual(['Graph:G:modified', 'Table:T:only-a']);
    expect(idx.items[0]).not.toHaveProperty('slices');
    expect(await ix.viewText('Graph:G', 'code', 'a')).toBe('class G {}');
    expect(await ix.viewText('Graph:G', 'code', 'b')).toBe('class G { int x; }');
    expect(await ix.viewText('Graph:G', 'xml', 'b')).toContain('<Graph ClassName="G"');
    expect(await ix.viewText('Table:T', 'xml', 'a')).toBe('<Table TableName="T"/>');
    expect(await ix.viewText('Table:T', 'xml', 'b')).toBeNull();
    expect(await ix.viewText('Table:T', 'code', 'a')).toBeNull();
    expect(await ix.viewText('nope', 'xml', 'a')).toBeNull();
    // cached: same promise for a repeat request
    expect(ix.viewText('Graph:G', 'code', 'a')).toBe(ix.viewText('Graph:G', 'code', 'a'));
  });

  it('a newer call rejects the older one with AbortError and terminates its worker', async () => {
    const { made, createWorker } = fakeWorkers();
    const ix = createProjectIndexer({ createWorker });
    const first = ix.index(A, B);
    const second = ix.index(B, A);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const idx = await second;
    expect(made.map((m) => m.terminated)).toEqual([true, false]);
    expect(idx.items.find((i) => i.id === 'Table:T')?.status).toBe('only-b');
    expect(await ix.viewText('Graph:G', 'code', 'a')).toBe('class G { int x; }');
  });

  it('non-project text resolves without a worker; a non-project side is sent as empty', async () => {
    const { made, createWorker } = fakeWorkers();
    const ix = createProjectIndexer({ createWorker });
    const idx = await ix.index('using System;', 'plain');
    expect(idx.sides.a.isProject).toBe(false);
    expect(idx.sides.b.isProject).toBe(false);
    expect(made).toHaveLength(0);
    await ix.index(A, 'x'.repeat(1000));
    expect(made[0]?.posted[0]?.b).toBe('');
  });

  it('worker crash rejects with a readable error and the next call respawns', async () => {
    const created: WorkerLike[] = [];
    const ix = createProjectIndexer({
      createWorker: () => {
        const w: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage: () => setTimeout(() => w.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent), 1),
          terminate() {},
        };
        created.push(w);
        return w;
      },
    });
    await expect(ix.index(A, B)).rejects.toThrow(/worker failed: boom/);
    await expect(ix.index(A, B)).rejects.toThrow(/boom/);
    expect(created).toHaveLength(2);
  });

  it('dispose aborts a pending call and refuses new ones', async () => {
    const { createWorker } = fakeWorkers();
    const ix = createProjectIndexer({ createWorker });
    const p = ix.index(A, B);
    ix.dispose();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(ix.index(A, B)).rejects.toThrow(/disposed/);
  });
});

describe.skipIf(!existsSync('fixtures/large-a.xml'))('large fixture (node timing, informational)', () => {
  it('scans and indexes the 150k-line pair', async () => {
    const a = readFileSync('fixtures/large-a.xml', 'utf8');
    const b = readFileSync('fixtures/large-b.xml', 'utf8');
    const t0 = performance.now();
    const idx = await buildIndex(a, b);
    const ms = performance.now() - t0;
    expect(idx.sides.a.isProject).toBe(true);
    expect(idx.sides.a.error).toBeUndefined();
    expect(idx.sides.b.error).toBeUndefined();
    console.info(`[project] large pair: ${idx.sides.a.items} items, scan A ${idx.sides.a.parseMs} ms, B ${idx.sides.b.parseMs} ms, buildIndex total ${ms.toFixed(0)} ms, counts ${JSON.stringify(idx.counts)}`);
  });
});

describe.skipIf(!existsSync('fixtures/project-a.xml'))('project fixture pair vs fixtures/project.changes.json', () => {
  it('every item matches the sidecar: id, group, name, status, views, line ranges, counts', async () => {
    interface Expected {
      id: string;
      element: string;
      group: string;
      name: string;
      detail: string;
      status: string;
      views: string[];
      a: { startLine: number; endLine: number } | null;
      b: { startLine: number; endLine: number } | null;
    }
    const oracle = JSON.parse(readFileSync('fixtures/project.changes.json', 'utf8')) as { items: Expected[]; counts: { total: number; byStatus: Record<string, number> } };
    const idx = await buildIndex(readFileSync('fixtures/project-a.xml', 'utf8'), readFileSync('fixtures/project-b.xml', 'utf8'));
    const got = new Map(idx.items.map((i) => [i.id, i]));
    const diffs: string[] = [];
    for (const e of oracle.items) {
      // Until QA's sidecar follows 0998de6, accept `EntityEndpoint:<Name>` for `<Name>@<Version>`.
      const legacy = e.element === 'EntityEndpoint' && !e.id.includes('@') ? [...got.keys()].filter((k) => k.startsWith(`${e.id}@`)) : [];
      if (legacy.length === 1 && legacy[0]) e.id = legacy[0];
      const g = got.get(e.id);
      if (!g) {
        diffs.push(`missing ${e.id}`);
        continue;
      }
      got.delete(e.id);
      // `detail` is left to the classifier tests: the sidecar predates e0d55ac's detail rules.
      // The sidecar may predate the 'changes' view (da0a450); compare without it then.
      const gotViews = g.views.map((v) => v.id).filter((v) => v !== 'changes' || e.views.includes('changes'));
      const actual = { element: g.element, group: g.group, name: g.name, status: g.status, views: gotViews, a: g.a, b: g.b };
      const want = { element: e.element, group: e.group, name: e.name, status: e.status, views: e.views, a: e.a, b: e.b };
      for (const k of Object.keys(want) as (keyof typeof want)[]) {
        if (JSON.stringify(actual[k]) !== JSON.stringify(want[k])) diffs.push(`${e.id}.${k}: got ${JSON.stringify(actual[k])}, want ${JSON.stringify(want[k])}`);
      }
    }
    for (const id of got.keys()) diffs.push(`unexpected ${id}`);
    expect(diffs).toEqual([]);
    expect(idx.items).toHaveLength(oracle.counts.total);
    expect(idx.counts).toEqual(oracle.counts.byStatus);
  });
});
