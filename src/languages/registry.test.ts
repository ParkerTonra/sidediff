import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLanguageRegistry, type LanguageActivator, type RegistryOptions } from './index';
import { createIdbCache, cacheKey } from './cache';
import { MAX_PACK_BYTES, parseManifest } from './validate';
import bundledManifest from '../../languages/manifest.json';
import type { LanguagePack } from '../types';

const FIXTURE = new Uint8Array(readFileSync(new URL('./__fixtures__/mini.tmLanguage.json', import.meta.url)));
const FIXTURE_SHA = createHash('sha256').update(FIXTURE).digest('hex');
const URL_MINI = 'https://cdn.jsdelivr.net/gh/example/grammars@1.2.3/mini.tmLanguage.json';

const manifestWith = (sha256 = FIXTURE_SHA) => ({
  version: 1,
  packs: [{ id: 'mini', displayName: 'Mini', format: 'tmlanguage-json', license: 'MIT', url: URL_MINI, sha256 }],
});

type Served = { body: Uint8Array | string; status?: number; headers?: Record<string, string> };

function fakeFetch(routes: Record<string, Served>) {
  const calls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return Promise.reject(new TypeError('Failed to fetch'));
    const body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body;
    return Promise.resolve(new Response(body as Uint8Array<ArrayBuffer>, { status: r.status ?? 200, headers: r.headers ?? {} }));
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const offlineFetch = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;

function stubActivator(opts: { failTextmate?: string } = {}) {
  const calls: string[] = [];
  const activator: LanguageActivator = {
    bundled: (id) => {
      calls.push(`bundled:${id}`);
      return Promise.resolve();
    },
    textmate: (def) => {
      calls.push(`textmate:${def.id}:${def.sha256.slice(0, 8)}`);
      // Proves the grammar text handed to Monaco is the verified download.
      expect(JSON.parse(def.grammarText)).toHaveProperty('scopeName', 'source.mini');
      return opts.failTextmate ? Promise.reject(new Error(opts.failTextmate)) : Promise.resolve();
    },
  };
  return { activator, calls };
}

let idb: IDBFactory;
beforeEach(() => {
  idb = new IDBFactory();
});

function make(overrides: Partial<RegistryOptions> = {}) {
  const { activator, calls } = stubActivator();
  const net = fakeFetch({ [URL_MINI]: { body: FIXTURE } });
  const registry = createLanguageRegistry({ manifest: manifestWith(), fetchFn: net.fn, indexedDB: idb, activator, ...overrides });
  return { registry, calls, net };
}

const snapshot = (r: ReturnType<typeof make>['registry']) => JSON.stringify(r.list());

describe('bundled languages', () => {
  it('lists csharp, xml, plaintext first, then manifest packs (not installed)', () => {
    const { registry } = make();
    expect(registry.list()).toEqual([
      { id: 'csharp', displayName: 'C#', source: 'bundled', installed: true },
      { id: 'xml', displayName: 'XML', source: 'bundled', installed: true },
      { id: 'plaintext', displayName: 'Plain Text', source: 'bundled', installed: true },
      { id: 'mini', displayName: 'Mini', source: 'remote', installed: false, license: 'MIT' },
    ]);
    expect(registry.get('xml')?.displayName).toBe('XML');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('ensureLoaded activates bundled packs once, with zero network', async () => {
    const { registry, calls, net } = make();
    await registry.ensureLoaded('csharp');
    await registry.ensureLoaded('csharp');
    await registry.ensureLoaded('xml');
    await registry.ensureLoaded('plaintext');
    expect(calls).toEqual(['bundled:csharp', 'bundled:xml', 'bundled:plaintext']);
    expect(net.calls).toEqual([]);
  });

  it('ensureLoaded rejects unknown ids and uninstalled remote packs without fetching', async () => {
    const { registry, net } = make();
    await expect(registry.ensureLoaded('cobol')).rejects.toThrow(/Unknown language "cobol"/);
    await expect(registry.ensureLoaded('mini')).rejects.toThrow(/Mini is not installed/);
    expect(net.calls).toEqual([]);
  });

  it('detect is exposed on the registry', () => {
    const { registry } = make();
    expect(registry.detect('<a/>')).toBe('xml');
    expect(registry.detect('using X;')).toBe('csharp');
    expect(registry.detect('plain')).toBeNull();
  });
});

describe('register / onChange', () => {
  it('register adds or replaces a pack and fires onChange; unsubscribe works', async () => {
    const { registry } = make();
    const seen: string[] = [];
    const off = registry.onChange(() => seen.push(registry.list().map((l) => l.id).join(',')));
    const activate = vi.fn(() => Promise.resolve());
    const pack: LanguagePack = { id: 'custom', displayName: 'Custom', source: 'remote', license: 'MIT', activate };
    registry.register(pack);
    expect(registry.get('custom')).toEqual({ id: 'custom', displayName: 'Custom', source: 'remote', installed: true, license: 'MIT' });
    await registry.ensureLoaded('custom');
    expect(activate).toHaveBeenCalledTimes(1);

    registry.register({ ...pack, displayName: 'Custom 2' });
    expect(registry.get('custom')?.displayName).toBe('Custom 2');
    await registry.ensureLoaded('custom');
    expect(activate).toHaveBeenCalledTimes(2); // replaced pack is re-activated

    off();
    registry.register({ ...pack, displayName: 'Custom 3' });
    expect(seen.filter((s) => s.includes('custom'))).toHaveLength(2);
  });

  it('a throwing onChange handler does not break others', () => {
    const { registry } = make();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = vi.fn();
    registry.onChange(() => {
      throw new Error('boom');
    });
    registry.onChange(ok);
    registry.register({ id: 'x1', displayName: 'X', source: 'remote', activate: () => Promise.resolve() });
    expect(ok).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('install', () => {
  it('downloads, verifies, caches in IndexedDB under id@sha256, registers, fires onChange', async () => {
    const { registry, calls, net } = make();
    const changed = vi.fn();
    registry.onChange(changed);
    const res = await registry.install('mini');
    expect(res).toEqual({ ok: true });
    expect(net.calls).toEqual([URL_MINI]);
    expect(calls).toEqual([`textmate:mini:${FIXTURE_SHA.slice(0, 8)}`]);
    expect(registry.get('mini')).toMatchObject({ source: 'remote', installed: true, license: 'MIT' });
    expect(changed).toHaveBeenCalled();

    const cached = await createIdbCache(idb).get(cacheKey('mini', FIXTURE_SHA));
    expect(cached?.text).toBe(new TextDecoder().decode(FIXTURE));
    expect(cached?.key).toBe(`mini@${FIXTURE_SHA}`);

    await registry.ensureLoaded('mini');
    expect(calls).toHaveLength(1); // already active
  });

  it('a new registry loads the cached pack offline (no fetch)', async () => {
    await make().registry.install('mini');

    const { activator, calls } = stubActivator();
    const fetchSpy = vi.fn(offlineFetch);
    const offline = createLanguageRegistry({ manifest: manifestWith(), fetchFn: fetchSpy, indexedDB: idb, activator });
    await new Promise<void>((resolve) => offline.onChange(resolve)); // cache scan settled
    expect(offline.get('mini')?.installed).toBe(true);
    await offline.ensureLoaded('mini');
    expect(calls).toEqual([`textmate:mini:${FIXTURE_SHA.slice(0, 8)}`]);
    // install() on a cached pack is a cache hit too.
    expect(await offline.install('mini')).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('concurrent installs share one download', async () => {
    const { registry, net } = make();
    const [a, b] = await Promise.all([registry.install('mini'), registry.install('mini')]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(net.calls).toHaveLength(1);
  });

  it('works without IndexedDB (session-only memory cache)', async () => {
    const { activator } = stubActivator();
    const net = fakeFetch({ [URL_MINI]: { body: FIXTURE } });
    const registry = createLanguageRegistry({ manifest: manifestWith(), fetchFn: net.fn, activator });
    expect(await registry.install('mini')).toEqual({ ok: true });
    await registry.ensureLoaded('mini');
  });

  it('a corrupted cache entry is dropped and re-downloaded', async () => {
    await make().registry.install('mini');
    const cache = createIdbCache(idb);
    const key = cacheKey('mini', FIXTURE_SHA);
    const rec = await cache.get(key);
    if (!rec) throw new Error('expected cache record');
    await cache.put({ ...rec, text: rec.text.replace('select', 'drop') });

    const fresh = make();
    await expect(fresh.registry.ensureLoaded('mini')).rejects.toThrow(/Cached Mini pack was invalid/);
    expect((await cache.keys()).has(key)).toBe(false);
    expect(await fresh.registry.install('mini')).toEqual({ ok: true });
    expect(fresh.net.calls).toEqual([URL_MINI]);
  });
});

describe('install rejections leave the registry unchanged', () => {
  async function expectRejected(opts: Partial<RegistryOptions> & { id?: string }, pattern: RegExp) {
    const { registry, net } = make(opts);
    const changed = vi.fn();
    registry.onChange(changed);
    const before = snapshot(registry);
    const res = await registry.install(opts.id ?? 'mini');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(pattern);
    expect(snapshot(registry)).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect((await createIdbCache(idb).keys()).size).toBe(0);
    await expect(registry.ensureLoaded(opts.id ?? 'mini')).rejects.toThrow();
    return net;
  }
  const serve = (s: Served) => fakeFetch({ [URL_MINI]: s }).fn;

  it('not in the manifest: never fetches', async () => {
    const net = await expectRejected({ id: 'evil' }, /not in the language allowlist/);
    expect(net?.calls).toEqual([]);
  });

  it('bundled ids cannot be installed', async () => {
    await make().registry.install('csharp').then((r) => expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/allowlist/) }));
  });

  it('oversized by Content-Length (body never read)', async () => {
    await expectRejected({ fetchFn: serve({ body: FIXTURE, headers: { 'content-length': String(MAX_PACK_BYTES + 1) } }) }, /over the 2\.0 MB limit/);
  });

  it('oversized by actual bytes (no or lying Content-Length)', async () => {
    const big = new Uint8Array(MAX_PACK_BYTES + 10).fill(0x20);
    await expectRejected({ fetchFn: serve({ body: big }) }, /over the 2\.0 MB limit/);
    await expectRejected({ fetchFn: serve({ body: big, headers: { 'content-length': '100' } }) }, /over the 2\.0 MB limit/);
  });

  it('malformed JSON', async () => {
    await expectRejected({ fetchFn: serve({ body: '{"scopeName": "source.mini", "patterns": [' }) }, /not valid JSON/);
  });

  it('schema-invalid grammar', async () => {
    await expectRejected({ fetchFn: serve({ body: '{"scopeName": "source.mini"}' }) }, /not a valid TextMate grammar: .*patterns/);
    await expectRejected({ fetchFn: serve({ body: '{"scopeName": "source.mini", "patterns": [{"match": 42}]}' }) }, /patterns\[0\]\.match must be a string/);
    await expectRejected({ fetchFn: serve({ body: '[1,2,3]' }) }, /not a valid TextMate grammar/);
  });

  it('hash mismatch (valid grammar, different bytes)', async () => {
    const tampered = new TextDecoder().decode(FIXTURE).replace('select|from|where', 'select|from|where|drop');
    await expectRejected({ fetchFn: serve({ body: tampered }) }, /integrity check/);
    await expectRejected({ manifest: manifestWith('0'.repeat(64)) }, /integrity check/);
  });

  it('HTTP error and network failure', async () => {
    await expectRejected({ fetchFn: serve({ body: 'nope', status: 503 }) }, /HTTP 503/);
    await expectRejected({ fetchFn: offlineFetch }, /Could not download Mini/);
  });

  it('activation failure (e.g. WASM blocked) does not register or cache', async () => {
    const { activator } = stubActivator({ failTextmate: 'WebAssembly.instantiate(): blocked by CSP' });
    await expectRejected({ activator }, /WebAssembly/);
  });

  it('fetch is called with credentials omitted and redirects refused', async () => {
    const { registry, net } = make();
    await registry.install('mini');
    const init = (net.fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });
});

describe('manifest', () => {
  it('the shipped manifest is valid, pinned, MIT, and has a real pack', () => {
    const m = parseManifest(bundledManifest);
    expect(m.packs.map((p) => p.id)).toEqual(expect.arrayContaining(['sql', 'json']));
    for (const p of m.packs) {
      expect(p.url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/microsoft\/vscode@\d+\.\d+\.\d+\/extensions\//);
      expect(p.license).toBe('MIT');
    }
  });

  it.each([
    [{ version: 2, packs: [] }, /version/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], url: 'https://evil.example/x.json' }] }, /url must be/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], url: 'https://cdn.jsdelivr.net/gh/a/b@latest/x.json' }] }, /url must be/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], url: 'https://cdn.jsdelivr.net/gh/a/b/x.json' }] }, /url must be/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], license: 'GPL-3.0' }] }, /MIT/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], format: 'javascript' }] }, /unsupported format/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], id: 'xml' }] }, /bundled/],
    [{ version: 1, packs: [{ ...manifestWith().packs[0], sha256: 'abc' }] }, /sha256/],
    [{ version: 1, packs: [manifestWith().packs[0], manifestWith().packs[0]] }, /duplicate/],
  ])('rejects %j', (raw, pattern) => {
    expect(() => parseManifest(raw)).toThrow(pattern);
  });

  it('a rejected manifest leaves only the bundled languages', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { registry } = make({ manifest: { version: 1, packs: [{ id: 'x' }] } });
    expect(registry.list().map((l) => l.id)).toEqual(['csharp', 'xml', 'plaintext']);
    err.mockRestore();
  });

  it('manifestUrl loads the manifest in the background', async () => {
    const { activator } = stubActivator();
    const net = fakeFetch({
      'manifest.json': { body: JSON.stringify(manifestWith()) },
      [URL_MINI]: { body: FIXTURE },
    });
    const registry = createLanguageRegistry({ manifestUrl: 'manifest.json', fetchFn: net.fn, indexedDB: idb, activator });
    expect(await registry.install('mini')).toEqual({ ok: true });
    expect(net.calls).toEqual(['manifest.json', URL_MINI]);
  });
});
