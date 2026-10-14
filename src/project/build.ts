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
  /** Direct-children range for the "changes" view; -1 when none. */
  childStart: number;
  childEnd: number;
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
  /** `${element}:${identity}`, before duplicate numbering (that happens when matching). */
  base: string;
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
  if (view === 'changes') return changesText(text, s);
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

// --- matching -------------------------------------------------------------------------

const toSlice = (e: SideEntry): SideSlice => ({
  start: e.raw.start,
  end: e.raw.end,
  childStart: e.raw.childStart,
  childEnd: e.raw.childEnd,
  code: e.c.code?.source ?? null,
});

type Pair = [id: string, a: SideEntry | undefined, b: SideEntry | undefined];

/**
 * Pairs A and B items by base id. A unique base pairs directly. Within a run of
 * duplicates, identical elements pair first (so an insert, delete or move among
 * same-named elements doesn't shift every later pairing), then the rest pair in
 * document order; leftovers are only-a / only-b. Ids are numbered `base`,
 * `base#2`, … in A's order, then B-only leftovers.
 */
export function matchEntries(a: string, b: string, ea: SideEntry[], eb: SideEntry[]): Pair[] {
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
  const out: Pair[] = [];
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

export async function buildIndex(a: string, b: string): Promise<BuiltIndex> {
  const sa = scanSide(a);
  const sb = scanSide(b);
  const items: IndexedItem[] = [];

  const make = async (id: string, ea: SideEntry | undefined, eb: SideEntry | undefined): Promise<IndexedItem> => {
    // Group, name and views come from A when present, else B.
    const main = (ea ?? eb) as SideEntry;
    const slA = ea ? toSlice(ea) : null;
    const slB = eb ? toSlice(eb) : null;
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
    if (ea?.c.changes || eb?.c.changes) views.push({ id: 'changes', label: 'Changes', language: 'xml' });
    views.push({ id: 'xml', label: 'XML', language: 'xml' });

    let status: ItemStatus;
    const dv = views[0]?.id;
    if (!slA) status = 'only-b';
    else if (!slB) status = 'only-a';
    else if (dv === 'code') status = await codeStatus(a, b, slA.code, slB.code);
    else if (dv === 'changes') status = compareTexts(changesText(a, slA) ?? '', changesText(b, slB) ?? '');
    else status = compareTexts(elementLines(a, slA), elementLines(b, slB));

    const screenId = ea?.c.screenId ?? eb?.c.screenId;
    return {
      id,
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

  for (const [id, ea, eb] of matchEntries(a, b, sa.entries, sb.entries)) items.push(await make(id, ea, eb));

  const gi = (g: string) => GROUP_ORDER.indexOf(g as (typeof GROUP_ORDER)[number]);
  items.sort((x, y) => gi(x.group) - gi(y.group) || collator.compare(x.name, y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const counts = emptyCounts();
  for (const it of items) counts[it.status]++;
  return { sides: { a: sa.info, b: sb.info }, items, counts };
}
