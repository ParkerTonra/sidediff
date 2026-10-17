import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { IndexResponse, IndexRequest } from './protocol';
import type { PackageSource, ProjectIndexer } from '../types';
import { createPackageReader } from '../package';
import { buildZip } from '../package/test-zip';
import { buildIndex } from './build';
import { createProjectIndexer, type WorkerLike } from './index';
import { buildSummary } from './summary';
import { createWorkerCore } from './worker-core';
import { existsSync, readFileSync } from 'node:fs';
import { applyPendingSidecarChanges, oracleDiffs, type OracleItem } from './oracle-helper';

const deflate64 = (s: string): string => deflateRawSync(Buffer.from(s, 'utf8')).toString('base64');
const proj = (body: string) => `<Customization level="0" product-version="24.200.0001">\r\n${body}\r\n</Customization>`;
const blob = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>]);
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function inProcessWorker(): () => WorkerLike {
  return () => {
    const core = createWorkerCore();
    let dead = false;
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg: IndexRequest) {
        setTimeout(() => {
          void core(msg).then((res: IndexResponse) => {
            if (!dead) w.onmessage?.({ data: structuredClone(res) } as MessageEvent<IndexResponse>);
          });
        }, 1);
      },
      terminate() {
        dead = true;
      },
    };
    return w;
  };
}

const ASPX = [
  '<%@ Page Language="C#" MasterPageFile="~/MasterPages/FormDetail.master" %>',
  '<asp:Content ID="cont1" ContentPlaceHolderID="phDS" runat="Server">',
  '  <px:PXDataSource ID="ds" runat="server" TypeName="Demo.WidgetEntry" PrimaryView="Document" />',
  '</asp:Content>',
  '<asp:Content ID="cont2" ContentPlaceHolderID="phF" runat="Server">',
  '  <px:PXFormView ID="form" runat="server" DataMember="Document" Caption="Widget Summary">',
  '    <Template>',
  '      <px:PXSelector ID="edRefNbr" runat="server" DataField="RefNbr" />',
  '      <px:PXTextEdit ID="edDescr" runat="server" DataField="Descr" CommitChanges="True" />',
  '    </Template>',
  '  </px:PXFormView>',
  '  <px:PXGrid ID="grid" runat="server" Caption="Lines">',
  '    <Levels><px:PXGridLevel DataMember="Lines">',
  '      <RowTemplate><px:PXNumberEdit ID="edQty" runat="server" DataField="Qty" /></RowTemplate>',
  '      <Columns><px:PXGridColumn DataField="InventoryID" /><px:PXGridColumn DataField="Qty" /></Columns>',
  '    </px:PXGridLevel></Levels>',
  '  </px:PXGrid>',
  '</asp:Content>',
].join('\r\n');

const SITEMAP = `<SiteMapNode>
  <data-set>
    <data>
      <SiteMap>
        <row Title="Widgets" Url="~/Pages/DM/DM301000.aspx" ScreenID="DM301000" NodeID="n1">
          <MUIScreen WorkspaceID="w1" SubcategoryID="c1" />
        </row>
      </SiteMap>
      <MUIWorkspace><row WorkspaceID="w1" Title="Demo Workspace" /></MUIWorkspace>
      <MUISubcategory><row SubcategoryID="c1" Name="Profiles" /></MUISubcategory>
    </data>
  </data-set>
</SiteMapNode>`;

const PROJECT_A = proj(
  [
    '<File AppRelativePath="App_Code\\Caches\\Widget.cs" />',
    '<File AppRelativePath="Pages\\DM\\DM301000.aspx" />',
    '<File AppRelativePath="Bin\\Demo.Ext.dll" />',
    '<File AppRelativePath="App_Code\\Missing.cs" />',
    '<PerTenantFile AppRelativePath="screens\\DM\\DM301000\\DM301000.html" ScreenId="DM301000" />',
    `<Page path="~/pages/dm/dm301000.aspx" pageSource="${deflate64(ASPX)}" />`,
    SITEMAP,
  ].join('\r\n'),
);

const HTML = '<template>\n  <qp-fieldset id="fs1" view.bind="Document">\n    <field name="RefNbr"></field>\n    <field name="UsrColor" after="#fs1 [name=\'Descr\']"></field>\n  </qp-fieldset>\n  <qp-grid id="grid" view.bind="Lines"></qp-grid>\n</template>';

function packageA(overrides: Record<string, string | Uint8Array> = {}) {
  const files: Record<string, string | Uint8Array> = {
    'project.xml': PROJECT_A,
    'App_Code/Caches/Widget.cs': 'public class Widget {\n  // FindMeInCSharp\n}',
    'Pages/DM/DM301000.aspx': ASPX,
    'Bin/Demo.Ext.dll': MZ,
    'screens/DM/DM301000/DM301000.html': HTML,
    'Icons/widget.png': PNG,
    'App_Data/SnapshotConfigs/demo.esc': '<Snapshot>FindMeInEsc</Snapshot>',
    'Bin/Unlisted.dll': MZ,
    ...overrides,
  };
  return buildZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

async function open(zip: Uint8Array, name = 'demo.zip'): Promise<PackageSource> {
  return createPackageReader().open(blob(zip), name);
}

async function indexed(a: PackageSource, b?: PackageSource): Promise<{ ix: ProjectIndexer; idx: Awaited<ReturnType<ProjectIndexer['index']>> }> {
  const ix = createProjectIndexer({ createWorker: inProcessWorker() });
  const idx = await ix.index(a.projectXml ?? '', b?.projectXml ?? '', b ? { a, b } : { a });
  return { ix, idx };
}

describe('package-aware indexing (browse)', () => {
  it('File items take the zip content; unreferenced files become Zip: items by kind', async () => {
    const { ix, idx } = await indexed(await open(packageA()));
    const by = new Map(idx.items.map((i) => [i.id, i]));
    const cs = by.get('File:App_Code\\Caches\\Widget.cs');
    expect(cs).toMatchObject({ group: 'code', status: 'only-a' });
    expect(cs?.views.map((v) => `${v.id}:${v.label}:${v.language}`)).toEqual(['code:C#:csharp', 'xml:XML:xml', 'summary:Facts:plaintext']);
    expect(await ix.viewText('File:App_Code\\Caches\\Widget.cs', 'code', 'a')).toBe('public class Widget {\n  // FindMeInCSharp\n}');

    const dll = by.get('File:Bin\\Demo.Ext.dll');
    expect(dll).toMatchObject({ group: 'assemblies' });
    expect(dll?.views[0]?.id).toBe('assembly');
    expect(Array.from((await ix.viewBytes?.('File:Bin\\Demo.Ext.dll', 'a')) ?? [])).toEqual(Array.from(MZ));

    const aspxFile = by.get('File:Pages\\DM\\DM301000.aspx');
    expect(aspxFile?.views.map((v) => v.id)).toEqual(['summary', 'code', 'xml']);
    expect(aspxFile?.screenId).toBe('DM301000');

    const pt = by.get('PerTenantFile:screens\\DM\\DM301000\\DM301000.html');
    expect(pt?.views.map((v) => `${v.id}:${v.label}`)).toEqual(['summary:Summary', 'code:HTML', 'xml:XML']);

    // a referenced file missing from the zip stays reference-only
    expect(by.get('File:App_Code\\Missing.cs')?.views.map((v) => v.id)).toEqual(['xml', 'summary']);

    const zipItems = idx.items.filter((i) => i.element === 'Zip').map((i) => [i.id, i.group, i.name, i.detail, i.views[0]?.id, i.a]);
    // group order: files, assemblies, images
    expect(zipItems).toEqual([
      ['Zip:App_Data/SnapshotConfigs/demo.esc', 'files', 'demo.esc', 'not in project.xml', 'code', { startLine: 0, endLine: 0 }],
      ['Zip:Bin/Unlisted.dll', 'assemblies', 'Unlisted.dll', 'not in project.xml', 'assembly', { startLine: 0, endLine: 0 }],
      ['Zip:Icons/widget.png', 'images', 'widget.png', 'not in project.xml', 'image', { startLine: 0, endLine: 0 }],
    ]);
    expect(await ix.viewText('Zip:App_Data/SnapshotConfigs/demo.esc', 'code', 'a')).toBe('<Snapshot>FindMeInEsc</Snapshot>');
    expect(await ix.viewText('Zip:App_Data/SnapshotConfigs/demo.esc', 'xml', 'a')).toBeNull();
    expect(Array.from((await ix.viewBytes?.('Zip:Icons/widget.png', 'a')) ?? [])).toEqual(Array.from(PNG));
    expect(await ix.viewBytes?.('Page:~/pages/dm/dm301000.aspx', 'a')).toBeNull();
  });

  it('overview: facts, counts per group, screens with titles, assemblies, warnings', async () => {
    const src = await open(packageA());
    const { ix } = await indexed(src);
    const o = ix.overview?.('a');
    expect(o).toMatchObject({ name: 'demo.zip', kind: 'zip', bytes: src.bytes, attributes: { level: '0', 'product-version': '24.200.0001' } });
    expect(o?.counts).toEqual({ code: 2, screens: 1, sitemap: 1, files: 3, assemblies: 2, images: 1 });
    expect(o?.screens).toEqual([{ screenId: 'DM301000', title: 'Widgets' }]);
    expect(o?.assemblies.map((x) => x.path)).toEqual(['Bin/Demo.Ext.dll', 'Bin/Unlisted.dll']);
    expect(o?.warnings).toEqual(['Listed in project.xml but missing from the zip: App_Code/Missing.cs', '3 files in the zip are not referenced by project.xml.']);
    expect(ix.overview?.('b')).toBeNull();
  });

  it('a zip without project.xml lists its files and warns', async () => {
    const src = await open(buildZip([{ name: 'a/readme.txt', data: 'hello' }]));
    const { ix, idx } = await indexed(src);
    expect(idx.items.map((i) => i.id)).toEqual(['Zip:a/readme.txt']);
    expect(ix.overview?.('a')?.warnings).toEqual(['The package has no project.xml.', '1 file in the zip is not referenced by project.xml.']);
  });

  it('a bare project.xml still works as a package source', async () => {
    const src = await createPackageReader().open(blob(new TextEncoder().encode(proj('<Table TableName="T" />'))), 'project.xml');
    const { ix, idx } = await indexed(src);
    expect(idx.items.map((i) => i.id)).toEqual(['Table:T']);
    expect(ix.overview?.('a')).toMatchObject({ name: 'project.xml', kind: 'xml', warnings: [] });
  });
});

describe('package-aware indexing (compare)', () => {
  it('file content decides status: same by CRC, whitespace, modified; reference-only side compares the element', async () => {
    const a = await open(packageA());
    const b = await open(
      packageA({
        'App_Code/Caches/Widget.cs': 'public class Widget {\n\t// FindMeInCSharp   \n}',
        'Bin/Demo.Ext.dll': new Uint8Array([0x4d, 0x5a, 1, 2]),
        'Icons/widget.png': PNG,
        'App_Data/SnapshotConfigs/demo.esc': '<Snapshot>changed</Snapshot>',
      }),
    );
    const { idx } = await indexed(a, b);
    const st = Object.fromEntries(idx.items.map((i) => [i.id, i.status]));
    expect(st['File:App_Code\\Caches\\Widget.cs']).toBe('whitespace');
    expect(st['File:Bin\\Demo.Ext.dll']).toBe('modified');
    expect(st['Zip:Icons/widget.png']).toBe('same');
    expect(st['Zip:App_Data/SnapshotConfigs/demo.esc']).toBe('modified');
    expect(st['File:Pages\\DM\\DM301000.aspx']).toBe('same');

    const bareB = await createPackageReader().open(blob(new TextEncoder().encode(PROJECT_A)), 'project.xml');
    const mixed = await indexed(a, bareB);
    const ms = Object.fromEntries(mixed.idx.items.map((i) => [i.id, i.status]));
    expect(ms['File:App_Code\\Caches\\Widget.cs']).toBe('same'); // element vs element
    expect(ms['Zip:Icons/widget.png']).toBe('only-a');
  });
});

describe('Phase 5 element kinds', () => {
  const one = async (xml: string) => {
    const idx = await buildIndex(proj(xml), '');
    expect(idx.sides.a.error).toBeUndefined();
    expect(idx.items).toHaveLength(1);
    return idx.items[0];
  };

  it('ScreenWithRights → security, identity and screen from its site map row', async () => {
    const it0 = await one(`<ScreenWithRights AccessRightsMergeRule="GrantAll"><data-set><data><SiteMap><row Title="Widgets" ScreenID="DM301000"><RolesInGraph Rolename="Admin" Accessrights="4" /></row></SiteMap></data></data-set></ScreenWithRights>`);
    expect(it0).toMatchObject({ id: 'ScreenWithRights:DM301000', group: 'security', name: 'DM301000', detail: 'Access rights · Widgets', screenId: 'DM301000' });
    expect(it0?.views[0]?.id).toBe('summary');
  });

  it('Automation → screens keyed by screen', async () => {
    const it0 = await one('<Automation screen="DM301000"><Fields ScreenID="DM301000"><Field FieldName="A" /><Field FieldName="B" /></Fields></Automation>');
    expect(it0).toMatchObject({ id: 'Automation:DM301000', group: 'screens', name: 'DM301000 automation', detail: 'Automation · 2 fields', screenId: 'DM301000' });
  });

  it('GenericInquiryScreen, DashboardV2 and WidgetFilterRow → inquiries', async () => {
    const gi = await one('<GenericInquiryScreen><data-set><data><GIDesign><row DesignID="d1" Name="Open Widgets"><SiteMap><row Title="Open Widgets" ScreenID="GI000101" /></SiteMap></row></GIDesign></data></data-set></GenericInquiryScreen>');
    expect(gi).toMatchObject({ id: 'GenericInquiryScreen:Open Widgets', group: 'inquiries', detail: 'GI000101', screenId: 'GI000101' });
    expect(gi?.views[0]?.id).toBe('summary');
    expect(await one('<DashboardV2><data-set><data><DashboardV2><row DashboardID="x" Name="Sales Board" /></DashboardV2></data></data-set></DashboardV2>')).toMatchObject({ id: 'DashboardV2:Sales Board', group: 'inquiries', detail: 'Dashboard' });
    expect(await one('<WidgetFilterRow Name="F1" />')).toMatchObject({ group: 'inquiries', detail: 'Widget filter' });
  });

  it('MobileSiteMap and MobileSiteMapWorkspaces → sitemap', async () => {
    expect(await one('<MobileSiteMap ScreenID="DM301000" Type="Screen" Script="add screen DM301000 {&#xA;  add container Document&#xA;}" />')).toMatchObject({ id: 'MobileSiteMap:DM301000', group: 'sitemap', detail: 'Mobile site map · Screen', screenId: 'DM301000' });
    expect(await one('<MobileSiteMapWorkspaces><data-set><data><X><row Name="Demo WS" /></X></data></data-set></MobileSiteMapWorkspaces>')).toMatchObject({ id: 'MobileSiteMapWorkspaces:Demo WS', group: 'sitemap' });
  });

  it('XportScenario → integration (row Name); CSAttribute → tables (AttributeID)', async () => {
    expect(await one('<XportScenario><data-set><data><SYMapping><row Name="Import Widgets" ScreenID="DM301000" /></SYMapping></data></data-set></XportScenario>')).toMatchObject({ id: 'XportScenario:Import Widgets', group: 'integration', detail: 'Scenario · DM301000' });
    expect(await one('<CSAttribute><data-set><data><CSAttribute><row AttributeID="COLOR" Description="Color" /></CSAttribute></data></data-set></CSAttribute>')).toMatchObject({ id: 'CSAttribute:COLOR', group: 'tables', detail: 'Attribute · Color' });
  });

  it('EntityEndpoint: name/version from the <Endpoint> child (real exports) or the element', async () => {
    expect(await one('<EntityEndpoint><Endpoint name="Demo" version="23.200.001"><TopLevelEntity name="Widget" screen="DM301000" /></Endpoint></EntityEndpoint>')).toMatchObject({ id: 'EntityEndpoint:Demo@23.200.001', name: 'Demo', detail: 'Version 23.200.001' });
    expect(await one('<EntityEndpoint Name="Demo2" Version="1.0" />')).toMatchObject({ id: 'EntityEndpoint:Demo2@1.0' });
  });

  it('WikiArticle, Images, Info → other with proper names', async () => {
    expect(await one('<WikiArticle><data-set><data><WikiPage><row Name="demo_page"><WikiPageLanguage Title="Demo Help" /></row></WikiPage></data></data-set></WikiArticle>')).toMatchObject({ group: 'other', name: 'Demo Help', detail: 'Wiki article' });
    expect(await one('<Images />')).toMatchObject({ group: 'other', name: 'Images 1', detail: 'Images' });
    expect(await one('<Info IsISV="True" Initials="DM" />')).toMatchObject({ group: 'other', name: 'Project info', detail: 'ISV · DM' });
  });

  it('Sql: CustomScript is a SQL script (sql view, plaintext without the pack); TableSchemaXml is a schema', async () => {
    const script = await one('<Sql TableName="DemoTable" CustomScript="#CDATA"><CDATA name="CustomScript"><![CDATA[IF NOT EXISTS (SELECT 1) BEGIN SELECT 2 END]]></CDATA></Sql>');
    expect(script).toMatchObject({ detail: 'SQL script' });
    expect(script?.views.map((v) => `${v.id}:${v.label}:${v.language}`)).toEqual(['code:SQL:sql', 'xml:XML:xml', 'summary:Facts:plaintext']);
    const ix = createProjectIndexer({ createWorker: inProcessWorker(), languageAvailable: () => false });
    const idx = await ix.index(proj('<Sql TableName="T" CustomScript="#CDATA"><CDATA name="CustomScript"><![CDATA[SELECT 1]]></CDATA></Sql>'), '');
    expect(idx.items[0]?.views[0]?.language).toBe('plaintext');
  });
});

describe('summaries', () => {
  it('DAC customization: one row per field', () => {
    const s = buildSummary({
      kind: 'dac',
      title: 'Widget',
      elementText:
        '<DAC type="Demo.Widget"><Field FieldName="UsrColor" TypeName="string" StorageName="AddColumn"><CDATA name="TextAttributes"><![CDATA[[PXDBString(10)]\n[PXUIField(DisplayName = "Color")]]]></CDATA></Field></DAC>',
    });
    expect(s.facts).toEqual([
      ['DAC', 'Demo.Widget'],
      ['Fields', '1'],
    ]);
    expect(s.sections[0]).toEqual({ heading: 'Fields', columns: ['Field', 'Type', 'Storage', 'DisplayName', 'Attributes'], rows: [['UsrColor', 'string', 'AddColumn', 'Color', 'PXDBString, PXUIField']], keyColumn: 0 });
  });

  it('DAC in C#: properties with attributes, marked best effort', () => {
    const src = [
      '[Serializable]',
      '[PXCacheName("Widget")]',
      'public class DemoWidget : PXBqlTable, IBqlTable',
      '{',
      '    [PXDBString(15, IsKey = true)]',
      '    [PXUIField(DisplayName = "Widget Nbr.")]',
      '    public virtual string WidgetNbr { get; set; }',
      '    public abstract class widgetNbr : PX.Data.BQL.BqlString.Field<widgetNbr> { }',
      '    [PXDBDecimal(6)]',
      '    public virtual Decimal? Qty { get; set; }',
      '}',
    ].join('\n');
    const s = buildSummary({ kind: 'dacCode', title: 'DemoWidget', elementText: '', codeText: src });
    expect(s.facts).toContainEqual(['Class', 'DemoWidget : PXBqlTable, IBqlTable']);
    expect(s.facts).toContainEqual(['Parsing', 'best effort (regex over the C# source)']);
    expect(s.sections[0]?.rows).toEqual([
      ['WidgetNbr', 'string', 'Widget Nbr.', 'PXDBString', 'PXDBString, PXUIField'],
      ['Qty', 'Decimal?', '', 'PXDBDecimal', 'PXDBDecimal'],
    ]);
  });

  it('Table columns and Sql schema columns + indexes', () => {
    const t = buildSummary({ kind: 'table', title: 'T', elementText: '<Table TableName="DemoT"><Column ColumnName="UsrA" ColumnType="nvarchar" AllowNull="True" MaxLength="20" /><Column ColumnName="UsrB" ColumnType="decimal" DecimalPrecision="19" DecimalLength="6" AllowNull="False" /></Table>' });
    expect(t.sections[0]?.rows).toEqual([
      ['UsrA', 'nvarchar', 'yes', '20', ''],
      ['UsrB', 'decimal', 'no', '19,6', ''],
    ]);
    const schema = '<table name="DemoT"><col name="CompanyID" type="Int" default="Zero" /><col name="Code" type="NVarChar(15)" nullable="true" /><index name="DemoT_PK" clustered="true" primary="true" unique="true"><col name="CompanyID" /><col name="Code" /></index></table>';
    const s = buildSummary({ kind: 'sqlSchema', title: 'DemoT', elementText: `<Sql TableName="DemoT" TableSchemaXml="#CDATA"><CDATA name="TableSchemaXml"><![CDATA[${schema}]]></CDATA></Sql>` });
    expect(s.sections.map((x) => x.heading)).toEqual(['Columns', 'Indexes']);
    expect(s.sections[0]?.rows).toEqual([
      ['CompanyID', 'Int', 'no', '', 'Zero'],
      ['Code', 'NVarChar(15)', 'yes', '15', ''],
    ]);
    expect(s.sections[1]?.rows).toEqual([['DemoT_PK', 'CompanyID, Code', 'yes', 'yes', 'yes']]);
  });

  it('Page (ASPX): screen, title from the site map, data source, containers with fields in order', () => {
    const s = buildSummary({ kind: 'page', title: 'DM301000', elementText: '<Page path="~/pages/dm/dm301000.aspx" />', codeText: ASPX, titles: new Map([['DM301000', 'Widgets']]) });
    expect(s.facts).toEqual([
      ['Screen', 'DM301000'],
      ['Title', 'Widgets'],
      ['Kind', 'ASPX (classic UI)'],
      ['Graph (TypeName)', 'Demo.WidgetEntry'],
      ['Primary view', 'Document'],
      ['Containers', '2'],
    ]);
    expect(s.sections.map((x) => [x.heading, x.rows.map((r) => `${r[0]}/${r[1]}${r[2] ? '/commit' : ''}`)])).toEqual([
      ['PXFormView form "Widget Summary" · Document', ['RefNbr/PXSelector', 'Descr/PXTextEdit/commit']],
      ['PXGrid grid "Lines" · Lines', ['Qty/PXNumberEdit', 'InventoryID/Grid column']],
    ]);
  });

  it('Page (Modern UI HTML): qp-* containers by view.bind, fields with placement', () => {
    const s = buildSummary({ kind: 'page', title: 'DM301000.html', elementText: '', codeText: HTML });
    expect(s.facts).toContainEqual(['Kind', 'HTML (Modern UI)']);
    expect(s.sections.map((x) => [x.heading, x.rows])).toEqual([
      ['qp-fieldset fs1 · Document', [['RefNbr', 'field', ''], ['UsrColor', 'field', 'after']]],
      ['qp-grid grid · Lines', []],
    ]);
  });

  it('GenericInquiryScreen: tables, relations, parameters, results, conditions', () => {
    const xml = `<GenericInquiryScreen><data-set><data><GIDesign>
      <row DesignID="d1" Name="Open Widgets" PrimaryScreenIDNew="DM301000">
        <GITable Alias="w" Name="Demo.Widget"><GIResult LineNbr="2" Field="qty" Caption="Qty" IsVisible="1" /><GIResult LineNbr="1" Field="widgetNbr" IsVisible="1" /></GITable>
        <GITable Alias="c" Name="Demo.Color" />
        <GIRelation ParentTable="w" ChildTable="c" JoinType="L"><GIOn ParentField="colorID" Condition="E " ChildField="colorID" /></GIRelation>
        <GIFilter Name="Color" FieldName="w.colorID" DataType="string" DisplayName="Color" Required="0" />
        <GIWhere LineNbr="1" DataFieldName="w.status" Condition="E " Value1="O" Operation="A" />
        <SiteMap><row Title="Open Widgets" ScreenID="GI000101" /></SiteMap>
      </row></GIDesign></data></data-set></GenericInquiryScreen>`;
    const s = buildSummary({ kind: 'gi', title: 'Open Widgets', elementText: xml });
    expect(s.facts).toEqual([
      ['Inquiry', 'Open Widgets'],
      ['Screen', 'GI000101'],
      ['Title', 'Open Widgets'],
      ['Primary screen', 'DM301000'],
      ['Design ID', 'd1'],
    ]);
    expect(Object.fromEntries(s.sections.map((x) => [x.heading, x.rows]))).toEqual({
      Tables: [
        ['w', 'Demo.Widget'],
        ['c', 'Demo.Color'],
      ],
      Relations: [['w', 'L', 'c', 'colorID E colorID']],
      Parameters: [['Color', 'w.colorID', 'string', 'Color', '']],
      Results: [
        ['1', 'w', 'widgetNbr', '', 'yes'],
        ['2', 'w', 'qty', 'Qty', 'yes'],
      ],
      Conditions: [['1', 'w.status', 'E', 'O', '', 'A']],
    });
  });

  it('ScreenWithRights: role rights with labels', () => {
    const s = buildSummary({
      kind: 'rights',
      title: 'DM301000',
      elementText: '<ScreenWithRights AccessRightsMergeRule="GrantAll"><data-set><data><SiteMap><row Title="Widgets" ScreenID="DM301000"><RolesInGraph Rolename="Admin" Accessrights="4" /><RolesInGraph Rolename="Viewer" Accessrights="1" /><RolesInCache Rolename="Viewer" CacheName="Demo.Widget" Accessrights="1" /></row></SiteMap></data></data-set></ScreenWithRights>',
    });
    expect(s.facts).toEqual([
      ['Screen', 'DM301000'],
      ['Title', 'Widgets'],
      ['Merge rule', 'GrantAll'],
    ]);
    expect(s.sections[0]?.rows).toEqual([
      ['Admin', 'Delete (4)'],
      ['Viewer', 'View Only (1)'],
    ]);
    expect(s.sections[1]?.rows).toEqual([['Viewer · Demo.Widget', 'Viewer', 'Demo.Widget', 'View Only (1)']]);
  });

  it('SiteMapNode: screen, title, URL, workspace, category', () => {
    const s = buildSummary({ kind: 'sitemap', title: 'DM301000', elementText: SITEMAP });
    expect(s.sections[0]?.rows).toEqual([['DM301000', 'Widgets', '~/Pages/DM/DM301000.aspx', 'Demo Workspace', 'Profiles']]);
    expect(s.facts).toContainEqual(['Workspace', 'Demo Workspace']);
  });

  it('CSAttribute: allowed values keyed by ValueID (sorted by SortOrder) and screens using it', async () => {
    const xml =
      '<CSAttribute><data-set><data><CSAttribute><row AttributeID="REGION" Description="Sales region" ControlType="2" IsInternal="0">' +
      '<CSAttributeDetail ValueID="WEST" Description="West" SortOrder="2" Disabled="0" />' +
      '<CSAttributeDetail ValueID="EAST" Description="East" SortOrder="1" Disabled="0" />' +
      '<CSAttributeDetail ValueID="OLD" Description="Retired" SortOrder="3" Disabled="1" />' +
      '<CSScreenAttribute ScreenID="AR303000" EntityClassID="RETAIL" Required="1" Hidden="0" />' +
      '</row></CSAttribute></data></data-set></CSAttribute>';
    const s = buildSummary({ kind: 'attribute', title: 'REGION', elementText: xml });
    expect(s.facts).toEqual([
      ['Attribute', 'REGION'],
      ['Description', 'Sales region'],
      ['Control type', '2'],
      ['Internal', 'no'],
      ['Values', '3'],
    ]);
    expect(s.sections[0]).toEqual({
      heading: 'Values',
      columns: ['ValueID', 'Description', 'Sort order', 'Disabled'],
      rows: [
        ['EAST', 'East', '1', 'no'],
        ['WEST', 'West', '2', 'no'],
        ['OLD', 'Retired', '3', 'yes'],
      ],
      keyColumn: 0,
    });
    expect(s.sections[1]?.rows).toEqual([['AR303000 · RETAIL', 'AR303000', 'RETAIL', 'yes', 'no', '']]);
    // through the indexer: CSAttribute lists its Summary first
    const idx = await buildIndex(proj(xml), '');
    expect(idx.items[0]?.views.map((v) => v.id)).toEqual(['summary', 'xml']);
  });

  it('MobileSiteMap: facts and script lines', () => {
    const s = buildSummary({ kind: 'mobileSitemap', title: 'DM301000', elementText: '<MobileSiteMap ScreenID="DM301000" Type="Screen" Script="add screen DM301000 {&#xA;  add container Document&#xA;}" />' });
    expect(s.facts).toEqual([
      ['Screen', 'DM301000'],
      ['Type', 'Screen'],
      ['Script', '3 lines'],
    ]);
  });

  it('facts: element attributes (long values summarized) and the first data row', () => {
    const s = buildSummary({ kind: 'facts', title: 'X', elementText: `<Mystery A="1" Big="${'x'.repeat(500)}"><data><row Name="r1" /></data></Mystery>`, extraFacts: [['Path', 'p']] });
    expect(s.facts).toEqual([
      ['Element', 'Mystery'],
      ['A', '1'],
      ['Big', '(500 characters)'],
      ['row Name', 'r1'],
      ['Path', 'p'],
    ]);
    expect(s.sections).toEqual([]);
  });

  it('viewSummary through the indexer: Page uses the decoded pageSource and site map title; files add path facts', async () => {
    const { ix } = await indexed(await open(packageA()));
    const page = await ix.viewSummary?.('Page:~/pages/dm/dm301000.aspx', 'a');
    expect(page?.facts.slice(0, 2)).toEqual([
      ['Screen', 'DM301000'],
      ['Title', 'Widgets'],
    ]);
    expect(page?.sections).toHaveLength(2);
    const html = await ix.viewSummary?.('PerTenantFile:screens\\DM\\DM301000\\DM301000.html', 'a');
    expect(html?.sections[0]?.heading).toBe('qp-fieldset fs1 · Document');
    expect(html?.facts.slice(0, 2)).toEqual([
      ['Screen', 'DM301000'],
      ['Title', 'Widgets'],
    ]);
    const aspxFile = await ix.viewSummary?.('File:Pages\\DM\\DM301000.aspx', 'a');
    expect(aspxFile?.facts[0]).toEqual(['Screen', 'DM301000']);
    const esc = await ix.viewSummary?.('Zip:App_Data/SnapshotConfigs/demo.esc', 'a');
    expect(esc?.facts).toContainEqual(['In project.xml', 'no']);
    expect(await ix.viewSummary?.('nope', 'a')).toBeNull();
  });
});

describe('search', () => {
  it('finds text in decoded ASPX, CDATA C# (once), zip text files and element XML, with line and column', async () => {
    const xml = proj(`${`<Graph ClassName="DemoGraph" FileType="NewGraph"><CDATA name="Source"><![CDATA[using PX.Data;\r\nclass DemoGraph {\r\n  // needleCs here\r\n}]]></CDATA></Graph>`}\r\n<Table TableName="needleTable" />`);
    const zip = buildZip([
      { name: 'project.xml', data: `${xml.replace('</Customization>', `<Page path="~/pages/dm/dm301000.aspx" pageSource="${deflate64('<%@ Page %>\r\n<px:PXGrid ID="needleAspx" />')}" />\r\n</Customization>`)}` },
      { name: 'App_Data/notes.txt', data: 'line one\nsecond needleTxt line' },
    ]);
    const { ix } = await indexed(await open(zip));
    const hits = (await ix.search?.('needle')) ?? [];
    const brief = hits.map((h) => `${h.itemId}|${h.side}|${h.view}|${h.line}:${h.column}|${h.preview}`);
    expect(brief).toEqual(
      expect.arrayContaining([
        'Graph:DemoGraph|a|code|3:6|// needleCs here',
        'Table:needleTable|a|xml|1:19|<Table TableName="needleTable" />',
        'Page:~/pages/dm/dm301000.aspx|a|code|2:16|<px:PXGrid ID="needleAspx" />',
        'Zip:App_Data/notes.txt|a|code|2:8|second needleTxt line',
      ]),
    );
    // the CDATA body matched in the code view is not reported again in the XML view
    expect(hits.filter((h) => h.itemId === 'Graph:DemoGraph')).toHaveLength(1);
    expect(hits).toHaveLength(4);

    expect(await ix.search?.('NEEDLECS', { caseSensitive: true })).toEqual([]);
    expect((await ix.search?.('needle(Cs|Txt)', { regex: true }))?.map((h) => h.itemId)).toEqual(['Graph:DemoGraph', 'Zip:App_Data/notes.txt']);
    expect(await ix.search?.('needle', { limit: 2 })).toHaveLength(2);
    await expect(ix.search?.('(', { regex: true })).rejects.toThrow(/Invalid regular expression/);
    expect(await ix.search?.('')).toEqual([]);
  });

  it('searches both sides and returns [] before anything is indexed', async () => {
    const ix = createProjectIndexer({ createWorker: inProcessWorker() });
    expect(await ix.search?.('x')).toEqual([]);
    await ix.index(proj('<Table TableName="Same" />'), proj('<Table TableName="Same" />'));
    expect((await ix.search?.('Same'))?.map((h) => h.side)).toEqual(['a', 'b']);
  });

  it('search over the large fixture pair is fast', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    if (!existsSync('fixtures/large-a.xml')) return;
    const ix = createProjectIndexer({ createWorker: inProcessWorker() });
    await ix.index(readFileSync('fixtures/large-a.xml', 'utf8'), readFileSync('fixtures/large-b.xml', 'utf8'));
    await ix.search?.('warmup-not-found');
    const t0 = performance.now();
    const hits = (await ix.search?.('PXGraphExtension', { limit: 500 })) ?? [];
    const literal = performance.now() - t0;
    const t1 = performance.now();
    await ix.search?.('zzz-no-such-text-anywhere');
    const miss = performance.now() - t1;
    console.info(`[project] search large pair: 500-hit literal ${literal.toFixed(0)} ms, full-scan miss ${miss.toFixed(0)} ms`);
    expect(hits.length).toBe(500);
    expect(miss).toBeLessThan(1500); // sanity bound under parallel test load; the 300 ms gate is measured in the browser
  });
});

describe.skipIf(!existsSync('fixtures/package-a.zip'))('package fixture pair vs fixtures/package.changes.json', () => {
  interface PackageOracle {
    items: OracleItem[];
    counts: { total: number; byStatus: Record<string, number> };
    overview: Record<
      'a' | 'b',
      {
        name: string;
        kind: string;
        bytes: number;
        attributes: Record<string, string>;
        counts: Record<string, number>;
        screensInclude: string[];
        assemblies: { path: string; size: number }[];
        warningsInclude: string[];
      }
    >;
    searches: { query: string; itemId: string; side: 'a' | 'b'; line?: number; what: string }[];
  }

  it('items, overview and searches match the sidecar (loose fields skipped)', async () => {
    const oracle = JSON.parse(readFileSync('fixtures/package.changes.json', 'utf8')) as PackageOracle;
    const reader = createPackageReader();
    const a = await reader.open(blob(new Uint8Array(readFileSync('fixtures/package-a.zip'))), 'package-a.zip');
    const b = await reader.open(blob(new Uint8Array(readFileSync('fixtures/package-b.zip'))), 'package-b.zip');
    const { ix, idx } = await indexed(a, b);

    // Open with QA: a File element that points at a DLL or image is grouped by
    // kind (assemblies / images), like unreferenced zip files. Real packages
    // reference every DLL and image through File elements, so grouping them
    // under Files would leave those groups empty. Adjust the sidecar to match.
    const regroup = (it: OracleItem): string | null =>
      it.element !== 'File' ? null : /\.(dll|exe)$/i.test(it.id) ? 'assemblies' : /\.(png|jpe?g|gif|svg|ico|bmp|webp)$/i.test(it.id) ? 'images' : null;
    for (const it of oracle.items) {
      const g = regroup(it);
      if (!g) continue;
      for (const side of it.sides ?? []) {
        const c = oracle.overview[side].counts;
        c[it.group] = (c[it.group] ?? 0) - 1;
        if (c[it.group] === 0) delete c[it.group];
        c[g] = (c[g] ?? 0) + 1;
      }
      it.group = g;
    }

    applyPendingSidecarChanges(oracle.items);
    expect(oracleDiffs(idx.items, oracle.items)).toEqual([]);
    expect(idx.items).toHaveLength(oracle.counts.total);
    expect(idx.counts).toEqual(oracle.counts.byStatus);

    for (const side of ['a', 'b'] as const) {
      const want = oracle.overview[side];
      const o = ix.overview?.(side);
      expect(o).toMatchObject({ name: want.name, kind: want.kind, bytes: want.bytes, attributes: want.attributes, counts: want.counts, assemblies: want.assemblies });
      expect(o?.screens.map((s) => s.screenId)).toEqual(expect.arrayContaining(want.screensInclude));
      for (const w of want.warningsInclude) expect(o?.warnings.some((x) => x.includes(w))).toBe(true);
    }

    // CSAttribute values: B adds EAST to CTZONE; the Values section is keyed by ValueID.
    const zoneB = await ix.viewSummary?.('CSAttribute:CTZONE', 'b');
    const zoneA = await ix.viewSummary?.('CSAttribute:CTZONE', 'a');
    const valuesOf = (s: typeof zoneB) => s?.sections.find((x) => x.heading === 'Values');
    expect(valuesOf(zoneB)?.keyColumn).toBe(0);
    expect(valuesOf(zoneB)?.rows.map((r) => r[0])).toContain('EAST');
    expect(valuesOf(zoneA)?.rows.map((r) => r[0])).not.toContain('EAST');

    // DLL string literals are the assembly browser's job (merged by the UI).
    for (const s of oracle.searches.filter((x) => !/assembly browser/.test(x.what))) {
      const hits = (await ix.search?.(s.query)) ?? [];
      const hit = hits.find((h) => h.itemId === s.itemId && h.side === s.side && (s.line === undefined || h.line === s.line));
      expect(hit, `${s.what}: ${s.query}`).toBeDefined();
    }
  });
});
