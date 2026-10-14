// Owned by Languages. LanguageRegistry: bundled csharp/xml/plaintext, detect,
// and allowlisted remote TextMate packs (download → validate → IndexedDB).
import type { InstallResult, LanguageId, LanguageInfo, LanguagePack, LanguageRegistry, Unsubscribe } from '../types';
import bundledManifest from '../../languages/manifest.json';
import { cacheKey, createIdbCache, createMemoryCache, type PackCache } from './cache';
import { detectLanguage } from './detect';
import { MAX_PACK_BYTES, parseManifest, readCapped, verifyPackBytes, type LanguageManifest, type ManifestPack } from './validate';

export { detectLanguage } from './detect';
export { parseManifest, type LanguageManifest, type ManifestPack } from './validate';

/** What actually talks to Monaco. Injected in tests; dynamic import by default. */
export interface LanguageActivator {
  bundled(id: LanguageId): Promise<void>;
  textmate(def: { id: LanguageId; displayName: string; grammarText: string; sha256: string }): Promise<void>;
}

export interface RegistryOptions {
  /** Fetch the manifest from here instead of using the copy bundled at build time. */
  manifestUrl?: string;
  /** Use this manifest object (tests). Wins over manifestUrl. */
  manifest?: unknown;
  fetchFn?: typeof fetch;
  /** Defaults to globalThis.indexedDB; without one, installs last for the session only. */
  indexedDB?: IDBFactory;
  activator?: LanguageActivator;
  /** Network timeout for one pack download. */
  timeoutMs?: number;
}

const BUNDLED: { id: LanguageId; displayName: string }[] = [
  { id: 'csharp', displayName: 'C#' },
  { id: 'xml', displayName: 'XML' },
  { id: 'plaintext', displayName: 'Plain Text' },
];

const defaultActivator: LanguageActivator = {
  bundled: async (id) => (await import('./monaco-bridge')).activateBundled(id),
  textmate: async (def) => (await import('./monaco-bridge')).activateTextMate(def),
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createLanguageRegistry(options: RegistryOptions = {}): LanguageRegistry {
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const activator = options.activator ?? defaultActivator;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const idb = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  const cache: PackCache = idb ? createIdbCache(idb) : createMemoryCache();

  const packs = new Map<LanguageId, LanguagePack>();
  const activations = new Map<LanguageId, Promise<void>>();
  const listeners = new Set<() => void>();
  const installing = new Map<LanguageId, Promise<InstallResult>>();
  let cachedKeys = new Set<string>();
  let manifest: LanguageManifest = { version: 1, packs: [] };

  const emit = (): void => {
    for (const h of [...listeners]) {
      try {
        h();
      } catch (err) {
        console.error('[languages] onChange handler failed', err);
      }
    }
  };

  for (const b of BUNDLED) {
    packs.set(b.id, { ...b, source: 'bundled', activate: () => activator.bundled(b.id) });
  }

  // The bundled (or injected) manifest is parsed synchronously so list() has
  // the remote entries at once; a manifestUrl and the IndexedDB scan load in
  // the background, and onChange fires when the installed flags settle.
  const loadManifest = (raw: unknown): void => {
    try {
      manifest = parseManifest(raw);
    } catch (err) {
      console.error(`[languages] language manifest rejected: ${errMsg(err)}`);
    }
  };
  if (!options.manifestUrl || options.manifest !== undefined) loadManifest(options.manifest ?? bundledManifest);

  const ready: Promise<void> = (async () => {
    if (options.manifestUrl && options.manifest === undefined) {
      try {
        const res = await fetchFn(options.manifestUrl, { credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        loadManifest(await res.json());
      } catch (err) {
        console.error(`[languages] could not load the language manifest: ${errMsg(err)}`);
      }
    }
    try {
      cachedKeys = await cache.keys();
    } catch (err) {
      console.warn(`[languages] language cache unavailable: ${errMsg(err)}`);
    }
    // Only notify when something visible changed: remote entries appeared
    // (manifestUrl) or some are already installed from an earlier session.
    if ((options.manifestUrl && options.manifest === undefined) || manifest.packs.some((p) => cachedKeys.has(cacheKey(p.id, p.sha256)))) emit();
  })();

  const manifestPack = (id: LanguageId): ManifestPack | undefined => manifest.packs.find((p) => p.id === id);

  const remotePack = (mp: ManifestPack, grammarText: string, sha256: string): LanguagePack => ({
    id: mp.id,
    displayName: mp.displayName,
    source: 'remote',
    license: mp.license,
    activate: () => activator.textmate({ id: mp.id, displayName: mp.displayName, grammarText, sha256 }),
  });

  const info = (p: LanguagePack): LanguageInfo => ({
    id: p.id,
    displayName: p.displayName,
    source: p.source,
    installed: true,
    ...(p.license ? { license: p.license } : {}),
  });

  const activate = (pack: LanguagePack): Promise<void> => {
    let p = activations.get(pack.id);
    if (!p) {
      p = pack.activate().catch((err: unknown) => {
        activations.delete(pack.id);
        throw err;
      });
      activations.set(pack.id, p);
    }
    return p;
  };

  /** Loads a cached pack and re-verifies it; undefined if not cached. */
  const fromCache = async (mp: ManifestPack): Promise<LanguagePack | undefined> => {
    const key = cacheKey(mp.id, mp.sha256);
    const rec = await cache.get(key);
    if (!rec) return undefined;
    try {
      const v = await verifyPackBytes(mp, new TextEncoder().encode(rec.text));
      return remotePack(mp, v.text, v.sha256);
    } catch (err) {
      // Corrupt or tampered cache entry: drop it so a fresh install can run.
      await cache.delete(key).catch(() => undefined);
      cachedKeys.delete(key);
      throw new Error(`Cached ${mp.displayName} pack was invalid and has been removed; install it again. (${errMsg(err)})`, { cause: err });
    }
  };

  const download = async (mp: ManifestPack): Promise<Uint8Array> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchFn(mp.url, {
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          cache: 'no-cache',
          signal: ctl.signal,
        });
      } catch (err) {
        throw new Error(
          ctl.signal.aborted
            ? `Downloading ${mp.displayName} timed out after ${Math.round(timeoutMs / 1000)} s.`
            : `Could not download ${mp.displayName} (offline or blocked): ${errMsg(err)}`,
          { cause: err },
        );
      }
      if (!res.ok) throw new Error(`Downloading ${mp.displayName} failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
      return await readCapped(res, MAX_PACK_BYTES, mp.displayName);
    } finally {
      clearTimeout(timer);
    }
  };

  const doInstall = async (id: LanguageId): Promise<InstallResult> => {
    await ready;
    const mp = manifestPack(id);
    if (!mp) return { ok: false, error: `"${id}" is not in the language allowlist (languages/manifest.json); only listed packs can be installed.` };
    try {
      let pack = await fromCache(mp).catch(() => undefined);
      let text: string | undefined;
      if (!pack) {
        const v = await verifyPackBytes(mp, await download(mp));
        text = v.text;
        pack = remotePack(mp, v.text, v.sha256);
      }
      // Activate before registering: if the grammar can't compile (or WASM is
      // blocked) the registry and cache stay unchanged.
      await pack.activate();
      if (text !== undefined) {
        const key = cacheKey(mp.id, mp.sha256);
        try {
          await cache.put({ key, id: mp.id, sha256: mp.sha256, format: mp.format, text, cachedAt: Date.now() });
          cachedKeys.add(key);
        } catch (err) {
          console.warn(`[languages] ${mp.displayName} installed for this session only; caching failed: ${errMsg(err)}`);
        }
      }
      packs.set(mp.id, pack);
      activations.set(mp.id, Promise.resolve());
      emit();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  };

  const list = (): LanguageInfo[] => {
    const out: LanguageInfo[] = BUNDLED.map((b) => info(packs.get(b.id) ?? { ...b, source: 'bundled', activate: () => Promise.resolve() }));
    for (const mp of manifest.packs) {
      const p = packs.get(mp.id);
      out.push(
        p
          ? info(p)
          : { id: mp.id, displayName: mp.displayName, source: 'remote', installed: cachedKeys.has(cacheKey(mp.id, mp.sha256)), license: mp.license },
      );
    }
    for (const p of packs.values()) {
      if (!out.some((o) => o.id === p.id)) out.push(info(p));
    }
    return out;
  };

  return {
    list,

    get(id) {
      return list().find((l) => l.id === id);
    },

    register(pack) {
      packs.set(pack.id, pack);
      activations.delete(pack.id);
      emit();
    },

    detect: detectLanguage,

    async ensureLoaded(id) {
      let pack = packs.get(id);
      if (!pack) {
        await ready;
        pack = packs.get(id);
      }
      if (!pack) {
        const mp = manifestPack(id);
        if (!mp) throw new Error(`Unknown language "${id}".`);
        const cached = await fromCache(mp);
        if (!cached) throw new Error(`${mp.displayName} is not installed. Use "Add language" to install it first.`);
        pack = cached;
        packs.set(id, pack);
      }
      await activate(pack);
    },

    install(id) {
      let p = installing.get(id);
      if (!p) {
        p = doInstall(id).finally(() => installing.delete(id));
        installing.set(id, p);
      }
      return p;
    },

    onChange(handler): Unsubscribe {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
