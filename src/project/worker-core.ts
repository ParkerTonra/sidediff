// The indexer worker's logic, separate from `self` so tests can run it in-process.
import type { Side } from '../types';
import { readEntry } from '../package/zip';
import { buildIndex, type PackageFiles } from './build';
import type { IndexRequest, IndexResponse, WorkerPackage } from './protocol';
import { searchIndex, warmSearchCache, type SearchState } from './search';

export function toPackageFiles(p: WorkerPackage): PackageFiles {
  if (p.kind === 'zip') {
    const byPath = new Map(p.records.map((r) => [r.path, r]));
    return {
      files: p.files,
      read: (path) => {
        const r = byPath.get(path);
        return r ? readEntry(p.blob, r) : Promise.reject(new Error(`"${path}" is not in the package`));
      },
    };
  }
  return {
    files: p.files,
    read: (path) => {
      const d = p.data[path];
      return d ? Promise.resolve(d) : Promise.reject(new Error(`"${path}" is not in the package`));
    },
  };
}

/** Handles messages one at a time; keeps the last index for search. */
export function createWorkerCore(): (msg: IndexRequest) => Promise<IndexResponse> {
  let state: SearchState | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const handle = async (msg: IndexRequest): Promise<IndexResponse> => {
    const t0 = performance.now();
    try {
      if (msg.type === 'index') {
        const packages: Partial<Record<Side, PackageFiles>> = {};
        for (const side of ['a', 'b'] as const) {
          const p = msg.packages[side];
          if (p) packages[side] = toPackageFiles(p);
        }
        const index = await buildIndex(msg.a, msg.b, packages);
        state = { texts: { a: msg.a, b: msg.b }, index, packages, cache: new Map() };
        return { type: 'index', id: msg.id, ok: true, index, workerMs: performance.now() - t0 };
      }
      const hits = state ? await searchIndex(state, msg.query, msg.options) : [];
      return { type: 'search', id: msg.id, ok: true, hits, workerMs: performance.now() - t0 };
    } catch (err) {
      return { type: msg.type, id: msg.id, ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

  return (msg) => {
    const next = queue.then(() => handle(msg));
    // After an index, warm the search cache (decoded pages, package text) in the background.
    queue = msg.type === 'index' ? next.then(() => (state ? warmSearchCache(state).catch(() => undefined) : undefined)) : next;
    return next;
  };
}
