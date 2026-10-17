// Builds a ProjectIndex from two texts (and optional package files): scan →
// classify → match by id → views → status of the default text view; plus the
// per-side overview data. Pure apart from web APIs (DecompressionStream, atob);
// runs in the worker and in node tests.
import type { FileKind, ItemStatus, ItemViewKind, LanguageId, ProjectGroup, ProjectIndex, ProjectItem, ProjectSideInfo, Side } from '../types';
import { detectLanguage } from '../languages/detect';
import { decodeText, extOf, normalizePath } from '../package/zip';
import { baseName, classify, GROUP_ORDER, screenIdFromPath, wantsFor, type Classified, type CodeSource, type SummaryKind } from './classify';
import { cdataBody, elementLines, scanProject, type CdataSection, type RawItem } from './scan';

/** One package file as the indexer sees it. */
export interface PackageFile {
  path: string;
  kind: FileKind;
  size: number;
  /** CRC-32 from the zip directory; equal CRC + size means equal content. */
  crc32: number;
}

/** A side's package: its files and a way to read them. */
export interface PackageFiles {
  files: PackageFile[];
  read(path: string): Promise<Uint8Array>;
}

/** The package file behind an item on one side. */
export type SliceFile = PackageFile;

/** What's needed to cut an item's views out of its side's text later. */
export interface SideSlice {
  /** Element offsets; -1 for a zip file nothing in project.xml references. */
  start: number;
  end: number;
  /** Direct-children range for the "changes" view; -1 when none. */
  childStart: number;
  childEnd: number;
  code: CodeSource | null;
  /** Package file backing this item on this side (File/PerTenantFile content, or a Zip: item). */
  file?: SliceFile;
  /** Summary builder for this side ('facts' = generic). */
  summary: SummaryKind;
  /** Display name for the summary title. */
  title: string;
}

/** ProjectItem plus where its views live on each side (kept on the main thread). */
export interface IndexedItem extends ProjectItem {
  slices: Record<Side, SideSlice | null>;
}

/** Overview data the worker can compute (the client adds name, kind and bytes). */
export interface SideOverview {
  attributes: Record<string, string>;
  counts: Partial<Record<ProjectGroup, number>>;
  screens: { screenId: string; title: string }[];
  assemblies: { path: string; size: number }[];
  warnings: string[];
  /** Screen titles from site map rows and pages, by screen id. */
  titles: Record<string, string>;
}

export interface BuiltIndex extends Omit<ProjectIndex, 'items'> {
  items: IndexedItem[];
  overviews: Record<Side, SideOverview>;
}

interface SideEntry {
  /** `${element}:${identity}`, before duplicate numbering (that happens when matching). */
  base: string;
  c: Classified;
  raw: RawItem;
  file?: PackageFile;
}

export function emptySide(): ProjectSideInfo {
  return { isProject: false, attributes: {}, items: 0, parseMs: 0 };
}

export function emptyCounts(): Record<ItemStatus, number> {
  return { same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 };
}

export const pathKey = (p: string): string => normalizePath(p).toLowerCase();

function scanSide(text: string): { info: ProjectSideInfo; entries: SideEntry[] } {
  const t0 = performance.now();
  const scan = scanProject(text, wantsFor);
  const ordinals = new Map<string, number>();
  const entries: SideEntry[] = [];
  for (const raw of scan.items) {
    const ord = (ordinals.get(raw.element) ?? 0) + 1;
    ordinals.set(raw.element, ord);
    const c = classify(raw, ord);
    entries.push({ base: `${raw.element}:${c.identity}`, c, raw });
  }
  const info: ProjectSideInfo = {
    isProject: scan.isProject,
    attributes: scan.rootAttrs,
    items: entries.length,
    parseMs: Math.round((performance.now() - t0) * 10) / 10,
  };
  if (scan.error) info.error = scan.error;
  return { info, entries };
}

// --- view text ------------------------------------------------------------------

const joinSections = (text: string, sections: CdataSection[]): string =>
  sections.length === 1 && sections[0] ? cdataBody(text, sections[0]) : sections.map((s) => `// ---- ${s.name} ----\n${cdataBody(text, s)}`).join('\n');

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Code text that needs no decoding or package read; null for deflate and file sources. */
export function codeTextSync(text: string, src: CodeSource): string | null {
  switch (src.kind) {
    case 'cdata':
      return joinSections(text, src.sections);
    case 'fields':
      return src.fields.map((f) => (f.sections.length ? `${f.header}\n${f.sections.map((s) => cdataBody(text, s)).join('\n')}` : f.header)).join('\n\n');
    case 'json':
      return prettyJson(src.sections.map((s) => cdataBody(text, s)).join(''));
    case 'deflate':
    case 'file':
      return null;
  }
}

/** Page pageSource: base64 of raw-deflate → text. Throws on bad input. */
export async function inflateBase64(b64: string): Promise<string> {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

export const decodeFailure = (err: unknown, b64: string): string => `<!-- SideDiff could not decode pageSource (${err instanceof Error ? err.message : String(err)}) -->\n${b64}`;

/**
 * Text of one view. `readFile` reads a package text file of this side (null
 * when the side has no package); file sources need it.
 */
export async function sliceViewText(text: string, s: SideSlice, view: ItemViewKind['id'], readFile?: (path: string) => Promise<string>): Promise<string | null> {
  if (view === 'xml') return s.start < 0 ? null : elementLines(text, s);
  if (view === 'changes') return changesText(text, s);
  if (view !== 'code' || !s.code) return null;
  if (s.code.kind === 'deflate') {
    try {
      return await inflateBase64(s.code.base64);
    } catch (err) {
      return decodeFailure(err, s.code.base64);
    }
  }
  if (s.code.kind === 'file') return readFile ? readFile(s.code.path) : null;
  return codeTextSync(text, s.code);
}

/** The lines of an element's direct children only (from the first one's line to the last one's). */
export function changesText(text: string, s: SideSlice): string | null {
  return s.childStart < 0 ? null : elementLines(text, { start: s.childStart, end: s.childEnd });
}

// --- status -----------------------------------------------------------------------

function trimmedEqual(a: string, b: string): boolean {
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length !== lb.length) return false;
  for (let k = 0; k < la.length; k++) if ((la[k] ?? '').trim() !== (lb[k] ?? '').trim()) return false;
  return true;
}

export function compareTexts(a: string, b: string): ItemStatus {
  if (a === b) return 'same';
  return trimmedEqual(a, b) ? 'whitespace' : 'modified';
}

async function codeStatus(a: string, b: string, sa: CodeSource | null, sb: CodeSource | null): Promise<ItemStatus> {
  if (!sa || !sb) return 'modified';
  if (sa.kind === 'deflate' && sb.kind === 'deflate') {
    if (sa.base64 === sb.base64) return 'same'; // equal bytes, no decoding
    try {
      return compareTexts(await inflateBase64(sa.base64), await inflateBase64(sb.base64));
    } catch {
      return 'modified';
    }
  }
  if (sa.kind === 'json' && sb.kind === 'json') {
    const ra = sa.sections.map((s) => cdataBody(a, s)).join('');
    const rb = sb.sections.map((s) => cdataBody(b, s)).join('');
    if (ra === rb) return 'same';
  }
  const ta = codeTextSync(a, sa);
  const tb = codeTextSync(b, sb);
  return ta === null || tb === null ? 'modified' : compareTexts(ta, tb);
}

async function fileStatus(fa: PackageFile, fb: PackageFile, pa: PackageFiles, pb: PackageFiles): Promise<ItemStatus> {
  if (fa.size === fb.size && fa.crc32 === fb.crc32) return 'same';
  if (fa.kind !== 'text' || fb.kind !== 'text') return 'modified';
  try {
    return compareTexts(decodeText(await pa.read(fa.path)), decodeText(await pb.read(fb.path)));
  } catch {
    return 'modified';
  }
}

// --- package files -------------------------------------------------------------------------

const OPTIONAL_BY_EXT: Record<string, LanguageId> = { json: 'json', sql: 'sql' };

/** Content view for a package file. */
function fileView(f: PackageFile): ItemViewKind {
  switch (f.kind) {
    case 'image':
      return { id: 'image', label: 'Image', language: 'plaintext' };
    case 'assembly':
      return { id: 'assembly', label: 'Assembly', language: 'plaintext' };
    case 'binary':
      return { id: 'binary', label: 'Binary', language: 'plaintext' };
    case 'text': {
      const e = extOf(f.path);
      if (e === 'cs') return { id: 'code', label: 'C#', language: 'csharp' };
      if (['aspx', 'ascx', 'html', 'htm', 'xml', 'config', 'rpx', 'resx', 'esc'].includes(e)) return { id: 'code', label: e.toUpperCase(), language: 'xml' };
      const opt = OPTIONAL_BY_EXT[e];
      if (opt) return { id: 'code', label: e.toUpperCase(), language: opt };
      return { id: 'code', label: e ? e.toUpperCase() : 'Text', language: 'plaintext' };
    }
  }
}

const groupForFile = (f: PackageFile): ProjectGroup => (f.kind === 'assembly' ? 'assemblies' : f.kind === 'image' ? 'images' : 'files');

/** Modern UI screens live under screens/<XX>/<XX123456>/… */
const screenFromZipPath = (p: string): string | undefined => screenIdFromPath(p) ?? /(?:^|\/)screens\/[a-z0-9]{2}\/([a-z]{2}\d{6})\//i.exec(p)?.[1]?.toUpperCase();

const fileSummaryKind = (f: PackageFile | undefined): SummaryKind => (f?.kind === 'text' && ['aspx', 'html', 'htm'].includes(extOf(f.path)) ? 'page' : 'facts');

// --- matching -------------------------------------------------------------------------

const toSlice = (e: SideEntry): SideSlice => ({
  start: e.raw.start,
  end: e.raw.end,
  childStart: e.raw.childStart,
  childEnd: e.raw.childEnd,
  code: e.file ? (e.file.kind === 'text' ? { kind: 'file', path: e.file.path } : null) : (e.c.code?.source ?? null),
  ...(e.file ? { file: e.file } : {}),
  summary: e.c.summary !== 'facts' ? e.c.summary : fileSummaryKind(e.file),
  title: e.c.name,
});

type Pair<T> = [id: string, a: T | undefined, b: T | undefined];

/**
 * Pairs A and B items by base id. A unique base pairs directly. Within a run of
 * duplicates, identical elements pair first (so an insert, delete or move among
 * same-named elements doesn't shift every later pairing), then the rest pair in
 * document order; leftovers are only-a / only-b. Ids are numbered `base`,
 * `base#2`, … in A's order, then B-only leftovers.
 */
export function matchEntries(a: string, b: string, ea: SideEntry[], eb: SideEntry[]): Pair<SideEntry>[] {
  const group = (es: SideEntry[]) => {
    const m = new Map<string, SideEntry[]>();
    for (const e of es) {
      const l = m.get(e.base);
      if (l) l.push(e);
      else m.set(e.base, [e]);
    }
    return m;
  };
  const ga = group(ea);
  const gb = group(eb);
  const out: Pair<SideEntry>[] = [];
  const idFor = (base: string, k: number) => (k === 1 ? base : `${base}#${k}`);
  const emit = (base: string, la: SideEntry[], lb: SideEntry[]) => {
    if (la.length <= 1 && lb.length <= 1) {
      out.push([base, la[0], lb[0]]);
      return;
    }
    const text = (t: string, e: SideEntry) => t.slice(e.raw.start, e.raw.end);
    const matchOf: (number | undefined)[] = new Array<number | undefined>(la.length);
    const used = new Set<number>();
    const byText = new Map<string, number[]>();
    lb.forEach((e, j) => {
      const k = text(b, e);
      const q = byText.get(k);
      if (q) q.push(j);
      else byText.set(k, [j]);
    });
    la.forEach((e, i) => {
      const j = byText.get(text(a, e))?.shift();
      if (j !== undefined) {
        matchOf[i] = j;
        used.add(j);
      }
    });
    const rest = lb.map((_, j) => j).filter((j) => !used.has(j));
    let r = 0;
    la.forEach((_, i) => {
      if (matchOf[i] === undefined && r < rest.length) {
        matchOf[i] = rest[r++];
      }
    });
    let k = 0;
    la.forEach((e, i) => {
      const j = matchOf[i];
      out.push([idFor(base, ++k), e, j === undefined ? undefined : lb[j]]);
    });
    for (; r < rest.length; r++) {
      const j = rest[r];
      if (j !== undefined) out.push([idFor(base, ++k), undefined, lb[j]]);
    }
  };
  for (const [base, la] of ga) emit(base, la, gb.get(base) ?? []);
  for (const [base, lb] of gb) if (!ga.has(base)) emit(base, [], lb);
  return out;
}

// --- index --------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const TEXT_VIEWS = new Set<ItemViewKind['id']>(['code', 'changes', 'xml']);
const REFERENCING = new Set(['File', 'PerTenantFile']);
const SCREEN_GROUPS = new Set<ProjectGroup>(['screens', 'sitemap', 'inquiries']);
const MAX_LISTED_WARNINGS = 20;

export async function buildIndex(a: string, b: string, packages: Partial<Record<Side, PackageFiles>> = {}): Promise<BuiltIndex> {
  const texts: Record<Side, string> = { a, b };
  const scanned = { a: scanSide(a), b: scanSide(b) };
  const items: IndexedItem[] = [];
  const missing: Record<Side, string[]> = { a: [], b: [] };
  const zipOnly: Record<Side, Map<string, PackageFile>> = { a: new Map(), b: new Map() };

  // Attach package files to File/PerTenantFile elements; the rest become Zip: items.
  for (const side of ['a', 'b'] as const) {
    const pkg = packages[side];
    if (!pkg) continue;
    const byKey = new Map(pkg.files.map((f) => [pathKey(f.path), f]));
    const referenced = new Set<string>();
    for (const e of scanned[side].entries) {
      const p = REFERENCING.has(e.raw.element) ? e.raw.attrs.AppRelativePath : undefined;
      if (!p) continue;
      const key = pathKey(p);
      referenced.add(key);
      const f = byKey.get(key);
      if (f) e.file = f;
      // A File with its content inline (CDATA) isn't missing anything.
      else if (!e.raw.cdata.length) missing[side].push(p);
    }
    for (const [key, f] of byKey) if (!referenced.has(key)) zipOnly[side].set(key, f);
  }

  const make = async (id: string, ea: SideEntry | undefined, eb: SideEntry | undefined): Promise<IndexedItem> => {
    // Group, name and views come from A when present, else B.
    const main = (ea ?? eb) as SideEntry;
    const slA = ea ? toSlice(ea) : null;
    const slB = eb ? toSlice(eb) : null;
    const file = ea?.file ?? eb?.file;
    const views: ItemViewKind[] = [];
    if ((slA && slA.summary !== 'facts') || (slB && slB.summary !== 'facts')) views.push({ id: 'summary', label: 'Summary', language: 'plaintext' });
    if (file) {
      views.push(fileView(file));
    } else {
      const spec = ea?.c.code ?? eb?.c.code ?? null;
      if (spec) {
        let language: LanguageId | null = spec.language;
        if (language === null) {
          const sample = ea?.c.code ? codeTextSync(a, ea.c.code.source) : eb?.c.code ? codeTextSync(b, eb.c.code.source) : null;
          language = (sample !== null ? detectLanguage(sample) : null) ?? 'plaintext';
        }
        views.push({ id: 'code', label: spec.label, language });
      }
    }
    if (ea?.c.changes || eb?.c.changes) views.push({ id: 'changes', label: 'Changes', language: 'xml' });
    views.push({ id: 'xml', label: 'XML', language: 'xml' });
    if (!views.some((v) => v.id === 'summary')) views.push({ id: 'summary', label: 'Facts', language: 'plaintext' });

    let status: ItemStatus;
    if (!slA) status = 'only-b';
    else if (!slB) status = 'only-a';
    else if (ea?.file && eb?.file) status = await fileStatus(ea.file, eb.file, packages.a as PackageFiles, packages.b as PackageFiles);
    else if (ea?.file || eb?.file) status = compareTexts(elementLines(a, slA), elementLines(b, slB)); // reference-only side: compare the element
    else {
      const dv = views.find((v) => TEXT_VIEWS.has(v.id))?.id;
      if (dv === 'code') status = await codeStatus(a, b, slA.code, slB.code);
      else if (dv === 'changes') status = compareTexts(changesText(a, slA) ?? '', changesText(b, slB) ?? '');
      else status = compareTexts(elementLines(a, slA), elementLines(b, slB));
    }

    let group = main.c.group;
    if (file && main.raw.element === 'File' && file.kind !== 'text') group = groupForFile(file);
    const screenId = ea?.c.screenId ?? eb?.c.screenId;
    return {
      id,
      group,
      element: main.raw.element,
      name: main.c.name,
      detail: main.c.detail,
      ...(screenId ? { screenId } : {}),
      status,
      views,
      a: ea ? { startLine: ea.raw.startLine, endLine: ea.raw.endLine } : null,
      b: eb ? { startLine: eb.raw.startLine, endLine: eb.raw.endLine } : null,
      slices: { a: slA, b: slB },
    };
  };

  for (const [id, ea, eb] of matchEntries(a, b, scanned.a.entries, scanned.b.entries)) items.push(await make(id, ea, eb));

  // Zip files nothing references: `Zip:<path>`, matched across sides by path (any case).
  const zipKeys = new Set([...zipOnly.a.keys(), ...zipOnly.b.keys()]);
  for (const key of zipKeys) {
    const fa = zipOnly.a.get(key);
    const fb = zipOnly.b.get(key);
    const f = (fa ?? fb) as PackageFile;
    const slice = (x: PackageFile): SideSlice => ({
      start: -1,
      end: -1,
      childStart: -1,
      childEnd: -1,
      code: x.kind === 'text' ? { kind: 'file', path: x.path } : null,
      file: x,
      summary: fileSummaryKind(x),
      title: baseName(x.path),
    });
    const views: ItemViewKind[] = [];
    if (fileSummaryKind(f) !== 'facts') views.push({ id: 'summary', label: 'Summary', language: 'plaintext' });
    views.push(fileView(f));
    if (fileSummaryKind(f) === 'facts') views.push({ id: 'summary', label: 'Facts', language: 'plaintext' });
    const status: ItemStatus = !fa ? 'only-b' : !fb ? 'only-a' : await fileStatus(fa, fb, packages.a as PackageFiles, packages.b as PackageFiles);
    const screenId = screenFromZipPath(f.path);
    items.push({
      id: `Zip:${f.path}`,
      group: groupForFile(f),
      element: 'Zip',
      name: baseName(f.path),
      detail: 'not in project.xml',
      ...(screenId ? { screenId } : {}),
      status,
      views,
      // Line 0: present on that side, but not in project.xml.
      a: fa ? { startLine: 0, endLine: 0 } : null,
      b: fb ? { startLine: 0, endLine: 0 } : null,
      slices: { a: fa ? slice(fa) : null, b: fb ? slice(fb) : null },
    });
  }

  const gi = (g: string) => GROUP_ORDER.indexOf(g as (typeof GROUP_ORDER)[number]);
  items.sort((x, y) => gi(x.group) - gi(y.group) || collator.compare(x.name, y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const counts = emptyCounts();
  for (const it of items) counts[it.status]++;

  const overview = (side: Side): SideOverview => {
    const titles: Record<string, string> = {};
    for (const e of scanned[side].entries) {
      const sid = e.c.screenId;
      if (sid && e.c.title && !titles[sid]) titles[sid] = e.c.title;
    }
    const groupCounts: Partial<Record<ProjectGroup, number>> = {};
    const screens = new Map<string, string>();
    for (const it of items) {
      if (!it.slices[side]) continue;
      groupCounts[it.group] = (groupCounts[it.group] ?? 0) + 1;
      if (it.screenId && SCREEN_GROUPS.has(it.group) && !screens.has(it.screenId)) screens.set(it.screenId, titles[it.screenId] ?? '');
    }
    const pkg = packages[side];
    const warnings: string[] = [];
    const info = scanned[side].info;
    if (info.error) warnings.push(`project.xml could not be fully read: ${info.error}`);
    if (pkg && !texts[side].trim()) warnings.push('The package has no project.xml.');
    const miss = missing[side];
    for (const p of miss.slice(0, MAX_LISTED_WARNINGS)) warnings.push(`Listed in project.xml but missing from the zip: ${normalizePath(p)}`);
    if (miss.length > MAX_LISTED_WARNINGS) warnings.push(`…and ${miss.length - MAX_LISTED_WARNINGS} more files missing from the zip.`);
    const unref = zipOnly[side].size;
    if (unref) warnings.push(`${unref} file${unref === 1 ? '' : 's'} in the zip ${unref === 1 ? 'is' : 'are'} not referenced by project.xml.`);
    return {
      attributes: info.attributes,
      counts: groupCounts,
      screens: [...screens].map(([screenId, title]) => ({ screenId, title })).sort((x, y) => x.screenId.localeCompare(y.screenId)),
      assemblies: (pkg?.files ?? []).filter((f) => f.kind === 'assembly').map((f) => ({ path: f.path, size: f.size })),
      warnings,
      titles,
    };
  };

  return { sides: { a: scanned.a.info, b: scanned.b.info }, items, counts, overviews: { a: overview('a'), b: overview('b') } };
}
