// Owned by Languages. ProjectIndexer: Acumatica project explorer index, built
// in a worker; packages (zips) add file items, summaries, an overview and
// search. See INTERFACES.md "Project explorer" and "Packages … (Phase 5)".
import type {
  ItemSummary,
  ItemViewKind,
  LanguageId,
  PackageOverview,
  PackageSource,
  ProjectIndex,
  ProjectIndexer,
  ProjectItem,
  SearchHit,
  Side,
} from '../types';
import { zipHandleOf } from '../package';
import { crc32 } from '../package/zip';
import { emptyCounts, emptySide, inflateBase64, decodeFailure, sliceViewText, type BuiltIndex, type PackageFile, type SideOverview, type SideSlice } from './build';
import type { IndexRequest, IndexResponse, WorkerPackage } from './protocol';
import { looksLikeProject } from './scan';
import { buildSummary } from './summary';
import { elementLines } from './scan';

export interface WorkerLike {
  postMessage(msg: IndexRequest): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<IndexResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

export interface ProjectIndexerOptions {
  /** Injected in tests; defaults to the Vite-bundled project.worker. */
  createWorker?: () => WorkerLike;
  /**
   * Whether an optional language ('json', 'sql') can be used; otherwise such
   * views fall back to plaintext. Wire to `id => registry.get(id)?.installed === true`.
   * Checked on every index().
   */
  languageAvailable?: (id: LanguageId) => boolean;
}

/** Views whose preferred language is a remote pack. */
const OPTIONAL_LANGUAGES = new Set<LanguageId>(['json', 'sql']);
const VIEW_CACHE_SIZE = 8;
/** Foreign PackageSources (not from createPackageReader) are read up front, up to this per file. */
const FOREIGN_FILE_LIMIT = 8 * 1024 * 1024;

const defaultWorker = (): WorkerLike => new Worker(new URL('./project.worker.ts', import.meta.url), { type: 'module' });

const abortError = (): DOMException => new DOMException('Superseded by a newer index() call', 'AbortError');

interface Pending<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

async function workerPackage(src: PackageSource): Promise<WorkerPackage | undefined> {
  if (!src.entries.length) return undefined;
  const h = zipHandleOf(src);
  if (h) {
    return {
      kind: 'zip',
      blob: h.blob,
      records: h.records,
      files: h.records.map((r) => ({ path: r.path, kind: h.kinds[r.path] ?? 'binary', size: r.size, crc32: r.crc32 })),
    };
  }
  const files: PackageFile[] = [];
  const data: Record<string, Uint8Array> = {};
  for (const e of src.entries) {
    if (e.size > FOREIGN_FILE_LIMIT) continue;
    const bytes = await src.read(e.path);
    data[e.path] = bytes;
    files.push({ path: e.path, kind: e.kind, size: bytes.length, crc32: crc32(bytes) });
  }
  return { kind: 'bytes', files, data };
}

export function createProjectIndexer(options: ProjectIndexerOptions = {}): ProjectIndexer {
  const createWorker = options.createWorker ?? defaultWorker;
  const available = options.languageAvailable ?? (() => false);
  let worker: WorkerLike | null = null;
  let seq = 0;
  let pendingIndex: (Pending<ProjectIndex> & { id: number; texts: Record<Side, string>; packages: Partial<Record<Side, PackageSource>> }) | null = null;
  const pendingSearch = new Map<number, Pending<SearchHit[]>>();
  // State from the last completed index(): texts (references, not copies), item slices, packages, overviews.
  let texts: Record<Side, string> = { a: '', b: '' };
  let slices = new Map<string, Record<Side, SideSlice | null>>();
  let packages: Partial<Record<Side, PackageSource>> = {};
  let overviews: Record<Side, PackageOverview | null> = { a: null, b: null };
  let titles: Record<Side, Map<string, string>> = { a: new Map(), b: new Map() };
  /** True when the last index() ran in the worker, so search can use its state. */
  let workerHasState = false;
  let generation = 0;
  const viewCache = new Map<string, Promise<string | null>>();
  let disposed = false;

  const rejectAll = (err: unknown): void => {
    const p = pendingIndex;
    pendingIndex = null;
    p?.reject(err);
    for (const s of pendingSearch.values()) s.reject(err);
    pendingSearch.clear();
  };

  const kill = (): void => {
    worker?.terminate();
    worker = null;
    workerHasState = false;
  };

  const ensure = (): WorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (ev) => onMessage(ev.data);
    w.onerror = (ev) => {
      ev.preventDefault?.();
      kill();
      rejectAll(new Error(`Project indexer worker failed: ${ev.message || 'unknown error'}`));
    };
    worker = w;
    return w;
  };

  const overviewFor = (side: Side, o: SideOverview | null, src: PackageSource | undefined, text: string): PackageOverview | null => {
    if (!src && !text.trim()) return null;
    const { titles: _t, ...rest } = o ?? { attributes: {}, counts: {}, screens: [], assemblies: [], warnings: [], titles: {} };
    void _t;
    return {
      name: src?.name ?? (side === 'a' ? 'A' : 'B'),
      kind: src?.kind ?? 'xml',
      bytes: src?.bytes ?? new TextEncoder().encode(text).length,
      ...rest,
    };
  };

  const finish = (built: BuiltIndex | null, t: Record<Side, string>, pk: Partial<Record<Side, PackageSource>>, inWorker: boolean): ProjectIndex => {
    texts = t;
    packages = pk;
    slices = new Map();
    generation++;
    viewCache.clear();
    workerHasState = inWorker;
    const b: BuiltIndex = built ?? {
      sides: { a: emptySide(), b: emptySide() },
      items: [],
      counts: emptyCounts(),
      overviews: {
        a: { attributes: {}, counts: {}, screens: [], assemblies: [], warnings: [], titles: {} },
        b: { attributes: {}, counts: {}, screens: [], assemblies: [], warnings: [], titles: {} },
      },
    };
    overviews = {
      a: built ? overviewFor('a', b.overviews.a, pk.a, t.a) : null,
      b: built ? overviewFor('b', b.overviews.b, pk.b, t.b) : null,
    };
    titles = { a: new Map(Object.entries(b.overviews.a.titles)), b: new Map(Object.entries(b.overviews.b.titles)) };
    const items: ProjectItem[] = b.items.map(({ slices: s, ...item }) => {
      slices.set(item.id, s);
      for (const v of item.views) if (OPTIONAL_LANGUAGES.has(v.language) && !available(v.language)) v.language = 'plaintext';
      return item;
    });
    return { sides: b.sides, items, counts: b.counts };
  };

  const onMessage = (msg: IndexResponse): void => {
    if (msg.type === 'search') {
      const p = pendingSearch.get(msg.id);
      if (!p) return;
      pendingSearch.delete(msg.id);
      if (msg.ok) p.resolve(msg.hits);
      else p.reject(new Error(`Search failed: ${msg.message}`));
      return;
    }
    const p = pendingIndex;
    if (!p || p.id !== msg.id) return; // a stale reply
    pendingIndex = null;
    if (msg.ok) p.resolve(finish(msg.index, p.texts, p.packages, true));
    else p.reject(new Error(`Project indexing failed: ${msg.message}`));
  };

  const readFileText = (side: Side) => {
    const src = packages[side];
    return src ? (path: string) => src.readText(path) : undefined;
  };

  /** Text the summary builder needs besides the element (decoded page, file text, C#). */
  const summaryCode = async (side: Side, s: SideSlice): Promise<string | null> => {
    if (s.summary === 'page' || s.summary === 'dacCode') {
      const src = s.code;
      if (src?.kind === 'deflate') return inflateBase64(src.base64).catch((err: unknown) => decodeFailure(err, ''));
      return sliceViewText(texts[side], s, 'code', readFileText(side));
    }
    return null;
  };

  return {
    async index(a, b, pkgs = {}) {
      if (disposed) throw new Error('Project indexer is disposed');
      if (pendingIndex) {
        // Supersede: stop the running scan outright, like the diff worker (D11).
        kill();
        rejectAll(abortError());
      }
      const t: Record<Side, string> = { a: a || pkgs.a?.projectXml || '', b: b || pkgs.b?.projectXml || '' };
      const id = ++seq;
      const wp: Partial<Record<Side, WorkerPackage>> = {};
      for (const side of ['a', 'b'] as const) {
        const src = pkgs[side];
        if (src) {
          const p = await workerPackage(src);
          if (p) wp[side] = p;
        }
      }
      if (id !== seq) throw abortError(); // superseded while reading a foreign package
      const pa = looksLikeProject(t.a);
      const pb = looksLikeProject(t.b);
      if (!pa && !pb && !wp.a && !wp.b) {
        // Nothing to index: no worker, no copies of the texts.
        return finish(pkgs.a || pkgs.b ? { sides: { a: emptySide(), b: emptySide() }, items: [], counts: emptyCounts(), overviews: emptyOverviews(t, pkgs) } : null, t, pkgs, false);
      }
      return new Promise<ProjectIndex>((resolve, reject) => {
        pendingIndex = { id, resolve, reject, texts: t, packages: pkgs };
        // A side that isn't a project is sent as '' (nothing to copy or scan).
        ensure().postMessage({ type: 'index', id, a: pa ? t.a : '', b: pb ? t.b : '', packages: wp });
      });
    },

    viewText(itemId: string, view: ItemViewKind['id'], side: Side): Promise<string | null> {
      const s = slices.get(itemId)?.[side];
      if (!s || (view !== 'code' && view !== 'changes' && view !== 'xml')) return Promise.resolve(null);
      const key = `${generation}|${itemId}|${view}|${side}`;
      let p = viewCache.get(key);
      if (p) {
        viewCache.delete(key); // refresh LRU position
      } else {
        p = sliceViewText(texts[side], s, view, readFileText(side));
        if (viewCache.size >= VIEW_CACHE_SIZE) {
          const oldest = viewCache.keys().next().value;
          if (oldest !== undefined) viewCache.delete(oldest);
        }
      }
      viewCache.set(key, p);
      return p;
    },

    async viewBytes(itemId, side) {
      const s = slices.get(itemId)?.[side];
      const src = packages[side];
      if (!s?.file || !src) return null;
      return src.read(s.file.path);
    },

    async viewSummary(itemId, side): Promise<ItemSummary | null> {
      const s = slices.get(itemId)?.[side];
      if (!s) return null;
      const extraFacts: [string, string][] = [];
      if (s.file) {
        extraFacts.push(['Path', s.file.path], ['Size', `${s.file.size.toLocaleString('en-US')} bytes`], ['Kind', s.file.kind]);
        if (s.start < 0) extraFacts.push(['In project.xml', 'no']);
      }
      return buildSummary({
        kind: s.summary,
        title: s.title,
        elementText: s.start >= 0 ? elementLines(texts[side], s) : '',
        codeText: await summaryCode(side, s),
        titles: titles[side],
        extraFacts,
      });
    },

    overview(side) {
      return overviews[side];
    },

    search(query, opts = {}) {
      if (disposed) return Promise.reject(new Error('Project indexer is disposed'));
      if (!query || !worker || (!workerHasState && !pendingIndex)) return Promise.resolve([]);
      const id = ++seq;
      return new Promise<SearchHit[]>((resolve, reject) => {
        pendingSearch.set(id, { resolve, reject });
        ensure().postMessage({ type: 'search', id, query, options: opts });
      });
    },

    dispose() {
      disposed = true;
      kill();
      rejectAll(abortError());
      texts = { a: '', b: '' };
      slices = new Map();
      packages = {};
      overviews = { a: null, b: null };
      viewCache.clear();
    },
  };
}

function emptyOverviews(t: Record<Side, string>, pkgs: Partial<Record<Side, PackageSource>>): BuiltIndex['overviews'] {
  const one = (side: Side): SideOverview => ({
    attributes: {},
    counts: {},
    screens: [],
    assemblies: [],
    warnings: pkgs[side] && !t[side].trim() ? ['The package has no project.xml.'] : [],
    titles: {},
  });
  return { a: one('a'), b: one('b') };
}
