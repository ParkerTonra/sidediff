// IndexedDB cache for validated remote packs, keyed `${id}@${sha256}`.

const DB_NAME = 'sidediff-languages';
const DB_VERSION = 1;
const STORE = 'packs';

export interface CachedPack {
  key: string;
  id: string;
  sha256: string;
  format: string;
  /** Exact downloaded text; re-verified against the hash on every load. */
  text: string;
  cachedAt: number;
}

export interface PackCache {
  keys(): Promise<Set<string>>;
  get(key: string): Promise<CachedPack | undefined>;
  put(pack: CachedPack): Promise<void>;
  delete(key: string): Promise<void>;
}

export const cacheKey = (id: string, sha256: string): string => `${id}@${sha256}`;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export function createIdbCache(factory: IDBFactory): PackCache {
  let dbp: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('Could not open the language cache'));
      r.onblocked = () => reject(new Error('Language cache is blocked by another tab'));
    }).catch((err: unknown) => {
      dbp = undefined;
      throw err;
    });
    return dbp;
  };
  const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => (await open()).transaction(STORE, mode).objectStore(STORE);
  const done = (s: IDBObjectStore): Promise<void> =>
    new Promise((resolve, reject) => {
      s.transaction.oncomplete = () => resolve();
      s.transaction.onerror = () => reject(s.transaction.error ?? new Error('IndexedDB write failed'));
      s.transaction.onabort = () => reject(s.transaction.error ?? new Error('IndexedDB write aborted'));
    });

  return {
    async keys() {
      const all = await req((await tx('readonly')).getAllKeys());
      return new Set(all.filter((k): k is string => typeof k === 'string'));
    },
    async get(key) {
      const v: unknown = await req((await tx('readonly')).get(key));
      return isCachedPack(v) ? v : undefined;
    },
    async put(pack) {
      const s = await tx('readwrite');
      const finished = done(s);
      s.put(pack);
      await finished;
    },
    async delete(key) {
      const s = await tx('readwrite');
      const finished = done(s);
      s.delete(key);
      await finished;
    },
  };
}

/** Used when IndexedDB is unavailable (private mode, node): session-only. */
export function createMemoryCache(): PackCache {
  const m = new Map<string, CachedPack>();
  return {
    keys: () => Promise.resolve(new Set(m.keys())),
    get: (k) => Promise.resolve(m.get(k)),
    put: (p) => {
      m.set(p.key, p);
      return Promise.resolve();
    },
    delete: (k) => {
      m.delete(k);
      return Promise.resolve();
    },
  };
}

function isCachedPack(v: unknown): v is CachedPack {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.key === 'string' && typeof r.id === 'string' && typeof r.sha256 === 'string' && typeof r.text === 'string' && typeof r.format === 'string';
}
