// Owned by Languages. ProjectIndexer: Acumatica project explorer index, built
// in a worker. See INTERFACES.md "Project explorer" and DECISIONS.md D12.
import type { ItemViewKind, LanguageId, ProjectIndex, ProjectIndexer, ProjectItem, Side } from '../types';
import { emptyCounts, emptySide, sliceViewText, type BuiltIndex, type SideSlice } from './build';
import type { IndexRequest, IndexResponse } from './protocol';
import { looksLikeProject } from './scan';

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
   * Whether an optional language (today: 'json' for EditorUpdatedFields) can
   * be used; otherwise such views fall back to plaintext. Wire to
   * `id => registry.get(id)?.installed === true`. Checked on every index().
   */
  languageAvailable?: (id: LanguageId) => boolean;
}

/** Views whose preferred language is a remote pack. */
const OPTIONAL_LANGUAGES = new Set<LanguageId>(['json']);
const VIEW_CACHE_SIZE = 8;

const defaultWorker = (): WorkerLike => new Worker(new URL('./project.worker.ts', import.meta.url), { type: 'module' });

const abortError = (): DOMException => new DOMException('Superseded by a newer index() call', 'AbortError');

export function createProjectIndexer(options: ProjectIndexerOptions = {}): ProjectIndexer {
  const createWorker = options.createWorker ?? defaultWorker;
  const available = options.languageAvailable ?? (() => false);
  let worker: WorkerLike | null = null;
  let seq = 0;
  let pending: { id: number; resolve: (r: ProjectIndex) => void; reject: (e: unknown) => void; a: string; b: string } | null = null;
  // State from the last completed index(): the texts (references, not copies) and item slices.
  let texts: Record<Side, string> = { a: '', b: '' };
  let slices = new Map<string, Record<Side, SideSlice | null>>();
  let generation = 0;
  const viewCache = new Map<string, Promise<string | null>>();
  let disposed = false;

  const kill = (): void => {
    worker?.terminate();
    worker = null;
  };

  const ensure = (): WorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (ev) => onMessage(ev.data);
    w.onerror = (ev) => {
      ev.preventDefault?.();
      const p = pending;
      pending = null;
      kill();
      p?.reject(new Error(`Project indexer worker failed: ${ev.message || 'unknown error'}`));
    };
    worker = w;
    return w;
  };

  const finish = (built: BuiltIndex, a: string, b: string): ProjectIndex => {
    texts = { a, b };
    slices = new Map();
    generation++;
    viewCache.clear();
    const items: ProjectItem[] = built.items.map(({ slices: s, ...item }) => {
      slices.set(item.id, s);
      for (const v of item.views) if (OPTIONAL_LANGUAGES.has(v.language) && !available(v.language)) v.language = 'plaintext';
      return item;
    });
    return { sides: built.sides, items, counts: built.counts };
  };

  const onMessage = (msg: IndexResponse): void => {
    const p = pending;
    if (!p || p.id !== msg.id) return; // a stale reply
    pending = null;
    if (msg.ok) p.resolve(finish(msg.index, p.a, p.b));
    else p.reject(new Error(`Project indexing failed: ${msg.message}`));
  };

  return {
    index(a, b) {
      if (disposed) return Promise.reject(new Error('Project indexer is disposed'));
      if (pending) {
        // Supersede: stop the running scan outright, like the diff worker (D11).
        const old = pending;
        pending = null;
        kill();
        old.reject(abortError());
      }
      const pa = looksLikeProject(a);
      const pb = looksLikeProject(b);
      if (!pa && !pb) {
        return Promise.resolve(finish({ sides: { a: emptySide(), b: emptySide() }, items: [], counts: emptyCounts() }, a, b));
      }
      const id = ++seq;
      return new Promise<ProjectIndex>((resolve, reject) => {
        pending = { id, resolve, reject, a, b };
        // A side that isn't a project is sent as '' (nothing to copy or scan).
        ensure().postMessage({ id, a: pa ? a : '', b: pb ? b : '' });
      });
    },

    viewText(itemId: string, view: ItemViewKind['id'], side: Side): Promise<string | null> {
      const s = slices.get(itemId)?.[side];
      if (!s) return Promise.resolve(null);
      const key = `${generation}|${itemId}|${view}|${side}`;
      let p = viewCache.get(key);
      if (p) {
        viewCache.delete(key); // refresh LRU position
      } else {
        p = sliceViewText(texts[side], s, view);
        if (viewCache.size >= VIEW_CACHE_SIZE) {
          const oldest = viewCache.keys().next().value;
          if (oldest !== undefined) viewCache.delete(oldest);
        }
      }
      viewCache.set(key, p);
      return p;
    },

    dispose() {
      disposed = true;
      const p = pending;
      pending = null;
      kill();
      p?.reject(abortError());
      texts = { a: '', b: '' };
      slices = new Map();
      viewCache.clear();
    },
  };
}
