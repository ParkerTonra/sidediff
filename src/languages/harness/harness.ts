// Manual/browser proof for remote packs: install → highlight. Not part of the
// app bundle (Vite only builds index.html). Served by `vite --port 5320` at
// /src/languages/harness/index.html (CSP + 'wasm-unsafe-eval') and
// /src/languages/harness/nowasm.html (today's index.html CSP, to show the error).
import { monaco } from '../../editor/monaco-setup';
import { createLanguageRegistry } from '../index';

const out = document.getElementById('log') as HTMLPreElement;
const log = (msg: string): void => {
  out.textContent += `${msg}\n`;
};
const id = new URLSearchParams(location.search).get('lang') ?? 'sql';
const SAMPLES: Record<string, string> = {
  sql: "-- top customers\nSELECT c.Name, COUNT(*) AS Orders\nFROM Customer c JOIN SOOrder o ON o.CustomerID = c.BAccountID\nWHERE o.Status = 'N' AND o.OrderTotal > 100.50\nGROUP BY c.Name ORDER BY Orders DESC;",
  json: '{\n  "name": "SideDiff",\n  "version": 1,\n  "dark": true,\n  "nothing": null,\n  "list": [1, 2.5, "three"]\n}',
};

const registry = createLanguageRegistry();
(window as unknown as { registry: typeof registry }).registry = registry;
registry.onChange(() => log(`onChange: ${registry.list().map((l) => `${l.id}${l.installed ? '✓' : ''}`).join(' ')}`));
log(`list: ${JSON.stringify(registry.list())}`);

const editor = monaco.editor.create(document.getElementById('editor') as HTMLElement, {
  value: SAMPLES[id] ?? '',
  language: 'plaintext',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: false },
});

async function run(): Promise<void> {
  for (const b of ['csharp', 'xml'] as const) {
    const tb = performance.now();
    await registry.ensureLoaded(b);
    const probe = b === 'csharp' ? 'using PX.Data;' : '<Graph name="x"/>';
    log(`ensureLoaded(${b}) ${Math.round(performance.now() - tb)} ms → ${JSON.stringify(monaco.editor.tokenize(probe, b)[0]?.map((t) => t.type))}`);
  }
  const t0 = performance.now();
  const res = await registry.install(id);
  log(`install(${id}) → ${JSON.stringify(res)} in ${Math.round(performance.now() - t0)} ms`);
  if (!res.ok) {
    document.body.dataset.result = 'error';
    return;
  }
  await registry.ensureLoaded(id);
  const model = editor.getModel();
  if (model) monaco.editor.setModelLanguage(model, id);
  const toks = monaco.editor.tokenize(SAMPLES[id] ?? '', id);
  log(`tokens line 2: ${JSON.stringify(toks[1]?.slice(0, 8))}`);
  document.body.dataset.result = 'ok';
}
run().catch((err: unknown) => {
  log(`threw: ${err instanceof Error ? err.message : String(err)}`);
  document.body.dataset.result = 'error';
});
