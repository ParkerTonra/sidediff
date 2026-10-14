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

## D5. Remote language packs are TextMate `.tmLanguage.json` (Languages)
**Choice:** `format: "tmlanguage-json"`, tokenized by `vscode-textmate@9.3.2` + `vscode-oniguruma@2.0.1` (WASM shipped with the app as a hashed asset), bridged to Monaco with `setTokensProvider`. Bundled `csharp`/`xml` stay on Monaco's Monarch tokenizers.
**Why not Monarch-as-JSON:** there is no pinned, MIT-licensed public source of Monarch grammars as pure JSON (Monaco's own are TS/JS modules with regex literals and functions), so we would have to author and host them ourselves, which defeats the "pinned public repo" rule. TextMate grammars from `microsoft/vscode` are plain JSON data, MIT, and are what VS Code itself runs; oniguruma gives exact regex semantics instead of a lossy Oniguruma→JS-regex translation.
**Manifest delivery:** `languages/manifest.json` is statically imported into the bundle (`src/languages/index.ts`), so the allowlist is fixed at build time and `list()` is synchronous. `createLanguageRegistry({ manifestUrl })` can override it for testing. Manifest rules enforced in code: ids not bundled, license `MIT`, URL `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<semver tag or 40-char sha>/…json` (no `@latest`/branches), 64-hex sha256.
**Packs pinned:** SQL and JSON from `microsoft/vscode@1.140.0` `extensions/{sql,json}/syntaxes/`. Hashes computed from jsDelivr downloads and cross-checked against `raw.githubusercontent.com` at the same tag (identical).
**Install pipeline:** manifest-only id → fetch (`credentials: omit`, `redirect: error`, 30 s timeout) → < 2 MB by Content-Length and by streamed byte count → UTF-8 → `JSON.parse` → TextMate schema check (scopeName, patterns, typed rule keys, depth/rule caps) → SHA-256 of the raw bytes (WebCrypto) → compile in vscode-textmate (bad regex fails here) → IndexedDB `sidediff-languages/packs` key `${id}@${sha256}` → register → `onChange`. Cached packs are re-verified (schema + hash) on every load; a bad cache entry is deleted. Without IndexedDB, installs last for the session.
**Cost:** onig.wasm is 473 KB (162 KB gz) and vscode-textmate an 84 KB (25 KB gz) chunk, both loaded only when a remote pack activates; bundled activation uses a separate 0.4 KB chunk. **Needs `'wasm-unsafe-eval'` in the page CSP `script-src`** (verified: without it Chromium refuses `WebAssembly.instantiate` and `install` returns a readable error). Requested in STATUS.md. In the single-file build the WASM URL is a `data:` URL, which the bridge decodes itself rather than `fetch()`ing (CSP `connect-src` would block it).
