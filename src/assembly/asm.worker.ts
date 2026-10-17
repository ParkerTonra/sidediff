// Assembly worker: metadata, search and IL for loaded assemblies (TypeScript only).
import { ilListing, loadAssembly, searchAssembly } from './model';
import type { LoadedAssembly } from './model';
import type { AsmRequest, AsmResponse } from './protocol';

const loaded = new Map<string, LoadedAssembly>();

function get(key: string): LoadedAssembly {
  const a = loaded.get(key);
  if (!a) throw new Error(`Assembly "${key}" is not loaded.`);
  return a;
}

self.onmessage = (ev: MessageEvent<AsmRequest>) => {
  const msg = ev.data;
  const reply = (r: AsmResponse): void => self.postMessage(r);
  try {
    switch (msg.type) {
      case 'load': {
        const a = loadAssembly(msg.bytes);
        loaded.set(msg.key, a);
        reply({ id: msg.id, ok: true, result: a.info });
        break;
      }
      case 'search':
        reply({ id: msg.id, ok: true, result: searchAssembly(get(msg.key), msg.query, msg.options) });
        break;
      case 'il':
        reply({ id: msg.id, ok: true, result: ilListing(get(msg.key), msg.token) });
        break;
      case 'unload':
        loaded.delete(msg.key);
        reply({ id: msg.id, ok: true, result: null });
        break;
    }
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
