# Decisions

Locked decisions are in `GOAL-PROMPT.md` section 2. This file records deviations and choices the agents made.

## D1. pnpm via corepack, shim in the user folder (Lead, Phase 0)
`corepack enable` can't write to `C:\Program Files\nodejs` without admin rights, so the pnpm shim lives in `%APPDATA%\npm` (already on PATH). `package.json` pins `"packageManager": "pnpm@12.11.2"`.

## D2. TypeScript pinned to ~6.0 (Lead, Phase 0)
TypeScript 7.0 is current, but typescript-eslint 8.71 requires `<6.1.0`. We pin `typescript@~6.0.3` until typescript-eslint supports 7.

## D3. Monaco 0.57 import paths (Lead, Phase 0)
monaco-editor 0.57 ships an `exports` map (`"./*": "./esm/vs/*.js"`), so `monaco-editor/esm/vs/editor/editor.api` can't be resolved. The same file is imported as `monaco-editor/editor/editor.api`. The languages moved from `basic-languages/<id>/<id>.contribution` to `languages/definitions/<id>/register`. The intent of the locked decision is unchanged: editor API plus only the csharp and xml registrations, never the barrel. Phase 0 build check: `dist/assets` contains only `csharp-*.js` and `xml-*.js` language chunks; the main chunk is 696 KB gzipped.

## D4. Dev port 5317 (Lead, Phase 0)
Port 5173 is in use on the dev machine, so `pnpm dev` uses 5317 with `--strictPort`.
