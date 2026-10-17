// Full-text search over every text view of every item on both sides, run in
// the indexer worker. Literal by default; optional case-sensitive and regex.
import type { SearchHit, SearchOptions, Side } from '../types';
import { decodeText } from '../package/zip';
import { codeTextSync, inflateBase64, type BuiltIndex, type PackageFiles, type SideSlice } from './build';

export interface SearchState {
  texts: Record<Side, string>;
  index: BuiltIndex;
  packages: Partial<Record<Side, PackageFiles>>;
  /** Decoded pageSources and package texts, filled on first search. */
  cache: Map<string, string | null>;
}

const DEFAULT_LIMIT = 500;
const PREVIEW = 200;

export function makeRegex(query: string, options: SearchOptions = {}): RegExp {
  const flags = options.caseSensitive ? 'g' : 'gi';
  if (options.regex) {
    try {
      return new RegExp(query, `${flags}m`);
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

/** Code-view text for search, using the cache for decoded or package text. */
async function codeText(state: SearchState, side: Side, s: SideSlice): Promise<string | null> {
  const src = s.code;
  if (!src) return null;
  if (src.kind === 'deflate') {
    const key = `deflate:${side}:${s.start}`;
    if (!state.cache.has(key)) {
      // A pageSource that won't decode isn't searchable as ASPX (its base64 is in the XML view).
      state.cache.set(key, await inflateBase64(src.base64).catch(() => null));
    }
    return state.cache.get(key) ?? null;
  }
  if (src.kind === 'file') {
    const key = `file:${side}:${src.path}`;
    const pkg = state.packages[side];
    if (!state.cache.has(key)) state.cache.set(key, pkg ? await pkg.read(src.path).then(decodeText, () => null) : null);
    return state.cache.get(key) ?? null;
  }
  return codeTextSync(state.texts[side], src);
}

/**
 * Decodes every pageSource and reads every package text file into the cache,
 * so the first search doesn't pay for it. Run right after indexing.
 */
export async function warmSearchCache(state: SearchState): Promise<void> {
  for (const item of state.index.items) {
    for (const side of ['a', 'b'] as const) {
      const s = item.slices[side];
      if (s?.code && (s.code.kind === 'deflate' || s.code.kind === 'file')) await codeText(state, side, s);
    }
  }
}

/** CDATA body ranges (absolute offsets) that the code view already covers. */
function coveredRanges(s: SideSlice): number[] {
  const src = s.code;
  if (!src) return [];
  const pieces: number[] = [];
  const push = (secs: { pieces: number[] }[]) => {
    for (const sec of secs) pieces.push(...sec.pieces);
  };
  if (src.kind === 'cdata' || src.kind === 'json') push(src.sections);
  else if (src.kind === 'fields') for (const f of src.fields) push(f.sections);
  return pieces;
}

function scan(text: string, re: RegExp, emit: (line: number, column: number, preview: string, offset: number) => boolean): void {
  re.lastIndex = 0;
  let line = 1;
  let lineStart = 0;
  let counted = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    const at = m.index;
    for (let nl = text.indexOf('\n', counted); nl !== -1 && nl < at; nl = text.indexOf('\n', nl + 1)) {
      line++;
      lineStart = nl + 1;
    }
    counted = at;
    let end = text.indexOf('\n', at);
    if (end === -1) end = text.length;
    let preview = text.slice(lineStart, end).replace(/\r$/, '');
    const col = at - lineStart;
    if (preview.length > PREVIEW) {
      const from = Math.max(0, Math.min(col - 60, preview.length - PREVIEW));
      preview = `${from > 0 ? '…' : ''}${preview.slice(from, from + PREVIEW)}…`;
    }
    if (!emit(line, col + 1, preview.trim(), at)) return;
  }
}

export async function searchIndex(state: SearchState, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  if (!query) return [];
  const re = makeRegex(query, options);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const hits: SearchHit[] = [];
  const full = () => hits.length >= limit;
  for (const item of state.index.items) {
    for (const side of ['a', 'b'] as const) {
      const s = item.slices[side];
      if (!s) continue;
      const code = await codeText(state, side, s);
      if (code) {
        scan(code, re, (line, column, preview) => {
          hits.push({ itemId: item.id, side, view: 'code', line, column, preview });
          return !full();
        });
        if (full()) return hits;
      }
      if (s.start >= 0) {
        // XML view: the element's own lines, minus CDATA bodies the code view already covered.
        const text = state.texts[side];
        const from = text.lastIndexOf('\n', s.start - 1) + 1;
        let to = text.indexOf('\n', s.end);
        if (to === -1) to = text.length;
        const covered = coveredRanges(s);
        const inCovered = (abs: number) => {
          for (let k = 0; k < covered.length; k += 2) if (abs >= (covered[k] as number) && abs < (covered[k + 1] as number)) return true;
          return false;
        };
        scan(text.slice(from, to), re, (line, column, preview, offset) => {
          if (covered.length && inCovered(from + offset)) return true;
          hits.push({ itemId: item.id, side, view: 'xml', line, column, preview });
          return !full();
        });
        if (full()) return hits;
      }
    }
  }
  return hits;
}
