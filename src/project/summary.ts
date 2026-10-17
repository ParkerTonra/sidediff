// Summary views (DECISIONS.md D18): renderer-agnostic tables that only restate
// what the XML/ASPX/HTML says. C# property parsing is a regex, marked best effort.
import type { ItemSummary, SummarySection } from '../types';
import type { SummaryKind } from './classify';
import { ancestor, descendants, findAll, findFirst, localName, parseAttrs, parseTree, type Node } from './tags';

export interface SummaryInput {
  kind: SummaryKind;
  /** Display name of the item, used as the title. */
  title: string;
  /** The element's own XML (empty for zip-only files). */
  elementText: string;
  /** Decoded ASPX/HTML, C# source or file text when the summary needs it. */
  codeText?: string | null;
  /** Screen titles known from the site map, by upper-case screen id. */
  titles?: ReadonlyMap<string, string>;
  /** Extra facts appended to the generic list (e.g. file path and size). */
  extraFacts?: [string, string][];
}

const MAX_FACT = 200;
const clip = (v: string): string => (v.length > MAX_FACT ? `(${v.length.toLocaleString('en-US')} characters)` : v);
const section = (heading: string, columns: string[], rows: string[][], keyColumn?: number): SummarySection =>
  keyColumn === undefined ? { heading, columns, rows } : { heading, columns, rows, keyColumn };
const nonEmpty = (sections: SummarySection[]): SummarySection[] => sections.filter((s) => s.rows.length);

function rootElement(xml: string): Node | undefined {
  return parseTree(xml).children.find((c) => c.name !== '#root');
}

/** Generic: the element's attributes, then its first data row's attributes. */
function factsOf(el: Node | undefined): [string, string][] {
  if (!el) return [];
  const facts: [string, string][] = [['Element', el.name]];
  for (const [k, v] of Object.entries(el.attrs)) facts.push([k, clip(v)]);
  const row = findFirst(el, (n) => n.name === 'row');
  if (row) for (const [k, v] of Object.entries(row.attrs)) if (v) facts.push([`row ${k}`, clip(v)]);
  return facts;
}

export function buildSummary(input: SummaryInput): ItemSummary {
  const el = input.elementText ? rootElement(input.elementText) : undefined;
  const base: ItemSummary = { title: input.title, facts: [...factsOf(el), ...(input.extraFacts ?? [])], sections: [] };
  try {
    switch (input.kind) {
      case 'dac':
        return el ? dacSummary(input.title, el) : base;
      case 'dacCode':
        return dacCodeSummary(input.title, input.codeText ?? el?.cdata ?? '');
      case 'table':
        return el ? tableSummary(input.title, el) : base;
      case 'sqlSchema':
        return sqlSchemaSummary(input.title, el ? findCdata(el, 'TableSchemaXml') : (input.codeText ?? ''));
      case 'page':
        return pageSummary(input.title, input.codeText ?? '', input.titles, el);
      case 'gi':
        return el ? giSummary(input.title, el) : base;
      case 'rights':
        return el ? rightsSummary(input.title, el) : base;
      case 'sitemap':
        return el ? sitemapSummary(input.title, el) : base;
      case 'mobileSitemap':
        return el ? mobileSitemapSummary(input.title, el) : base;
      case 'attribute':
        return el ? attributeSummary(input.title, el) : base;
      case 'facts':
        return base;
    }
  } catch (err) {
    base.facts.push(['Summary', `could not be built (${err instanceof Error ? err.message : String(err)})`]);
    return base;
  }
}

function findCdata(el: Node, wrapperName: string): string {
  const w = findFirst(el, (n) => n.name === 'CDATA' && n.attrs.name === wrapperName);
  return w?.cdata ?? '';
}

// --- DAC customization ---------------------------------------------------------------------

const attrNames = (src: string): string[] => [...src.matchAll(/\[\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1] as string);
const displayName = (src: string): string => /DisplayName\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(src)?.[1] ?? '';

function dacSummary(title: string, el: Node): ItemSummary {
  const rows = findAll(el, 'Field').map((f) => {
    const a = f.attrs;
    const text = findAll(f, 'CDATA').map((c) => c.cdata).join('\n') || f.cdata;
    return [a.FieldName ?? a.Name ?? '', a.TypeName ?? a.Type ?? '', a.StorageName ?? '', displayName(text), attrNames(text).join(', ')];
  });
  return {
    title,
    facts: [
      ['DAC', el.attrs.type ?? ''],
      ['Fields', String(rows.length)],
    ],
    sections: [section('Fields', ['Field', 'Type', 'Storage', 'DisplayName', 'Attributes'], rows, 0)],
  };
}

/** New DAC / DAC extension in C#: properties with their attributes (regex, best effort). */
function dacCodeSummary(title: string, src: string): ItemSummary {
  const rows: string[][] = [];
  const classes: string[] = [];
  let attrs: string[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    const cls = /\bclass\s+(\w+)\s*(?::\s*([^{]+))?/.exec(line);
    if (cls && !/\babstract\s+class\b/.test(line)) {
      classes.push(cls[2] ? `${cls[1]} : ${cls[2].trim()}` : (cls[1] as string));
      attrs = [];
      continue;
    }
    if (line.startsWith('[')) {
      attrs.push(line);
      continue;
    }
    const prop = /^(?:public|protected|internal)\s+(?:(?:virtual|override|new|static)\s+)*([\w.<>?,[\]\s]+?)\s+(\w+)\s*\{/.exec(line);
    if (prop && !/\babstract\s+class\b/.test(line)) {
      const a = attrs.join(' ');
      const names = attrNames(a);
      rows.push([prop[2] as string, (prop[1] as string).replace(/\s+/g, ' '), displayName(a), names.find((x) => /^PXDB/.test(x)) ?? '', names.join(', ')]);
    }
    if (line && !line.startsWith('//')) attrs = line.startsWith('[') ? attrs : [];
  }
  return {
    title,
    facts: [
      ...classes.map((c): [string, string] => ['Class', c]),
      ['Properties', String(rows.length)],
      ['Parsing', 'best effort (regex over the C# source)'],
    ],
    sections: [section('Properties', ['Property', 'Type', 'DisplayName', 'DB attribute', 'Attributes'], rows, 0)],
  };
}

// --- tables ---------------------------------------------------------------------------------

function tableSummary(title: string, el: Node): ItemSummary {
  const rows = findAll(el, 'Column').map((c) => {
    const a = c.attrs;
    const len = a.MaxLength ?? (a.DecimalPrecision ? `${a.DecimalPrecision},${a.DecimalLength ?? 0}` : '');
    return [a.ColumnName ?? '', a.ColumnType ?? '', a.AllowNull === 'True' ? 'yes' : a.AllowNull === 'False' ? 'no' : (a.AllowNull ?? ''), len, a.DefaultValue ?? ''];
  });
  return {
    title,
    facts: [
      ['Table', el.attrs.TableName ?? ''],
      ['Columns', String(rows.length)],
    ],
    sections: [section('Columns', ['Column', 'Type', 'Nullable', 'Length', 'Default'], rows, 0)],
  };
}

function sqlSchemaSummary(title: string, schemaXml: string): ItemSummary {
  const t = findFirst(parseTree(schemaXml), (n) => n.name === 'table');
  if (!t) return { title, facts: [['Schema', 'no <table> found']], sections: [] };
  const cols = t.children
    .filter((c) => c.name === 'col')
    .map((c) => {
      const type = c.attrs.type ?? '';
      const len = /\(([^)]*)\)/.exec(type)?.[1] ?? '';
      return [c.attrs.name ?? '', type, c.attrs.nullable === 'true' ? 'yes' : 'no', len, c.attrs.default ?? ''];
    });
  const idx = t.children
    .filter((c) => c.name === 'index')
    .map((i) => [
      i.attrs.name ?? '',
      i.children
        .filter((c) => c.name === 'col')
        .map((c) => c.attrs.name ?? '')
        .join(', '),
      i.attrs.unique === 'true' ? 'yes' : 'no',
      i.attrs.clustered === 'true' ? 'yes' : 'no',
      i.attrs.primary === 'true' ? 'yes' : 'no',
    ]);
  return {
    title,
    facts: [
      ['Table', t.attrs.name ?? ''],
      ['Columns', String(cols.length)],
      ['Indexes', String(idx.length)],
    ],
    sections: nonEmpty([section('Columns', ['Column', 'Type', 'Nullable', 'Length', 'Default'], cols, 0), section('Indexes', ['Index', 'Columns', 'Unique', 'Clustered', 'Primary'], idx, 0)]),
  };
}

// --- pages ------------------------------------------------------------------------------------

/** Classic ASPX: containers are controls with DataMember (forms, grid levels, tabs); fields carry DataField. */
function aspxOutline(tree: Node): { facts: [string, string][]; sections: SummarySection[] } {
  const facts: [string, string][] = [];
  const ds = findFirst(tree, (n) => localName(n.name) === 'PXDataSource');
  if (ds?.attrs.TypeName) facts.push(['Graph (TypeName)', ds.attrs.TypeName]);
  if (ds?.attrs.PrimaryView) facts.push(['Primary view', ds.attrs.PrimaryView]);
  const sections: SummarySection[] = [];
  const byContainer = new Map<Node, { rows: string[][]; seen: Set<string> }>();
  const order: Node[] = [];
  for (const n of descendants(tree)) {
    if (n.attrs.DataMember && !byContainer.has(n)) {
      byContainer.set(n, { rows: [], seen: new Set() });
      order.push(n);
    }
    const field = n.attrs.DataField;
    if (!field) continue;
    const owner = ancestor(n, (p) => byContainer.has(p));
    if (!owner) continue;
    const entry = byContainer.get(owner);
    if (!entry || entry.seen.has(field)) continue;
    entry.seen.add(field);
    const inColumns = ancestor(n, (p) => p.name === 'Columns') !== undefined;
    entry.rows.push([field, inColumns ? 'Grid column' : localName(n.name), n.attrs.CommitChanges === 'True' ? 'yes' : '']);
  }
  for (const c of order) {
    const entry = byContainer.get(c);
    if (!entry) continue;
    // A grid level's identity is its grid.
    const ctl = localName(c.name) === 'PXGridLevel' ? (ancestor(c, (p) => localName(p.name) === 'PXGrid') ?? c) : c;
    const caption = ctl.attrs.Caption ? ` "${ctl.attrs.Caption}"` : '';
    sections.push(section(`${localName(ctl.name)} ${ctl.attrs.ID ?? ''}${caption} · ${c.attrs.DataMember}`.replace(/\s+·/, ' ·'), ['Field', 'Control', 'Commit'], entry.rows, 0));
  }
  return { facts, sections };
}

/** Modern UI HTML: qp-* containers bound with view.bind; fields are <field name>. */
function htmlOutline(tree: Node): { facts: [string, string][]; sections: SummarySection[] } {
  const groups = new Map<string, string[][]>();
  const order: string[] = [];
  const add = (heading: string, row: string[]) => {
    if (!groups.has(heading)) {
      groups.set(heading, []);
      order.push(heading);
    }
    groups.get(heading)?.push(row);
  };
  for (const n of descendants(tree)) {
    const tag = n.name.toLowerCase();
    if (tag.startsWith('qp-') && n.attrs['view.bind'] && !findFirst(n, (x) => x.name.toLowerCase() === 'field')) {
      add(`${tag} ${n.attrs.id ?? ''} · ${n.attrs['view.bind']}`, ['(container)', tag, '']);
    }
    if (tag !== 'field' || !n.attrs.name) continue;
    const owner = ancestor(n, (p) => p.name.toLowerCase().startsWith('qp-') && p.attrs['view.bind'] !== undefined);
    const heading = owner ? `${owner.name.toLowerCase()} ${owner.attrs.id ?? ''} · ${owner.attrs['view.bind']}` : 'Fields';
    const how = ['after', 'before', 'remove', 'modify'].filter((k) => k in n.attrs).join(' ');
    add(heading, [n.attrs.name, 'field', how]);
  }
  const sections = order.map((h) => section(h.replace(/\s+·/, ' ·'), ['Field', 'Control', 'Placement'], (groups.get(h) ?? []).filter((r) => r[0] !== '(container)'), 0));
  return { facts: [], sections: sections.filter((s) => s.rows.length || /qp-grid/.test(s.heading)) };
}

function pageSummary(title: string, source: string, titles: ReadonlyMap<string, string> | undefined, el: Node | undefined): ItemSummary {
  // Page path, File/PerTenantFile AppRelativePath, or a zip file's name.
  const where = el?.attrs.path ?? el?.attrs.AppRelativePath ?? title;
  const screen = (/([a-z]{2}\d{6})(?:\.(?:aspx|html?)(?:\.cs)?)?$/i.exec(where)?.[1] ?? '').toUpperCase();
  const facts: [string, string][] = [];
  if (screen) facts.push(['Screen', screen]);
  const screenTitle = (screen && titles?.get(screen)) || el?.attrs.ScreenTitle;
  if (screenTitle) facts.push(['Title', screenTitle]);
  if (!source) return { title, facts: [...facts, ['Source', 'not available']], sections: [] };
  const tree = parseTree(source);
  const isAspx = /<%@|<px:|<asp:/i.test(source);
  const outline = isAspx ? aspxOutline(tree) : htmlOutline(tree);
  facts.push(['Kind', isAspx ? 'ASPX (classic UI)' : 'HTML (Modern UI)'], ...outline.facts, ['Containers', String(outline.sections.length)]);
  return { title, facts, sections: outline.sections };
}

// --- generic inquiry ---------------------------------------------------------------------------

function giSummary(title: string, el: Node): ItemSummary {
  const design = findFirst(el, (n) => n.name === 'row' && n.parent?.name === 'GIDesign');
  const siteRow = findFirst(el, (n) => n.name === 'row' && n.parent?.name === 'SiteMap' && !!n.attrs.ScreenID);
  const facts: [string, string][] = [];
  if (design?.attrs.Name) facts.push(['Inquiry', design.attrs.Name]);
  if (siteRow?.attrs.ScreenID) facts.push(['Screen', siteRow.attrs.ScreenID]);
  if (siteRow?.attrs.Title) facts.push(['Title', siteRow.attrs.Title]);
  if (design?.attrs.PrimaryScreenIDNew) facts.push(['Primary screen', design.attrs.PrimaryScreenIDNew]);
  if (design?.attrs.DesignID) facts.push(['Design ID', design.attrs.DesignID]);
  const scope = design ?? el;
  const tables = findAll(scope, 'GITable').map((t) => [t.attrs.Alias ?? '', t.attrs.Name ?? '']);
  const relations = findAll(scope, 'GIRelation').map((r) => {
    const on = r.children
      .filter((c) => c.name === 'GIOn')
      .map((o) => `${o.attrs.ParentField ?? ''} ${(o.attrs.Condition ?? '=').trim()} ${o.attrs.ChildField ?? ''}`.trim())
      .join(' AND ');
    return [r.attrs.ParentTable ?? '', r.attrs.JoinType ?? '', r.attrs.ChildTable ?? '', on];
  });
  const params = findAll(scope, 'GIFilter').map((f) => [f.attrs.Name ?? '', f.attrs.FieldName ?? '', f.attrs.DataType ?? '', f.attrs.DisplayName ?? '', f.attrs.Required === '1' || f.attrs.Required === 'True' ? 'yes' : '']);
  const results = findAll(scope, 'GIResult').map((r) => {
    const table = r.attrs.ObjectName ?? ancestor(r, (p) => p.name === 'GITable')?.attrs.Alias ?? '';
    return [r.attrs.LineNbr ?? '', table, r.attrs.Field ?? '', r.attrs.Caption ?? '', r.attrs.IsVisible === '0' ? 'no' : 'yes'];
  });
  const where = findAll(scope, 'GIWhere').map((w) => [w.attrs.LineNbr ?? '', w.attrs.DataFieldName ?? '', (w.attrs.Condition ?? '').trim(), w.attrs.Value1 ?? '', w.attrs.Value2 ?? '', w.attrs.Operation ?? '']);
  results.sort((x, y) => Number(x[0]) - Number(y[0]));
  return {
    title,
    facts,
    sections: nonEmpty([
      section('Tables', ['Alias', 'Table'], tables, 0),
      section('Relations', ['Parent', 'Join', 'Child', 'On'], relations),
      section('Parameters', ['Name', 'Field', 'Type', 'Display name', 'Required'], params, 0),
      section('Results', ['Line', 'Table', 'Field', 'Caption', 'Visible'], results, 2),
      section('Conditions', ['Line', 'Field', 'Condition', 'Value 1', 'Value 2', 'Operation'], where, 0),
    ]),
  };
}

// --- security, site map --------------------------------------------------------------------------

/** PXCacheRights / screen access levels as Acumatica shows them. */
const RIGHTS: Record<string, string> = { '0': 'Revoked', '1': 'View Only', '2': 'Edit', '3': 'Insert', '4': 'Delete' };
const rightsLabel = (v: string | undefined): string => (v === undefined ? '' : RIGHTS[v] ? `${RIGHTS[v]} (${v})` : v);

function rightsSummary(title: string, el: Node): ItemSummary {
  const site = findFirst(el, (n) => n.name === 'row' && !!n.attrs.ScreenID);
  const facts: [string, string][] = [];
  if (site?.attrs.ScreenID) facts.push(['Screen', site.attrs.ScreenID]);
  if (site?.attrs.Title) facts.push(['Title', site.attrs.Title]);
  if (el.attrs.AccessRightsMergeRule) facts.push(['Merge rule', el.attrs.AccessRightsMergeRule]);
  const graph = findAll(el, 'RolesInGraph').map((r) => [r.attrs.Rolename ?? '', rightsLabel(r.attrs.Accessrights)]);
  const cache = findAll(el, 'RolesInCache').map((r) => [`${r.attrs.Rolename ?? ''} · ${r.attrs.CacheName ?? ''}`, r.attrs.Rolename ?? '', r.attrs.CacheName ?? '', rightsLabel(r.attrs.Accessrights)]);
  const member = findAll(el, 'RolesInMember').map((r) => [`${r.attrs.Rolename ?? ''} · ${r.attrs.CacheName ?? ''}.${r.attrs.MemberName ?? ''}`, r.attrs.Rolename ?? '', `${r.attrs.CacheName ?? ''}.${r.attrs.MemberName ?? ''}`, rightsLabel(r.attrs.Accessrights)]);
  const roles = findAll(el, 'Roles').flatMap((r) => r.children.filter((c) => c.name === 'row').map((c) => [c.attrs.Rolename ?? '', c.attrs.Descr ?? c.attrs.Description ?? '']));
  return {
    title,
    facts,
    sections: nonEmpty([
      section('Screen rights', ['Role', 'Rights'], graph, 0),
      section('Cache rights', ['Key', 'Role', 'Cache', 'Rights'], cache, 0),
      section('Member rights', ['Key', 'Role', 'Member', 'Rights'], member, 0),
      section('Roles', ['Role', 'Description'], roles, 0),
    ]),
  };
}

function sitemapSummary(title: string, el: Node): ItemSummary {
  const tableOf = (name: string) => findFirst(el, (n) => n.name === name && n.parent?.name === 'data');
  const workspaces = new Map<string, string>();
  for (const r of tableOf('MUIWorkspace')?.children ?? []) if (r.attrs.WorkspaceID) workspaces.set(r.attrs.WorkspaceID, r.attrs.Title ?? '');
  const categories = new Map<string, string>();
  for (const r of tableOf('MUISubcategory')?.children ?? []) if (r.attrs.SubcategoryID) categories.set(r.attrs.SubcategoryID, r.attrs.Name ?? '');
  const rows = (tableOf('SiteMap')?.children ?? [])
    .filter((r) => r.name === 'row')
    .map((r) => {
      const mui = r.children.find((c) => c.name === 'MUIScreen');
      return [r.attrs.ScreenID ?? '', r.attrs.Title ?? '', r.attrs.Url ?? '', workspaces.get(mui?.attrs.WorkspaceID ?? '') ?? '', categories.get(mui?.attrs.SubcategoryID ?? '') ?? ''];
    });
  const first = rows[0];
  return {
    title,
    facts: first
      ? [
          ['Screen', first[0] ?? ''],
          ['Title', first[1] ?? ''],
          ['URL', first[2] ?? ''],
          ['Workspace', first[3] ?? ''],
          ['Category', first[4] ?? ''],
        ].filter((f): f is [string, string] => !!f[1])
      : [],
    sections: nonEmpty([section('Site map', ['Screen', 'Title', 'URL', 'Workspace', 'Category'], rows, 0)]),
  };
}

function mobileSitemapSummary(title: string, el: Node): ItemSummary {
  const a = el.attrs;
  const facts: [string, string][] = [['Screen', a.ScreenID ?? '']];
  if (a.Type) facts.push(['Type', a.Type]);
  const script = a.Script ?? el.cdata;
  if (script) facts.push(['Script', `${script.split(/\r?\n/).length} lines`]);
  const lines = script ? script.split(/\r?\n/).map((l, k) => [String(k + 1), l]) : [];
  return { title, facts, sections: nonEmpty([section('Script', ['Line', 'Text'], lines, 0)]) };
}

// --- user-defined attributes -----------------------------------------------------------------

/**
 * CSAttribute: the attribute row, its allowed values (CSAttributeDetail, keyed by
 * ValueID so compare mode diffs values) and the screens using it (CSScreenAttribute).
 */
function attributeSummary(title: string, el: Node): ItemSummary {
  const row = findFirst(el, (n) => n.name === 'row' && !!n.attrs.AttributeID);
  const a = row?.attrs ?? {};
  const facts: [string, string][] = [];
  if (a.AttributeID) facts.push(['Attribute', a.AttributeID]);
  if (a.Description) facts.push(['Description', a.Description]);
  if (a.ControlType) facts.push(['Control type', a.ControlType]);
  if (a.EntryMask) facts.push(['Entry mask', a.EntryMask]);
  if (a.RegExp) facts.push(['Validation', a.RegExp]);
  if (a.IsInternal) facts.push(['Internal', a.IsInternal === '1' || a.IsInternal === 'True' ? 'yes' : 'no']);
  const yes = (v: string | undefined) => (v === '1' || v === 'True' || v === 'true' ? 'yes' : v === undefined ? '' : 'no');
  const values = findAll(el, 'CSAttributeDetail')
    .map((d) => [d.attrs.ValueID ?? '', d.attrs.Description ?? '', d.attrs.SortOrder ?? '', yes(d.attrs.Disabled)])
    .sort((x, y) => (Number(x[2]) || 0) - (Number(y[2]) || 0));
  const screens = findAll(el, 'CSScreenAttribute').map((s) => {
    const k = s.attrs;
    return [`${k.ScreenID ?? ''}${k.EntityClassID ? ` · ${k.EntityClassID}` : ''}`, k.ScreenID ?? '', k.EntityClassID ?? '', yes(k.Required), yes(k.Hidden), k.DefaultValue ?? ''];
  });
  facts.push(['Values', String(values.length)]);
  return {
    title,
    facts,
    sections: nonEmpty([section('Values', ['ValueID', 'Description', 'Sort order', 'Disabled'], values, 0), section('Screens', ['Key', 'Screen', 'Class', 'Required', 'Hidden', 'Default'], screens, 0)]),
  };
}

/** Re-exported for tests. */
export { parseAttrs };
