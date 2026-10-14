// Composition root. Owned by the Lead.
import { createDiffEngine } from './editor';
import { createLanguageRegistry } from './languages';
import { createApp } from './app';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

try {
  const engine = createDiffEngine();
  const registry = createLanguageRegistry();
  window.__sidediff = { engine, registry };
  createApp({ root, engine, registry });
} catch (err) {
  root.textContent = `SideDiff failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
}
