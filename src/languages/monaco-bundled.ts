// Bundled csharp/xml/plaintext → Monaco. Dynamically imported by index.ts so
// the registry tests never load Monaco.
import { monaco } from '../editor/monaco-setup';

const PROBES: Record<string, string> = { csharp: 'using', xml: '<a>' };

/**
 * csharp/xml are registered lazily by monaco-setup; `editor.tokenize` asks
 * Monaco to create the tokenizer. Wait until it actually produces tokens so
 * the first highlight after setLanguage isn't a frame of plain text.
 */
export async function activateBundled(id: string): Promise<void> {
  const probe = PROBES[id];
  if (!probe) return; // plaintext is built into Monaco
  const deadline = Date.now() + 5000;
  for (;;) {
    const line = monaco.editor.tokenize(probe, id)[0];
    if (line?.some((t) => t.type !== '')) return;
    if (Date.now() > deadline) {
      console.warn(`[languages] ${id} tokenizer not ready after 5 s; continuing`);
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
