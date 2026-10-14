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

## D6. The engine owns Monaco's diff provider (Editor)
`src/editor/diff-provider.ts` replaces Monaco's `diffProviderFactoryService` through `StandaloneServices.initialize({ diffProviderFactoryService })`, called at module load in `monaco-setup.ts` (before anything else can initialize Monaco's services; only the first `initialize` call honours overrides). The diff still runs in Monaco's editor web worker via `IEditorWorkerService.computeDiff(…, 'advanced')`, the same call Monaco makes; the override only wraps it, which gives exact compute timing for `diff:start`/`diff:done`, ignore-all-whitespace, line-level-only results in degraded mode, and empty-side shortcuts that never reach the worker. Typed in `src/editor/monaco-internals.d.ts`; re-check those shapes on every Monaco upgrade. No main-thread fallback: one worker (`editor.worker.js`) is created and no "Could not create web worker" warning appears; the longest main-thread task during a 150k diff is 0 ms.

## D7. "Ignore all whitespace" diffs hidden shadow models (Editor)
Monaco has no such option. When it is on, the provider keeps a hidden model per side with every non-newline whitespace character removed (`/[^\S\r\n]+/g`), diffs those in the worker, and maps the result back: line numbers are identical because no line breaks are removed, and intra-line ranges are mapped column by column to the real text (`mapStrippedColumn`). The visible models, and so `getText()`, are never touched (tested). Shadows are rebuilt from the real text when a side changed and are disposed once the option is off.

## D8. Diff time budget 10 s (30 s degraded) instead of unlimited (Editor)
With `maxComputationTimeMs: 0`, two unrelated 150k-line files (every line differs) ran past the 60 s watchdog and blocked the shared worker for every later diff. Real edits on the 150k fixture finish in about 0.7 s, so the budget is 10 s normally and 30 s in degraded mode; past it Monaco returns an approximate result and `DiffStats.quitEarly` is true (measured: unrelated pair done in 10.3 s, quitEarly, no main-thread long task; the next diff runs normally). The engine also emits `diff:error` if no result arrives within 60 s.

## D9. Editor features, models and Monaco patches (Editor)
- `editor.api` has no editor contributions, so `monaco-setup.ts` also imports the `features/*/register` modules for codicon (the font; without it the diff-only separators render empty boxes), diffEditor, find, folding, bracketMatching, clipboard, contextmenu, cursorUndo, multicursor, wordOperations, linesOperations and gotoLine. Still no barrel; initial JS is 785 KB gzipped, language chunks still only csharp and xml.
- The DiffEditor forces `minimap` and `folding` off on both sides on every `updateOptions`; the engine sets them on the two sub-editors right after.
- Monaco's `Alt+Up/Down` (move lines) and `F7/Shift+F7` (accessible diff viewer) bindings are removed so the UI's navigation shortcuts own those keys.
- `setText` builds a new model instead of `setValue`: Monaco decides large-file tokenization only at model construction (off above 20 MB or 300k lines). Two `setText` calls in one task are attached with one `setModel`, so the worker never diffs the new A against the old B.
- Changing `contextLines` re-attaches the models (fresh view model): Monaco otherwise carries old visible ranges into the new unchanged regions and a smaller context never re-collapses.
- A single click on "N hidden lines" expands the region (Monaco needs a double click).
- `src/editor/monaco-patches.ts` coalesces `ViewOverlayWidgets._updateMaxMinWidth` to once per microtask. It rescans all overlay widgets on every add, which is O(N²) in the number of collapsed regions: loading the large pair with diff only on had a 358 ms task, now 131 + 180 ms; the diff-only toggle went from 519 to about 300 ms.
- `content.bytes` counts UTF-16 code units (`model.getValueLength()`): equal to UTF-8 bytes for ASCII, O(1) per keystroke. The 40 MB degraded threshold uses the same count.
