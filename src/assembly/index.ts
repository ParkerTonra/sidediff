// Assembly browser: TypeScript metadata reader / IL disassembler / search in
// one worker, ICSharpCode.Decompiler on .NET WebAssembly in another (loaded on
// first decompile). Contract: AssemblyBrowser in src/types.ts. Owned by Editor.
import type { AsmSearchHit, AssemblyBrowser, AssemblyInfo, SearchOptions } from '../types';
import AsmWorker from './asm.worker?worker';
import DecompilerWorker from './decompiler.worker?worker';
import type { AsmRequest, AsmResponse, DecompilerRequest, DecompilerResponse } from './protocol';

/** Omit over each member of a union (plain Omit collapses unions). */
type Without<U, K extends PropertyKey> = U extends unknown ? Omit<U, K> : never;

/** Distributes the request/response pairs of one worker by id. */
class Rpc<Req extends { id: number }, Res extends { id: number; ok: boolean }> {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: Res) => void; reject: (e: Error) => void }>();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<Res>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      p.resolve(ev.data);
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      this.failAll(new Error(ev.message || 'worker failed'));
    };
  }

  call(msg: Without<Req, 'id'>, transfer: Transferable[] = []): Promise<Res> {
    const id = ++this.seq;
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  terminate(): void {
    this.failAll(new Error('assembly browser disposed'));
    this.worker.terminate();
  }
}

export interface AssemblyBrowserOptions {
  /** Folder holding the decompiler's _framework/ (default: `decompiler/` next to the page). */
  decompilerBase?: string;
}

/** Timing of the last decompile, for the bench and STATUS (not part of the contract). */
export interface DecompileTiming {
  loadMs?: number;
  ms: number;
}

export function createAssemblyBrowser(opts: AssemblyBrowserOptions = {}): AssemblyBrowser & { lastDecompile(): DecompileTiming | null } {
  let asm: Rpc<AsmRequest, AsmResponse> | null = null;
  let dec: Rpc<DecompilerRequest, DecompilerResponse> | null = null;
  let ready = false;
  let timing: DecompileTiming | null = null;
  let runtimeLoadMs: number | undefined;
  const bytesOf = new Map<string, Uint8Array>();
  /** Loads per key, so a key reloaded with other bytes never reuses a stale type system. */
  const generation = new Map<string, number>();

  const asmRpc = (): Rpc<AsmRequest, AsmResponse> => (asm ??= new Rpc(new AsmWorker()));

  const decRpc = (): Rpc<DecompilerRequest, DecompilerResponse> => {
    if (dec) return dec;
    dec = new Rpc(new DecompilerWorker());
    const base = opts.decompilerBase ?? new URL('decompiler/', document.baseURI).href;
    void dec.call({ type: 'init', base }).then((r) => {
      ready = r.ok;
      if (r.ok && r.loadMs !== undefined) runtimeLoadMs = r.loadMs;
    });
    return dec;
  };

  async function asmCall<T>(msg: Without<AsmRequest, 'id'>, transfer: Transferable[] = []): Promise<T> {
    const r = await asmRpc().call(msg, transfer);
    if (!r.ok) throw new Error(r.error);
    return r.result as T;
  }

  return {
    load(key, bytes) {
      bytesOf.set(key, bytes);
      generation.set(key, (generation.get(key) ?? 0) + 1);
      // The worker gets its own copy; the original stays here for the decompiler.
      const copy = bytes.slice();
      return asmCall<AssemblyInfo>({ type: 'load', key, bytes: copy }, [copy.buffer]);
    },

    search(key, query, options?: SearchOptions) {
      return asmCall<AsmSearchHit[]>({ type: 'search', key, query, ...(options ? { options } : {}) });
    },

    il(key, methodToken) {
      return asmCall<string>({ type: 'il', key, token: methodToken });
    },

    async decompile(key, typeFullName) {
      const bytes = bytesOf.get(key);
      if (!bytes) throw new Error(`Assembly "${key}" is not loaded.`);
      const copy = bytes.slice();
      const r = await decRpc().call(
        { type: 'decompile', key: `${key}#${generation.get(key) ?? 0}`, bytes: copy, typeName: typeFullName },
        [copy.buffer],
      );
      if (!r.ok) throw new Error(r.error);
      ready = true;
      const loadMs = r.loadMs ?? runtimeLoadMs;
      timing = { ms: r.ms, ...(loadMs !== undefined ? { loadMs } : {}) };
      return r.result;
    },

    decompilerReady() {
      return ready;
    },

    lastDecompile() {
      return timing;
    },

    dispose() {
      asm?.terminate();
      dec?.terminate();
      asm = null;
      dec = null;
      ready = false;
      bytesOf.clear();
    },
  };
}
