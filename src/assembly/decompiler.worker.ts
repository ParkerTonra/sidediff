// Decompiler worker: hosts the .NET WebAssembly runtime with ICSharpCode.Decompiler
// (decompiler/, built into public/decompiler/_framework). Loaded on first use only.
// DECISIONS.md D19.
import type { DecompilerRequest, DecompilerResponse } from './protocol';

interface Exports {
  SideDiffDecompiler: {
    DecompileType(assembly: Uint8Array, key: string, typeName: string): Promise<string>;
    DecompileModule(assembly: Uint8Array, key: string): Promise<string>;
  };
}

interface DotnetModule {
  dotnet: {
    withDiagnosticTracing(on: boolean): DotnetModule['dotnet'];
    withConfig(config: Record<string, unknown>): DotnetModule['dotnet'];
    create(): Promise<{
      getAssemblyExports(name: string): Promise<Exports>;
      getConfig(): { mainAssemblyName?: string };
    }>;
  };
}

let base = '';
let runtime: Promise<{ exports: Exports; loadMs: number }> | null = null;
let reportedLoad = false;

function start(): Promise<{ exports: Exports; loadMs: number }> {
  if (!base) return Promise.reject(new Error('decompiler worker: no base URL'));
  const t0 = performance.now();
  const url = new URL('_framework/dotnet.js', base).href;
  return (import(/* @vite-ignore */ url) as Promise<DotnetModule>)
    .catch(() => {
      throw new Error(`The decompiler bundle is missing (${url}). Run \`pnpm build:decompiler\`, or use the IL view.`);
    })
    .then(async ({ dotnet }) => {
      const rt = await dotnet.withDiagnosticTracing(false).create();
      const exports = await rt.getAssemblyExports(rt.getConfig().mainAssemblyName ?? 'Decompiler.dll');
      return { exports, loadMs: performance.now() - t0 };
    })
    .catch((err: unknown) => {
      runtime = null; // let a later request try again
      throw err;
    });
}

self.onmessage = async (ev: MessageEvent<DecompilerRequest>) => {
  const msg = ev.data;
  const reply = (r: DecompilerResponse): void => self.postMessage(r);
  try {
    if (msg.type === 'init') {
      base = msg.base;
      runtime ??= start();
      const { loadMs } = await runtime;
      reportedLoad = true;
      reply({ id: msg.id, ok: true, result: 'ready', ms: 0, loadMs });
      return;
    }
    runtime ??= start();
    const { exports, loadMs } = await runtime;
    const t0 = performance.now();
    const api = exports.SideDiffDecompiler;
    const result = await (msg.typeName === null ? api.DecompileModule(msg.bytes, msg.key) : api.DecompileType(msg.bytes, msg.key, msg.typeName));
    const out: DecompilerResponse = { id: msg.id, ok: true, result, ms: performance.now() - t0 };
    if (!reportedLoad) {
      out.loadMs = loadMs;
      reportedLoad = true;
    }
    reply(out);
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
