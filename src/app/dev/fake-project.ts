// Dev-only ProjectIndexer fake plus a synthetic project pair generator.
// The real scanner lives in src/project/ (Languages). This one runs on the
// main thread and only understands the layout genProject() writes: one
// direct child of <Customization> per two-space-indented start tag.
import type {
  ItemStatus,
  ItemSummary,
  ItemViewKind,
  PackageEntry,
  PackageOverview,
  PackageSource,
  ProjectGroup,
  ProjectIndex,
  ProjectIndexer,
  ProjectItem,
  ProjectSideInfo,
  SearchHit,
  SearchOptions,
  Side,
} from '../../types';

const GROUP_ORDER: readonly ProjectGroup[] = [
  'code', 'screens', 'tables', 'sql', 'reports', 'inquiries', 'sitemap', 'integration', 'security', 'files', 'assemblies', 'images', 'other',
];

interface RawItem {
  element: string;
  attrs: Record<string, string>;
  startLine: number;
  endLine: number;
  lines: string[];
  cdata: string[];
}

interface Scan {
  info: ProjectSideInfo;
  items: Map<string, RawItem>;
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1] ?? ''] = m[2] ?? '';
  return out;
}

function scan(text: string): Scan {
  const t0 = performance.now();
  const lines = text.split(/\r?\n/);
  const items = new Map<string, RawItem>();
  const rootLine = lines.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('<?'));
  const root = lines[rootLine] ?? '';
  if (!/^\s*<Customization\b/.test(root)) {
    return { info: { isProject: false, attributes: {}, items: 0, parseMs: performance.now() - t0 }, items };
  }
  const counts = new Map<string, number>();
  let cur: RawItem | null = null;
  let depth = 0; // depth below the root element
  let inCdata = false;
  const tagRe = /<(\/?)([A-Za-z][\w.:-]*)((?:[^<>"]|"[^"]*")*?)(\/?)>/g;
  for (let i = rootLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (cur) cur.lines.push(line);
    // Strip CDATA bodies so tags inside code don't count.
    let outside = '';
    let rest = line;
    while (rest !== '') {
      if (inCdata) {
        const close = rest.indexOf(']]>');
        if (close < 0) break;
        inCdata = false;
        rest = rest.slice(close + 3);
      } else {
        const open = rest.indexOf('<![CDATA[');
        if (open < 0) { outside += rest; break; }
        outside += rest.slice(0, open);
        inCdata = true;
        rest = rest.slice(open + 9);
      }
    }
    for (const m of outside.matchAll(tagRe)) {
      const closing = m[1] === '/';
      const selfClosing = m[4] === '/';
      if (closing) {
        depth--;
        if (depth === 0 && cur) {
          cur.endLine = i + 1;
          add(cur);
          cur = null;
        }
      } else if (depth === 0 && !cur) {
        cur = { element: m[2] ?? '', attrs: attrsOf(m[3] ?? ''), startLine: i + 1, endLine: i + 1, lines: [line], cdata: [] };
        if (selfClosing) {
          add(cur);
          cur = null;
        } else depth++;
      } else if (!selfClosing) depth++;
    }
  }
  function add(item: RawItem): void {
    const body = item.lines.join('\n');
    for (const m of body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) item.cdata.push(m[1] ?? '');
    let id = `${item.element}:${identity(item)}`;
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    if (n > 1) id += `#${n}`;
    items.set(id, item);
  }
  return { info: { isProject: true, attributes: attrsOf(root), items: items.size, parseMs: performance.now() - t0 }, items };
}

const KEYS = ['Name', 'name', 'ScreenID', 'ClassName', 'TableName', 'ReportName', 'path', 'AppRelativePath', 'Title', 'Key'];
function identity(item: RawItem): string {
  for (const k of KEYS) if (item.attrs[k]) return item.attrs[k] ?? '';
  return '1';
}

function screenIdOf(item: RawItem): string | undefined {
  const a = item.attrs;
  const fromPath = /([a-z]{2}\d{6})\.aspx/i.exec(a.path ?? a.AppRelativePath ?? '')?.[1];
  return (a.ScreenID ?? a.ScreenId ?? fromPath)?.toUpperCase();
}

function classify(item: RawItem): { group: ProjectGroup; name: string; detail: string; views: ItemViewKind[] } {
  const a = item.attrs;
  const code = (language: string): ItemViewKind => ({ id: 'code', label: 'Code', language });
  const xml: ItemViewKind = { id: 'xml', label: 'XML', language: 'xml' };
  const withCode = (language: string): ItemViewKind[] => (item.cdata.length ? [code(language), xml] : [xml]);
  switch (item.element) {
    case 'Graph': {
      const kinds: Record<string, string> = { ExistingGraph: 'Graph extension', NewGraph: 'New graph', ExistingDac: 'DAC extension', NewDac: 'New DAC' };
      return { group: 'code', name: a.ClassName ?? '', detail: kinds[a.FileType ?? ''] ?? a.FileType ?? '', views: item.cdata.length ? [{ id: 'code', label: 'C#', language: 'csharp' }, xml] : [xml] };
    }
    case 'File': {
      const path = a.AppRelativePath ?? '';
      const isCs = path.endsWith('.cs');
      return { group: isCs ? 'code' : 'files', name: path.split(/[\\/]/).pop() ?? path, detail: path, views: withCode(isCs ? 'csharp' : /\.(aspx|xml|config)$/.test(path) ? 'xml' : 'plaintext') };
    }
    case 'Page': {
      const path = a.path ?? '';
      const file = path.split('/').pop() ?? path;
      return { group: 'screens', name: file.replace(/\.aspx$/i, '').toUpperCase(), detail: a.ScreenTitle ?? path, views: withCode('xml') };
    }
    case 'Table':
      return { group: 'tables', name: a.TableName ?? '', detail: `${item.lines.filter((l) => l.includes('<Column ')).length} columns`, views: [xml] };
    case 'Sql':
      return { group: 'sql', name: a.TableName ?? a.Name ?? '', detail: 'SQL script', views: withCode('plaintext') };
    case 'Report':
      return { group: 'reports', name: a.ReportName ?? a.Name ?? '', detail: 'Report', views: withCode('xml') };
    case 'SiteMapNode':
      return { group: 'sitemap', name: a.ScreenID ?? a.Title ?? '', detail: a.Title ?? '', views: [xml] };
    case 'GenericInquiryScreen':
      return { group: 'inquiries', name: a.Name ?? '', detail: 'Generic inquiry', views: [xml] };
    case 'ScreenWithRights':
      return { group: 'security', name: a.ScreenID ?? '', detail: 'Access rights', views: [xml] };
    case 'EntityEndpoint':
      return { group: 'integration', name: a.Name ?? '', detail: `Endpoint ${a.Version ?? ''}`.trim(), views: [xml] };
    default:
      return { group: 'other', name: identity(item), detail: item.element, views: [xml] };
  }
}

function viewOf(item: RawItem, view: ItemViewKind['id']): string {
  if (view === 'xml' || item.cdata.length === 0) return item.lines.join('\n');
  return item.cdata.length === 1 ? (item.cdata[0] ?? '') : item.cdata.join('\n// ---- section ----\n');
}

function statusOf(a: string, b: string): ItemStatus {
  if (a === b) return 'same';
  const trim = (s: string): string => s.split('\n').map((l) => l.trim()).join('\n');
  return trim(a) === trim(b) ? 'whitespace' : 'modified';
}

type ViewId = ItemViewKind['id'];

interface SideState {
  scan: Scan;
  pkg: PackageSource | null;
  /** Item id → zip path, for File items backed by a zip entry and for Zip: items. */
  files: Map<string, PackageEntry>;
}

const SUMMARY: ItemViewKind = { id: 'summary', label: 'Summary', language: 'plaintext' };
const SUMMARY_ELEMENTS = new Set(['Table', 'Page', 'GenericInquiryScreen', 'SiteMapNode', 'ScreenWithRights', 'Sql']);

function fileViews(entry: PackageEntry): ItemViewKind[] {
  const xml: ItemViewKind = { id: 'xml', label: 'XML', language: 'xml' };
  switch (entry.kind) {
    case 'image': return [{ id: 'image', label: 'Image', language: 'plaintext' }, xml];
    case 'assembly': return [{ id: 'assembly', label: 'Assembly', language: 'plaintext' }, xml];
    case 'binary': return [{ id: 'binary', label: 'Binary', language: 'plaintext' }, xml];
    default: {
      const language = /\.cs$/i.test(entry.path) ? 'csharp' : /\.(aspx|xml|config|esc|rpx|html?)$/i.test(entry.path) ? 'xml' : 'plaintext';
      return [{ id: 'code', label: /\.cs$/i.test(entry.path) ? 'C#' : 'Text', language }, xml];
    }
  }
}

function childRows(item: RawItem, tag: string): Record<string, string>[] {
  return item.lines.filter((l) => new RegExp(`<${tag}\\b`).test(l)).map((l) => attrsOf(l));
}

function summarize(item: RawItem): ItemSummary {
  const a = item.attrs;
  const facts = Object.entries(a).slice(0, 8) as [string, string][];
  switch (item.element) {
    case 'Table':
      return { title: `Table ${a.TableName ?? ''}`, facts, sections: [{ heading: 'Columns', columns: ['Column', 'Type'], keyColumn: 0, rows: childRows(item, 'Column').map((r) => [r.ColumnName ?? '', r.ColumnType ?? '']) }] };
    case 'Page': {
      const fields = childRows(item, 'PXField');
      const members = [...new Set(fields.map((f) => f.DataMember ?? ''))];
      return {
        title: `Screen ${screenIdOf(item) ?? ''}`, facts: [['Screen', screenIdOf(item) ?? ''], ['Title', a.ScreenTitle ?? '']],
        sections: members.map((m) => ({ heading: `PXFormView · ${m}`, columns: ['DataField', 'CommitChanges'], keyColumn: 0, rows: fields.filter((f) => f.DataMember === m).map((f) => [f.DataField ?? '', f.CommitChanges ?? '']) })),
      };
    }
    case 'ScreenWithRights':
      return { title: `Access rights ${a.ScreenID ?? ''}`, facts: [['Screen', a.ScreenID ?? '']], sections: [{ heading: 'Roles', columns: ['Role', 'Rights'], keyColumn: 0, rows: childRows(item, 'row').map((r) => [r.RoleName ?? '', r.Rights ?? '']) }] };
    case 'GenericInquiryScreen':
      return { title: `Generic inquiry ${a.Name ?? ''}`, facts, sections: [{ heading: 'Designs', columns: ['DesignID'], keyColumn: 0, rows: childRows(item, 'GIDesign').map((r) => [r.DesignID ?? '']) }] };
    default:
      return { title: `${item.element} ${identity(item)}`, facts, sections: [] };
  }
}

function lineHits(text: string, re: RegExp): { line: number; column: number; preview: string }[] {
  const out: { line: number; column: number; preview: string }[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    re.lastIndex = 0;
    const m = re.exec(l);
    if (m) out.push({ line: i + 1, column: m.index + 1, preview: l.trim().slice(0, 200) });
  });
  return out;
}

export function createFakeProjectIndexer(opts: { delayMs?: number } = {}): ProjectIndexer & { calls: number; viewDelayMs: number } {
  let last: Record<Side, SideState> | null = null;
  let lastItems: ProjectItem[] = [];
  let generation = 0;

  function sideState(text: string, pkg: PackageSource | null): SideState {
    const st: SideState = { scan: scan(text), pkg, files: new Map() };
    if (!pkg) return st;
    const byPath = new Map(pkg.entries.map((e) => [e.path.toLowerCase(), e]));
    const used = new Set<string>();
    for (const [id, raw] of st.scan.items) {
      const p = raw.attrs.AppRelativePath?.replace(/\\/g, '/').toLowerCase();
      const entry = p ? byPath.get(p) : undefined;
      if (entry) {
        st.files.set(id, entry);
        used.add(entry.path.toLowerCase());
      }
    }
    for (const e of pkg.entries) {
      if (used.has(e.path.toLowerCase())) continue;
      const id = `Zip:${e.path}`;
      st.scan.items.set(id, { element: 'Zip', attrs: { path: e.path }, startLine: 0, endLine: 0, lines: [], cdata: [] });
      st.files.set(id, e);
    }
    return st;
  }

  async function textOf(st: SideState, id: string, view: ViewId): Promise<string | null> {
    const raw = st.scan.items.get(id);
    if (!raw) return null;
    const entry = st.files.get(id);
    if (entry && view === 'code' && entry.kind === 'text' && st.pkg) return st.pkg.readText(entry.path);
    if (view === 'code' || view === 'xml' || view === 'changes') return raw.element === 'Zip' ? null : viewOf(raw, view);
    return null;
  }

  const indexer = {
    calls: 0,
    /** Simulated decode time per viewText call (Page sources are inflated on demand). */
    viewDelayMs: 0,
    async index(textA: string, textB: string, packages: Partial<Record<Side, PackageSource>> = {}): Promise<ProjectIndex> {
      const gen = ++generation;
      indexer.calls++;
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 150));
      if (gen !== generation) throw new DOMException('superseded', 'AbortError');
      const sides = { a: sideState(textA, packages.a ?? null), b: sideState(textB, packages.b ?? null) };
      last = sides;
      const ids = new Set([...sides.a.scan.items.keys(), ...sides.b.scan.items.keys()]);
      const items: ProjectItem[] = [];
      const counts: Record<ItemStatus, number> = { same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 };
      for (const id of ids) {
        const ra = sides.a.scan.items.get(id);
        const rb = sides.b.scan.items.get(id);
        const any = ra ?? rb;
        if (!any) continue;
        const entry = sides.a.files.get(id) ?? sides.b.files.get(id);
        let c = classify(any);
        if (any.element === 'Zip' && entry) {
          const group: ProjectGroup = entry.kind === 'assembly' ? 'assemblies' : entry.kind === 'image' ? 'images' : 'files';
          c = { group, name: entry.path.split('/').pop() ?? entry.path, detail: `${entry.path} · not in project.xml`, views: fileViews(entry).filter((v) => v.id !== 'xml') };
        } else if (entry) {
          c = { ...c, views: fileViews(entry), ...(entry.kind === 'assembly' ? { group: 'assemblies' as ProjectGroup } : entry.kind === 'image' ? { group: 'images' as ProjectGroup } : {}) };
        }
        if (SUMMARY_ELEMENTS.has(any.element)) c.views = [SUMMARY, ...c.views];
        const v = c.views.find((x) => x.id !== 'summary')?.id ?? 'xml';
        let status: ItemStatus;
        if (!ra) status = 'only-b';
        else if (!rb) status = 'only-a';
        else if (entry && entry.kind !== 'text') {
          const ea = sides.a.files.get(id);
          const eb = sides.b.files.get(id);
          const [ba, bb] = await Promise.all([ea && sides.a.pkg?.read(ea.path), eb && sides.b.pkg?.read(eb.path)]);
          status = ba && bb && ba.length === bb.length && ba.every((x, i) => x === bb[i]) ? 'same' : 'modified';
        } else status = statusOf((await textOf(sides.a, id, v)) ?? '', (await textOf(sides.b, id, v)) ?? '');
        counts[status]++;
        const screenId = any.element === 'Zip' ? undefined : screenIdOf(any);
        items.push({
          id, group: c.group, element: any.element, name: c.name, detail: c.detail, status, views: c.views,
          ...(screenId ? { screenId } : {}),
          a: ra ? { startLine: ra.startLine, endLine: ra.endLine } : null,
          b: rb ? { startLine: rb.startLine, endLine: rb.endLine } : null,
        });
      }
      items.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || x.name.localeCompare(y.name));
      lastItems = items;
      return { sides: { a: sides.a.scan.info, b: sides.b.scan.info }, items, counts };
    },
    async viewText(itemId: string, view: ViewId, side: Side): Promise<string | null> {
      if (indexer.viewDelayMs > 0) await new Promise((r) => setTimeout(r, indexer.viewDelayMs));
      const st = last?.[side];
      return st ? textOf(st, itemId, view) : null;
    },
    async viewBytes(itemId: string, side: Side): Promise<Uint8Array | null> {
      const st = last?.[side];
      const entry = st?.files.get(itemId);
      return st?.pkg && entry ? st.pkg.read(entry.path) : null;
    },
    async viewSummary(itemId: string, side: Side): Promise<ItemSummary | null> {
      const raw = last?.[side].scan.items.get(itemId);
      return raw && SUMMARY_ELEMENTS.has(raw.element) ? summarize(raw) : null;
    },
    overview(side: Side): PackageOverview | null {
      const st = last?.[side];
      if (!st || (!st.scan.info.isProject && !st.pkg)) return null;
      const counts: Partial<Record<ProjectGroup, number>> = {};
      const present = lastItems.filter((i) => i[side]);
      for (const i of present) counts[i.group] = (counts[i.group] ?? 0) + 1;
      const titles = new Map(present.filter((i) => i.group === 'sitemap').map((i) => [i.name, i.detail]));
      const screens = present.filter((i) => i.element === 'Page').map((i) => ({ screenId: i.name, title: titles.get(i.name) ?? i.detail }));
      const referenced = [...st.scan.items.values()].filter((r) => r.attrs.AppRelativePath).map((r) => (r.attrs.AppRelativePath ?? '').replace(/\\/g, '/'));
      const inZip = new Set(st.pkg?.entries.map((e) => e.path.toLowerCase()) ?? []);
      const missing = st.pkg ? referenced.filter((p) => !inZip.has(p.toLowerCase())) : [];
      const unreferenced = [...st.files.keys()].filter((k) => k.startsWith('Zip:')).length;
      return {
        name: st.pkg?.name ?? 'project.xml', kind: st.pkg?.kind ?? 'xml', bytes: st.pkg?.bytes ?? 0, attributes: st.scan.info.attributes, counts, screens,
        assemblies: st.pkg?.entries.filter((e) => e.kind === 'assembly').map((e) => ({ path: e.path, size: e.size })) ?? [],
        warnings: [
          ...missing.map((p) => `${p} is listed in project.xml but missing from the package`),
          ...(unreferenced ? [`${unreferenced} file${unreferenced === 1 ? '' : 's'} in the package ${unreferenced === 1 ? 'is' : 'are'} not referenced by project.xml`] : []),
        ],
      };
    },
    async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
      if (!last || !query) return [];
      const re = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.caseSensitive ? 'g' : 'gi');
      const limit = options.limit ?? 500;
      const hits: SearchHit[] = [];
      for (const item of lastItems) {
        for (const side of ['a', 'b'] as const) {
          if (!item[side]) continue;
          for (const v of item.views) {
            if (v.id !== 'code' && v.id !== 'xml' && v.id !== 'changes') continue;
            const text = await textOf(last[side], item.id, v.id);
            if (!text) continue;
            for (const h2 of lineHits(text, re)) {
              hits.push({ itemId: item.id, side, view: v.id, ...h2 });
              if (hits.length >= limit) return hits;
            }
          }
        }
      }
      return hits;
    },
    dispose(): void {
      last = null;
    },
  };
  return indexer;
}

// ---------- synthetic project pair ----------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MODULES = ['SO', 'PO', 'AP', 'AR', 'IN', 'GL', 'CR', 'PM', 'FA', 'CA'];
const NOUNS = ['Order', 'Invoice', 'Shipment', 'Receipt', 'Payment', 'Batch', 'Project', 'Customer', 'Vendor', 'Item', 'Asset', 'Case'];

/** A deterministic project pair with `n` items over every group, ~6% changed. */
export function genProject(n: number, seed = 7): { a: string; b: string } {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const a: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<Customization level="100" description="Fake project A" product-version="24.200.0012">'];
  const b: string[] = ['<?xml version="1.0" encoding="utf-8"?>', '<Customization level="100" description="Fake project B" product-version="24.206.0003">'];
  for (let i = 0; i < n; i++) {
    const mod = pick(MODULES);
    const noun = pick(NOUNS);
    const num = 100000 + i * 7;
    const kind = r();
    let el: string[];
    if (kind < 0.3) {
      const cls = `${mod}${noun}Entry${i}_Extension`;
      el = [`  <Graph ClassName="${cls}" FileType="${pick(['ExistingGraph', 'NewGraph', 'ExistingDac', 'NewDac'])}" IsNew="True">`, '    <CDATA name="Source"><![CDATA[using PX.Data;', `namespace Fake.${mod}`, '{', `    public class ${cls} : PXGraphExtension<${mod}${noun}Entry>`, '    {', `        public PXAction<${noun}> doThing${i};`, `        public static bool IsActive() => true;`, '    }', '}]]></CDATA>', '  </Graph>'];
    } else if (kind < 0.42) {
      const path = `App_Code/Caches/${mod}${noun}${i}.cs`;
      el = [`  <File AppRelativePath="${path}">`, `    <CDATA name="Content"><![CDATA[public class ${mod}${noun}${i} : PX.Data.IBqlTable { }]]></CDATA>`, '  </File>'];
    } else if (kind < 0.58) {
      el = [`  <Page path="~/pages/${mod.toLowerCase()}/${mod.toLowerCase()}${num}.aspx" ScreenTitle="${noun} ${i} maintenance">`, `    <PXField DataMember="${noun}" DataField="Usr${noun}${i}" CommitChanges="True" />`, `    <PXField DataMember="${noun}" DataField="UsrNote${i}" CommitChanges="False" />`, '  </Page>'];
    } else if (kind < 0.72) {
      el = [`  <Table TableName="${mod}${noun}${i}">`, `    <Column TableName="${mod}${noun}${i}" ColumnName="Usr${noun}ID" ColumnType="int" />`, `    <Column TableName="${mod}${noun}${i}" ColumnName="UsrAmount" ColumnType="decimal" />`, '  </Table>'];
    } else if (kind < 0.76) {
      el = [`  <Sql TableName="${mod}${noun}View${i}">`, `    <CDATA name="Script"><![CDATA[CREATE VIEW ${mod}${noun}View${i} AS SELECT * FROM ${noun}]]></CDATA>`, '  </Sql>'];
    } else if (kind < 0.8) {
      el = [`  <Report ReportName="${mod}${num}.rpx">`, `    <CDATA name="Body"><![CDATA[<Report Name="${mod}${num}"/>]]></CDATA>`, '  </Report>'];
    } else if (kind < 0.86) {
      el = [`  <SiteMapNode ScreenID="${mod}${num}" Title="${noun} ${i}" Url="~/pages/${mod}${num}.aspx" />`];
    } else if (kind < 0.9) {
      el = [`  <GenericInquiryScreen Name="${mod}-${noun}-GI-${i}">`, `    <GIDesign DesignID="${i}" />`, '  </GenericInquiryScreen>'];
    } else if (kind < 0.93) {
      el = [`  <EntityEndpoint Name="Fake${noun}${i}" Version="24.200.001" />`];
    } else if (kind < 0.96) {
      el = [`  <File AppRelativePath="Scripts/${mod.toLowerCase()}${i}.js">`, `    <CDATA name="Content"><![CDATA[console.log(${i});]]></CDATA>`, '  </File>'];
    } else {
      el = [`  <${pick(['MobileSiteMapNode', 'WikiArticle', 'Locale', 'SharedFilter'])} Name="${noun}${i}" />`];
    }
    const roll = r();
    if (roll < 0.015) { a.push(...el); continue; } // only in A
    if (roll < 0.03) { b.push(...el); continue; } // only in B
    a.push(...el);
    if (roll < 0.06 && el.length > 2) b.push(...el.map((l, j) => (j > 0 && j < el.length - 1 ? l.replace(/UsrAmount|Usr\w+\d|public static|CREATE|Name="/, (m) => `${m}X`) : l)));
    else if (roll < 0.075 && el.length > 2) b.push(...el.map((l, j) => (j === 1 ? `${l}  ` : l)));
    else b.push(...el);
  }
  a.push('</Customization>');
  b.push('</Customization>');
  return { a: a.join('\n'), b: b.join('\n') };
}
