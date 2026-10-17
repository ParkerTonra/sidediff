// Composition root. Owned by the Lead.
import { createDiffEngine } from './editor';
import { createLanguageRegistry } from './languages';
import { createProjectIndexer } from './project';
import { createPackageReader } from './package';
import { createApp } from './app';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

try {
  const engine = createDiffEngine();
  const registry = createLanguageRegistry();
  // JSON and SQL views use their packs once installed.
  const project = createProjectIndexer({ languageAvailable: (id) => registry.get(id)?.installed === true });
  const packages = createPackageReader();
  window.__sidediff = { engine, registry, project };
  createApp({ root, engine, registry, project, packages, views: engine, history: engine });
} catch (err) {
  root.textContent = `SideDiff failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
}
