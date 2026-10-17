// Vite config for the editor harness on port 5318: the root config plus its
// own dep cache, so re-optimizing here never touches the shared 5317 server.
// ./node_modules/.bin/vite --config src/editor/vite.harness.config.ts --port 5318 --strictPort
import { defineConfig, mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(
  base,
  defineConfig({
    root: '.',
    cacheDir: 'node_modules/.vite-editor-harness',
    // Scan the harness too, so every Monaco entry is pre-bundled in one pass.
    optimizeDeps: { entries: ['index.html', 'src/editor/harness.html', 'src/assembly/harness.html'] },
    // Other sessions edit the repo while checks run; without this, Vite
    // reloads the harness page mid-test on every unrelated save.
    server: { hmr: false },
  }),
);
