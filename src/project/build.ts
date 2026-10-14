// Builds a ProjectIndex from two texts: scan → classify → number duplicates →
// match by id → status of the default view. Pure apart from WebCrypto-free
// web APIs (DecompressionStream, atob); runs in the worker and in node tests.
import type { ItemStatus, ItemViewKind, LanguageId, ProjectIndex, ProjectItem, ProjectSideInfo, Side } from '../types';
import { detectLanguage } from '../languages/detect';
import { classify, GROUP_ORDER, wantsFor, type Classified, type CodeSource } from './classify';
import { cdataBody, elementLines, scanProject, type CdataSection, type RawItem } from './scan';

/** What's needed to cut an item's views out of its side's text later. */
export interface SideSlice {
  start: number;
  end: number;
  code: CodeSource | null;
}

/** ProjectItem plus where its views live on each side (kept on the main thread). */
export interface IndexedItem extends ProjectItem {
  slices: Record<Side, SideSlice | null>;
}

export interface BuiltIndex extends Omit<ProjectIndex, 'items'> {
  items: IndexedItem[];
}

interface SideEntry {
  id: string;
  c: Classified;
  raw: RawItem;
}

export function emptySide(): ProjectSideInfo {
  return { isProject: false, attributes: {}, items: 0, parseMs: 0 };
}

export function emptyCounts(): Record<ItemStatus, number> {
  return { same: 0, whitespace: 0, modified: 0, 'only-a': 0, 'only-b': 0 };
}

function scanSide(text: string): { info: ProjectSideInfo; entries: SideEntry[] } {
  const t0 = performance.now();
  const scan = scanProject(text, wantsFor);
  const ordinals = new Map<string, number>();
  const seen = new Map<string, number>();
  const entries: SideEntry[] = [];
  for (const raw of scan.items) {
    const ord = (ordinals.get(raw.element) ?? 0) + 1;
    ordinals.set(raw.element, ord);
    const c = classify(raw, ord);
    const base = `${raw.element}:${c.identity}`;
    const dup = (seen.get(base) ?? 0) + 1;
    seen.set(base, dup);
    entries.push({ id: dup === 1 ? base : `${base}#${dup}`, c, raw });
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

/** Code text that needs no decoding; null for a deflate source. */
export function codeTextSync(text: string, src: CodeSource): string | null {
  switch (src.kind) {
    case 'cdata':
      return joinSections(text, src.sections);
    case 'fields':
      return src.fields.map((f) => (f.sections.length ? `${f.header}\n${f.sections.map((s) => cdataBody(text, s)).join('\n')}` : f.header)).join('\n\n');
    case 'json':
      return prettyJson(src.sections.map((s) => cdataBody(text, s)).join(''));
    case 'deflate':
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

export async function sliceViewText(text: string, s: SideSlice, view: ItemViewKind['id']): Promise<string | null> {
  if (view === 'xml') return elementLines(text, s);
  if (!s.code) return null;
  if (s.code.kind === 'deflate') {
    try {
      return await inflateBase64(s.code.base64);
    } catch (err) {
      return `<!-- SideDiff could not decode pageSource (${err instanceof Error ? err.message : String(err)}) -->\n${s.code.base64}`;
    }
  }
  return codeTextSync(text, s.code);
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

// --- index --------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export async function buildIndex(a: string, b: string): Promise<BuiltIndex> {
  const sa = scanSide(a);
  const sb = scanSide(b);
  const byIdB = new Map(sb.entries.map((e) => [e.id, e]));
  const items: IndexedItem[] = [];

  const make = async (ea: SideEntry | undefined, eb: SideEntry | undefined): Promise<IndexedItem> => {
    // Group, name and views come from A when present, else B.
    const main = (ea ?? eb) as SideEntry;
    const slA: SideSlice | null = ea ? { start: ea.raw.start, end: ea.raw.end, code: ea.c.code?.source ?? null } : null;
    const slB: SideSlice | null = eb ? { start: eb.raw.start, end: eb.raw.end, code: eb.c.code?.source ?? null } : null;
    const spec = ea?.c.code ?? eb?.c.code ?? null;
    const views: ItemViewKind[] = [];
    if (spec) {
      let language: LanguageId | null = spec.language;
      if (language === null) {
        const sample = ea?.c.code ? codeTextSync(a, ea.c.code.source) : eb?.c.code ? codeTextSync(b, eb.c.code.source) : null;
        language = (sample !== null ? detectLanguage(sample) : null) ?? 'plaintext';
      }
      views.push({ id: 'code', label: spec.label, language });
    }
    views.push({ id: 'xml', label: main.c.xmlLabel, language: 'xml' });

    let status: ItemStatus;
    if (!slA) status = 'only-b';
    else if (!slB) status = 'only-a';
    else if (views[0]?.id === 'code') status = await codeStatus(a, b, slA.code, slB.code);
    else status = compareTexts(elementLines(a, slA), elementLines(b, slB));

    const screenId = ea?.c.screenId ?? eb?.c.screenId;
    return {
      id: main.id,
      group: main.c.group,
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

  for (const ea of sa.entries) {
    const eb = byIdB.get(ea.id);
    byIdB.delete(ea.id);
    items.push(await make(ea, eb));
  }
  for (const eb of byIdB.values()) items.push(await make(undefined, eb));

  const gi = (g: string) => GROUP_ORDER.indexOf(g as (typeof GROUP_ORDER)[number]);
  items.sort((x, y) => gi(x.group) - gi(y.group) || collator.compare(x.name, y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const counts = emptyCounts();
  for (const it of items) counts[it.status]++;
  return { sides: { a: sa.info, b: sb.info }, items, counts };
}
