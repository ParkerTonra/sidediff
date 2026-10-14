// Linear scanner for Acumatica customization exports. Not an XML parser: it
// walks the text once, finds the direct children of <Customization>, their
// start-tag attributes, line ranges and <CDATA name="…"> bodies. Pure (no DOM),
// so it runs in the worker and in node tests. See INTERFACES.md "Project
// explorer" and DECISIONS.md D12.

/** How far into an element we look for descendant identity attributes. */
export const DESCENDANT_SCAN_BYTES = 64 * 1024;

export interface CdataSection {
  /** The wrapper's name attribute, e.g. "Source"; '' for a bare section directly inside the item. */
  name: string;
  /**
   * Body pieces as [start, end) offsets. Exporters split a body containing
   * "]]>" into adjacent sections (`]]]]><![CDATA[>`); joining the pieces
   * restores the original text.
   */
  pieces: number[];
}

export interface RawItem {
  element: string;
  attrs: Record<string, string>;
  /** Offsets of `<` of the start tag and just past the end tag's `>`. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  cdata: CdataSection[];
  /** First value of each wanted attribute found on descendants (first 64 KB). */
  descendantAttrs: Record<string, string>;
  /** Count of descendant elements per name, for names asked for. */
  descendantCounts: Record<string, number>;
  /** Number of direct child elements (CDATA wrappers excluded). */
  childCount: number;
  /** Descendants named in `wants.capture`, with the CDATA sections inside each. */
  captured: CapturedElement[];
  /** Attributes of the first `wants.firstRow.element` that has one of `anyOf` (first 64 KB). */
  firstRow: Record<string, string> | null;
}

export interface CapturedElement {
  element: string;
  attrs: Record<string, string>;
  cdata: CdataSection[];
}

export interface ScanResult {
  isProject: boolean;
  rootAttrs: Record<string, string>;
  items: RawItem[];
  error?: string;
}

/** What the classifier wants from descendants of an element. */
export interface DescendantWants {
  attrs: readonly string[];
  count: readonly string[];
  capture?: readonly string[];
  firstRow?: { element: string; anyOf: readonly string[] };
}

export type WantsFor = (element: string, attrs: Record<string, string>) => DescendantWants | null;

const LT = 60; // <
const GT = 62; // >
const SLASH = 47;
const BANG = 33;
const QMARK = 63;
const DQ = 34;
const SQ = 39;

function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45 || c === 46 || c === 58 || c > 127;
}
function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY_RE, (m, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

class ScanError extends Error {}

/** Cheap check on the first few KB: is the root element <Customization>? */
export function looksLikeProject(text: string): boolean {
  return /^\uFEFF?\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<Customization[\s>/]/.test(text.slice(0, 8192));
}

export function scanProject(text: string, wantsFor: WantsFor = () => null): ScanResult {
  const n = text.length;
  let i = 0;
  // Incremental line counting: offsets are asked for in increasing order.
  let lineOff = 0;
  let line = 1;
  const lineAt = (off: number): number => {
    while (lineOff < off) {
      const nl = text.indexOf('\n', lineOff);
      if (nl === -1 || nl >= off) {
        lineOff = off;
        break;
      }
      line++;
      lineOff = nl + 1;
    }
    return line;
  };

  const fail = (msg: string, at: number): never => {
    throw new ScanError(`${msg} (line ${lineAt(Math.min(at, n))})`);
  };

  const skipPast = (needle: string, from: number, what: string): number => {
    const j = text.indexOf(needle, from);
    if (j === -1) fail(`Unexpected end of text inside ${what}`, from);
    return j + needle.length;
  };

  const readName = (from: number): number => {
    let j = from;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    return j;
  };

  /**
   * Parses a start tag whose name ends at `from`. Returns the offset after
   * `>` and whether it was self-closing; fills attrs if given.
   */
  const readTagRest = (from: number, attrs: Record<string, string> | null): { next: number; selfClosing: boolean } => {
    let j = from;
    for (;;) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) fail('Unexpected end of text inside a start tag', from);
      const c = text.charCodeAt(j);
      if (c === GT) return { next: j + 1, selfClosing: false };
      if (c === SLASH) {
        if (text.charCodeAt(j + 1) !== GT) fail('Malformed start tag', j);
        return { next: j + 2, selfClosing: true };
      }
      const nameEnd = readName(j);
      if (nameEnd === j) fail(`Unexpected character "${text[j]}" in a start tag`, j);
      const attrName = text.slice(j, nameEnd);
      j = nameEnd;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) !== 61 /* = */) fail(`Attribute ${attrName} has no value`, j);
      j++;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const q = text.charCodeAt(j);
      if (q !== DQ && q !== SQ) fail(`Attribute ${attrName} value is not quoted`, j);
      const close = text.indexOf(q === DQ ? '"' : "'", j + 1);
      if (close === -1) fail('Unexpected end of text inside an attribute value', j);
      if (attrs && !(attrName in attrs)) attrs[attrName] = decodeEntities(text.slice(j + 1, close));
      j = close + 1;
    }
  };

  /** Skips the XML declaration, comments and DOCTYPE before the root. */
  const skipMisc = (): void => {
    for (;;) {
      while (i < n && isSpace(text.charCodeAt(i))) i++;
      if (i >= n || text.charCodeAt(i) !== LT) return;
      const c = text.charCodeAt(i + 1);
      if (c === QMARK) i = skipPast('?>', i + 2, 'a processing instruction');
      else if (text.startsWith('<!--', i)) i = skipPast('-->', i + 4, 'a comment');
      else if (c === BANG && text.startsWith('<!DOCTYPE', i)) i = skipPast('>', i, 'a DOCTYPE');
      else return;
    }
  };

  const result: ScanResult = { isProject: false, rootAttrs: {}, items: [] };

  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    skipMisc();
    if (!text.startsWith('<Customization', i) || isNameChar(text.charCodeAt(i + 14))) return result;
    result.isProject = true;
    const rootTag = readTagRest(i + 14, result.rootAttrs);
    i = rootTag.next;
    if (rootTag.selfClosing) return result;

    for (;;) {
      const lt = text.indexOf('<', i);
      if (lt === -1) fail('Unexpected end of text: </Customization> is missing', n);
      i = lt;
      const c = text.charCodeAt(i + 1);
      if (c === BANG) {
        if (text.startsWith('<!--', i)) i = skipPast('-->', i + 4, 'a comment');
        else if (text.startsWith('<![CDATA[', i)) i = skipPast(']]>', i + 9, 'a CDATA section');
        else i = skipPast('>', i + 2, 'a declaration');
        continue;
      }
      if (c === QMARK) {
        i = skipPast('?>', i + 2, 'a processing instruction');
        continue;
      }
      if (c === SLASH) {
        const nameEnd = readName(i + 2);
        const name = text.slice(i + 2, nameEnd);
        if (name !== 'Customization') fail(`Unexpected </${name}> at the top level`, i);
        break;
      }
      result.items.push(scanItem());
    }
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    result.error = err.message;
  }
  return result;

  function scanItem(): RawItem {
    const start = i;
    const nameEnd = readName(i + 1);
    if (nameEnd === i + 1) fail('Malformed tag', i);
    const element = text.slice(i + 1, nameEnd);
    const attrs: Record<string, string> = {};
    const tag = readTagRest(nameEnd, attrs);
    i = tag.next;
    const item: RawItem = {
      element,
      attrs,
      start,
      end: i,
      startLine: lineAt(start),
      endLine: 0,
      cdata: [],
      descendantAttrs: {},
      descendantCounts: {},
      childCount: 0,
      captured: [],
      firstRow: null,
    };
    if (tag.selfClosing) {
      item.endLine = lineAt(i);
      return item;
    }

    const wants = wantsFor(element, attrs);
    const wantAttrs = wants?.attrs ?? [];
    const wantCount = new Set(wants?.count ?? []);
    const capture = new Set(wants?.capture ?? []);
    const rowWant = wants?.firstRow;
    let attrsDone = wantAttrs.length === 0;
    let rowDone = !rowWant;
    const firstWanted = wantAttrs[0];
    const descLimit = start + DESCENDANT_SCAN_BYTES;

    const stack: string[] = [element];
    let section: CdataSection | null = null; // inside <CDATA name="…">
    let bare: CdataSection | null = null; // bare <![CDATA[ directly inside the item
    let cap: CapturedElement | null = null;
    let capDepth = 0;

    while (stack.length) {
      const lt = text.indexOf('<', i);
      if (lt === -1) fail(`Unexpected end of text inside <${stack[stack.length - 1]}>`, n);
      i = lt;
      const c = text.charCodeAt(i + 1);
      if (c === BANG) {
        if (text.startsWith('<![CDATA[', i)) {
          const body = i + 9;
          const close = text.indexOf(']]>', body);
          if (close === -1) fail('Unexpected end of text inside a CDATA section', i);
          if (section) section.pieces.push(body, close);
          else if (stack.length === 1) {
            if (!bare) {
              bare = { name: '', pieces: [] };
              item.cdata.push(bare);
            }
            bare.pieces.push(body, close);
          }
          i = close + 3;
        } else if (text.startsWith('<!--', i)) i = skipPast('-->', i + 4, 'a comment');
        else i = skipPast('>', i + 2, 'a declaration');
        continue;
      }
      if (c === QMARK) {
        i = skipPast('?>', i + 2, 'a processing instruction');
        continue;
      }
      if (c === SLASH) {
        const ne = readName(i + 2);
        const name = text.slice(i + 2, ne);
        const open = stack.pop();
        if (name !== open) fail(`Expected </${open}> but found </${name}>`, i);
        const gt = text.indexOf('>', ne);
        if (gt === -1) fail('Unexpected end of text inside an end tag', i);
        i = gt + 1;
        if (name === 'CDATA') section = null;
        if (cap && stack.length === capDepth) cap = null;
        continue;
      }
      const ne = readName(i + 1);
      if (ne === i + 1) fail('Malformed tag', i);
      const name = text.slice(i + 1, ne);
      const isWrapper = name === 'CDATA';
      if (stack.length === 1 && !isWrapper) item.childCount++;
      if (wantCount.has(name)) item.descendantCounts[name] = (item.descendantCounts[name] ?? 0) + 1;
      const isCapture = capture.has(name);
      const isRow = !rowDone && rowWant !== undefined && name === rowWant.element && i < descLimit;
      const parse = isWrapper || isCapture || isRow || (!attrsDone && i < descLimit);
      const dAttrs: Record<string, string> | null = parse ? {} : null;
      const t = readTagRest(ne, dAttrs);
      i = t.next;
      if (dAttrs) {
        if (isWrapper) {
          if (!t.selfClosing) {
            section = { name: dAttrs.name ?? '', pieces: [] };
            item.cdata.push(section);
            cap?.cdata.push(section);
          }
        } else {
          if (isCapture) {
            const ce: CapturedElement = { element: name, attrs: dAttrs, cdata: [] };
            item.captured.push(ce);
            if (!t.selfClosing) {
              cap = ce;
              capDepth = stack.length;
            }
          }
          if (isRow && rowWant.anyOf.some((k) => dAttrs[k])) {
            item.firstRow = dAttrs;
            rowDone = true;
          }
          if (!attrsDone) {
            for (const k of wantAttrs) {
              const v = dAttrs[k];
              if (v !== undefined && !(k in item.descendantAttrs)) item.descendantAttrs[k] = v;
            }
            if (firstWanted !== undefined && firstWanted in item.descendantAttrs) attrsDone = true;
          }
        }
      }
      if (!t.selfClosing) stack.push(name);
    }
    item.end = i;
    item.endLine = lineAt(i);
    return item;
  }
}

/** Joined body of a CDATA section. */
export function cdataBody(text: string, s: CdataSection): string {
  if (s.pieces.length === 2) return text.slice(s.pieces[0], s.pieces[1]);
  let out = '';
  for (let k = 0; k < s.pieces.length; k += 2) out += text.slice(s.pieces[k], s.pieces[k + 1]);
  return out;
}

/** The element's own lines, verbatim (from its line start to its end-line end). */
export function elementLines(text: string, item: Pick<RawItem, 'start' | 'end'>): string {
  const from = text.lastIndexOf('\n', item.start - 1) + 1;
  let to = text.indexOf('\n', item.end);
  if (to === -1) to = text.length;
  else if (text.charCodeAt(to - 1) === 13) to--;
  return text.slice(from, to);
}
