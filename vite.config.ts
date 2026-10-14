import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  // Pre-bundle the lazily imported TextMate deps up front, so the first pack install
  // in dev doesn't hit a 504 "Outdated Optimize Dep" from a mid-session re-optimize.
  optimizeDeps: {
    include: ['vscode-textmate', 'vscode-oniguruma'],
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
