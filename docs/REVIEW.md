# Review

Checklist of findings grouped by owner. `[ ]` open, `[x]` resolved. Reviewer: sections 3, 8, 9 of `GOAL-PROMPT.md` and `docs/INTERFACES.md`. Each pass says what was **run** and what was only **read**.

## Pass 3 (HEAD 9de3e3d: project explorer, item views, whole-text undo)

Legend: **R** = I ran it (Playwright; dev server on 5317 and a production build served by `vite preview` from a temp dir), **r** = read only. Test data: `fixtures/project-a.xml` / `project-b.xml`, `large-*.xml`, `csharp-large-*.cs`. I did not open any real export.

### Verdict
The explorer and undo meet acceptance 1 to 7 as far as I could check. No blockers. Three low accessibility items for the UI (announcements for screen readers) and nothing for Editor, Languages or QA.

### Passes
- **R Network.** Cold load of `/`: zero non-localhost requests (dev and production). After loading the project pair (indexing runs): still zero. Workers are same-origin (`project.worker`, `diff.worker`, `editor.worker`). The `Page` item opened (base64 raw-deflate decoded with `DecompressionStream`) with no console error, so the CSP needs nothing more. CSP unchanged: `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self' https://cdn.jsdelivr.net`, `worker-src 'self' blob:`.
- **R Bundle** (`vite build` to temp): initial JS 3,097 KB raw / 789 KB gzip (3 MB warning limit). Lazy: `csharp` 1.7 KB gz, `xml` 0.7 KB, `monaco-bundled` 0.3 KB, `monaco-bridge` 25 KB, `onig.wasm` 162 KB, workers `editor` 93 KB, `diff` 34 KB, `project` 5.8 KB. Only csharp and xml language modules; no other `languages/definitions` registrations.
- **R Acceptance 1 and 2.** Fixture pair: drawer shows `174 items, 39 changed`, groups Code, Screens, Tables, SQL and others with per-status counts, "Versions differ A 24.212 to B 25.201" header. An only-in-A code file opens with A's C# and "Not in B" on the right.
- **R Acceptance 3.** Enter on a row opens the item; crumb reads `Project / Code / only in A / name / path / C# | XML / Show in project / prev 2 / 39 next`. Alt+Left and Esc both return; the tree cursor and focus survive Back. Page item (ASPX view) opens.
- **R Acceptance 4.** Ctrl+P: focus lands in the input, typing `po` gives 60 results, Down moves `aria-activedescendant`, Enter opens the item.
- **R Acceptance 5 (large pair, sha256 compare).** Clear B then Ctrl+Z restores B identical; Ctrl+Y clears again. Swap then Ctrl+Z undoes both text and labels in one step. A file load over B undoes. Typing `zzz` then Ctrl+Z restores B (Monaco stack first).
- **R Acceptance 6.** Large pair (1,873 items, 767 changed): explorer appears 961 ms after setting both files, one long task of 57 ms in the whole run.
- **R Acceptance 7.** C# pair: no drawer, no explorer button, no breadcrumb.
- **R Robustness / injection.** A class name of `"><img src=x onerror=alert(1)>` renders as text (no injected node, no dialog); a truncated project shows "Could not fully scan A: ... Showing the items found so far." and lists the items found; project vs plain text, empty root and CRLF without an XML header do not throw (no console errors).
- **R Keyboard.** Tab order: explorer toggle, toolbar, `?`, filter, four chips, then the tree (a single tab stop using `aria-activedescendant`). Down/Up, Home/End, Left (collapses the group), Right, type-ahead (a letter jumps to the filter and is typed), Enter opens. Focus stays in the tree after opening an item and after Back, so keyboard flow is not interrupted.
- **R Contrast, both themes (WCAG 4.5:1 text).** Status glyphs: dark modified 8.9, whitespace 5.9, only-A 6.2, only-B 7.7, same 6.4; light 5.3, 5.7, 6.0, 4.6, 6.0. Detail text, group totals and dimmed "same" names 6.0 to 6.4. Chips 7.0 / 6.3. Toast 13.1 / 16.5. Every status also has a distinct glyph shape (`~ = - +`) and the row's accessible name spells the status out, so colour is never the only cue. Control borders now meet 3:1: dark `#858585` is 3.2 to 4.2 on its backgrounds, light `#7a7a7a` is 3.4 to 4.3.
- **R Re-check of earlier fixes.**
  - `b6c50ff` pane button names (`Copy all of side A: <label>`, contain the visible word) and `Prev change` label: OK in the source; border contrast OK (above).
  - `af1d529` keyboard trap: after Ctrl+M, Tab leaves the editor (A to B to the toolbar) and Shift+Tab walks back; Tab without Ctrl+M still inserts spaces, as in any code editor. OK, with the documented Ctrl+M.
  - `52254c8` (word wrap on side A after inline view) and `6eb9dc6` (dedicated diff worker cancels superseded runs): reviewed the diffs and exercised them indirectly (diff worker loads same-origin; large pair diff, option changes and item views run with no console errors). I did not write a specific repro for the wrap-after-inline case.
- **r Code hygiene.** `rg "as any|@ts-ignore|eslint-disable"` in `src/` found none; no `innerHTML` (the DOM helper builds text nodes and attributes). `fetch` only in the pack install and the same-origin wasm load.

### Findings

**UI / UX (`src/app/index.ts`)**
- [ ] **Low, a11y.** Opening an item or going Back gives a screen reader no announcement: focus deliberately stays in the tree and nothing live changes (the breadcrumb is not a live region). Fix: write a short message into an existing polite live region on open and Back (for example "Opened APInvoiceRoute2.cs, only in A. Press Alt+Left to go back." / "Back to project"), keeping focus where it is.
- [ ] **Low, a11y (needs a screen reader to confirm; I only read the code).** The toast (`index.ts:240-243`, `438-443`), the degraded banner, `itemLoading` and the install message are `role=status` elements toggled with the `hidden` attribute, and their text is set in the same tick that they are un-hidden. Many screen readers do not announce a live region that appears already populated. Fix: keep the element in the DOM at all times (`visually-hidden` when empty), and set `textContent` after it is rendered.
- [ ] **Low, a11y.** The breadcrumb `<nav aria-label="Item view">` (`index.ts:226`) has the same label as the Code/XML group inside it (`index.ts:220`). Rename the nav to "Item breadcrumb" and set `aria-current="page"` on the item name.

**Editor / Languages / QA / Lead**
- No findings.

### Not verified in pass 3
Screen-reader output (names and roles read from the DOM only); the user's real export (not opened, by instruction); the 11th-replacement history cap and the 300 MB limit; undo while an item view is open; a repro for `52254c8`; `pnpm bench` and `pnpm e2e` (taken from the Lead's and QA's reports in STATUS.md).

## Pass 2 (history) (HEAD 2d98056: engine, app shell, registry, bench and e2e landed)

Legend: **R** = I ran it, **r** = I only read it or took it from another agent's report.

### Verdict
All section 3 P0 features, the section 8 gate and the network and bundle rules check out. One real accessibility blocker (keyboard trap in the editors), a few minor a11y issues and one dev-only glitch. Nothing found that breaks section 9.

### Passes
- **R Cold load, zero third-party requests.** Production build served by `vite preview` and `pnpm dev` (port 5317): 167 requests on a dev cold load, none outside `localhost`. No console errors or warnings, `#app[data-ready=true]`, `data-theme=dark`.
- **R Language install through `/`.** Production build, **+ Language** dialog, Install SQL: the only non-local request is `https://cdn.jsdelivr.net/gh/microsoft/vscode@1.140.0/extensions/sql/syntaxes/sql.tmLanguage.json` (plus same-origin `onig-*.wasm`). SQL highlights in vs-dark (6 distinct token colors: comment, keyword, number, operator, string, plain). After a reload the language is still `sql`, setting text highlights (5 colors) and there are **zero** non-local requests (served from IndexedDB). No console errors with the CSP `wasm-unsafe-eval` in place.
- **R Bundle audit** (`vite build --outDir <temp>`, 812 modules): initial JS `index-*.js` 3,060 KB raw / **785 KB gzip** (warning threshold 3 MB gzip). Lazy chunks: `csharp` 1.7 KB gz, `xml` 0.7 KB gz, `monaco-bundled` 0.3 KB, `monaco-bridge` (vscode-textmate) 25 KB gz, `onig.wasm` 162 KB gz, `editor.worker` 93 KB gz, `codicon.ttf` 153 KB. Only one worker and no `json`/`typescript`/`css`/`html` workers or language modules. `definitions/` matches: only `icons` (the codicon feature).
- **R Contrast, computed from the live DOM in both themes** (WCAG, text needs 4.5):
  | Pair | Dark | Light |
  |---|---|---|
  | body text on page | 13.1 | 16.5 |
  | muted text on toolbar | 6.4 | 6.0 |
  | button text on button | 10.8 | 16.5 |
  | stat added / removed / modified on stats bar | 7.7 / 6.2 / 8.9 | 4.6 / 6.0 / 5.3 |
  | focus ring on toolbar / on editor | 7.4 / 8.0 | 4.8 / n/a |
  | accent button text | 7.0 | 6.3 |
  | warning / error banners | 8.6 / 9.4 | 8.4 / 8.2 |
  Light `--added` on the stats bar is the lowest text value at 4.58 (passes). Diff line backgrounds are Monaco defaults (translucent red/green overlays, text stays above 7:1 over them in dark).
- **R Keyboard-only tab order** (toolbar then headers): Diff only, Context, View, Language, Trim, Ignore all, Wrap, Minimap, Font, + Language, Theme, `?`, Label A, Open A, Copy A, Clear A, Swap, Label B, Open B, Copy B, Clear B, then the editor. Logical, every stop shows the 2 px focus ring. Prev/Next are skipped when there are no changes (disabled). Cheat sheet dialog takes focus and Esc closes it.
- **R Layout.** No horizontal scroll at 1600, 1024 and 700 px; the toolbar wraps.
- **R Screenshots read:** dark and light large diff, light intra-line highlight visible.
- **r Gates and e2e.** Bench numbers (all PASS, 785 KB initial JS), 25/25 e2e and `pnpm check` (103 tests) are from STATUS.md; I re-ran `pnpm check` (7 files, 103 tests, pass) but not bench or e2e.
- **r Code hygiene.** No `as any`, `@ts-ignore` or `eslint-disable` in `src/` (the only `as unknown as` casts are in dev-only `harness.ts`, `behaviour-check.ts`, `perf-gate.ts`, none in the built bundle). No `innerHTML`, `eval`, `new Function` in app code. `fetch` only in `src/languages/index.ts:45` (install, manifest-bound) and `monaco-bridge.ts:26` (same-origin wasm). Monaco imports go only through `monaco-setup.ts`, no barrel.

### Findings, most severe first

**Editor (`src/editor/monaco-setup.ts`)**
- [ ] **High, a11y (WCAG 2.1.2 keyboard trap).** Once focus is in a pane it cannot be moved with the keyboard. Repro (R, production build): click into pane A, press Tab three times, Esc, Tab, Ctrl+M, Tab, Shift+Tab, Ctrl+Shift+M: focus never leaves `native-edit-context`, and Tab inserts spaces (pane A text went from `x` to `x` + 19 spaces). Cause: the `toggleTabFocusMode` feature is not imported (D9 list), so Monaco's Ctrl+M escape hatch does not exist. Fix: add `import 'monaco-editor/features/toggleTabFocusMode/register';` (exists in 0.57) in `monaco-setup.ts`, verify Ctrl+M then Tab reaches the toolbar/next control, and ask the UI to add "Ctrl+M  Tab moves focus out of the editor" to the cheat sheet and `docs/SHORTCUTS.md` (I will add it to SHORTCUTS.md once it lands).

**UI / UX (`src/app/index.ts`, `src/styles/app.css`)**
- [ ] **Medium, a11y.** Pane buttons have the same accessible name in both headers. `index.ts:98-100` (`Open…`, `Copy`, `Clear`) rely on `title`, so a screen reader hears "Copy" twice. Fix: `aria-label` such as `Copy all of side A`, keeping the visible text (the label must contain the visible word, WCAG 2.5.3).
- [ ] **Low, a11y (label in name).** `index.ts:63-64` `aria-label="Previous change"` / `"Next change"` while the visible text is `↑ Prev` / `Next ↓`; speech-control users saying "click Prev" fail. Fix: `aria-label="Prev change"` / `"Next change"` or drop the aria-label and put `<span class="visually-hidden">` text after the visible one.
- [ ] **Low, a11y (WCAG 1.4.11, non-text contrast).** Control borders are 1.24 to 1.67:1 (`--border` `#3c3c3c` on `#2d2d30` in dark, `#c8c8c8` on `#fff` in light) against the 3:1 needed to see where inputs, selects and buttons end. Fix: a stronger `--border-control` (about `#6b6b6b` dark, `#8a8a8a` light) for inputs, selects, buttons; keep the faint one for dividers.

**Lead (`vite.config.ts`)**
- [ ] **Low, dev only.** In `pnpm dev`, the first **Install** after the dev cache was built fails with "Failed to fetch dynamically imported module: .../monaco-bridge.ts" and two 504 "Outdated Optimize Dep" responses, because `vscode-textmate` and `vscode-oniguruma` are discovered lazily and trigger a re-optimize. The second attempt works, and the production build is fine. Fix: `optimizeDeps: { include: ['vscode-textmate', 'vscode-oniguruma'] }` in `vite.config.ts`.
- [ ] **Info.** There is no single-file build or `dist-single/` script yet (P2); its CSP is left to the Lead (see Pass 1). `window.__sidediff` is exposed in production by design (tests); fine.

**Languages / QA**
- No findings. The pack pipeline matches D5 and the install network check matches section 6. QA's e2e fail on any non-localhost request, which covers section 9 line 13.

### Not verified in pass 2
`pnpm install` from a clean clone on Windows; `pnpm bench` and `pnpm e2e` re-run (Lead did e2e: 25/25); the light-theme look of syntax colors by eye beyond the one screenshot; screen-reader behaviour (only the accessibility tree and names were read from source); the P2 single-file build (does not exist); Add-language error paths (hash mismatch and so on are unit-tested, not driven through the UI).

## Pass 1 (history)

All pass 1 action items were resolved by their owners (see the `[x]` Bugs in STATUS.md); the text below is kept as a record only.


### State of the checkout
Almost everything is still a Phase 0 stub, so most of sections 3, 8 and 9 cannot be reviewed yet. Not yet reviewable: DiffEngine, LanguageRegistry, the app shell and all `data-testid`s, CSS (so no contrast numbers), shortcuts, perf marks, fixtures, bench.

### Verified by running
- Dev server on port 5322 plus Playwright: the page loads, `data-theme="dark"` is set in `index.html`, and the only visible content is `SideDiff failed to start: createDiffEngine: not implemented yet` (expected for the stub). **No requests outside `localhost:5322`.** Console: one `console.error` (the same stub error), no page errors.
- `vite build --outDir <temp>`: builds, but `monaco-setup.ts` is not imported from anywhere yet, so the output is a 1.1 KB chunk and **the bundle language audit cannot be done yet** (the Lead's Phase 0 note in D3 claims csharp+xml only and 696 KB gzipped for the proof build; I have not reproduced it).
- `.gitignore` ignores `fixtures/*.xml|cs|txt`; `*.changes.json` stays tracked (good).

### Verified by reading
- `eslint.config.js` has `no-explicit-any: error`. `rg "as any|: any"` in `src/`: none.
- `src/editor/monaco-setup.ts` imports `monaco-editor/editor/editor.api` plus the csharp and xml `register` modules only (no barrel). Matches D3.
- `index.html` CSP: `default-src 'self'`, `connect-src 'self' https://cdn.jsdelivr.net`, `style-src 'unsafe-inline'` (Monaco needs it), `worker-src 'self' blob:`. Good.
- `src/persist/settings.ts`: key `sidediff:settings:v1`, field-by-field merge over defaults, `contextLines` clamped 0 to 20, corrupt JSON and blocked storage fall back, pane text never stored, unit-tested (`settings.test.ts`, not run by me).

## Lead / Integrator
- [ ] `index.html:5` CSP `script-src 'self'` will block the inline script of the P2 single-file build (`dist-single/`). Pick a hash/nonce approach or relax the CSP for that build only, and say so in DECISIONS.md.
- [ ] `docs/INTERFACES.md` engine section omits `getPosition()`, `isComputing()`, `focus(side)`, `layout()`, `dispose()` that exist in `src/types.ts:93-104`. Document their semantics (especially what `getPosition()` returns before the first diff) so the UI and QA do not guess.
- [ ] `src/main.ts:13-15` replaces the whole app with text on startup failure and logs via `console.error` only. Fine, but QA's smoke test should assert on it (see QA below).
- [ ] D3 claims "only csharp and xml language chunks"; re-run after the engine lands and record the gzipped initial JS against the 3 MB warning threshold.

## Editor and Diff Core
Nothing to review yet (`src/editor/index.ts` throws). Things the first review pass will check, so they can be built in from the start:
- [ ] `ignoreAllWhitespace` has no native Monaco diff option (`ignoreTrimWhitespace` only trims leading/trailing). The displayed text must stay unchanged, so the approach needs thought early (custom diff via `diffProviderFactoryService`, or comparing normalized models while showing originals, which breaks line mapping if lines are removed). Record the choice in DECISIONS.md and add a test that `getText()` is unchanged.
- [ ] `diff:start` must also fire on option changes that recompute (`ignoreTrimWhitespace`, `ignoreAllWhitespace`), not only on content changes, or the progress UI will not show.
- [ ] All seven events and all `sidediff:*` marks from INTERFACES.md present, including `diffonly-done` after the next rendered frame.
- [ ] Degraded mode: `diff:error` within 60 s, `maxComputationTimeMs: 0` does not hang the worker on the `stress` pair; `degraded` emits `null` when leaving.
- [ ] `Alt+Up/Down` must not move lines in the editable panes (see SHORTCUTS.md). The engine should provide the next/prev entry points; the UI owns the key handling, but check whether Monaco's `editor.action.moveLinesUp/Down` need `addCommand`-level suppression, since capture-phase `stopPropagation` on `document` happens before Monaco's own keydown on its textarea only if the UI handler runs first.

## UI / UX
Reviewed: `src/persist/settings.ts`, `src/app/dom.ts`. App shell not written yet.
- [ ] `src/persist/settings.ts:77` `language` accepts any non-empty string. On load, the UI must tolerate an id that is no longer registered or installed (for example a remote pack later removed): catch the `ensureLoaded` rejection, fall back to `plaintext`, and do not crash startup.
- [ ] `src/persist/settings.ts:46` label whitespace is trimmed and an empty label reverts to the default on the next load; make the label input do the same on blur so the UI and the stored value agree.
- [ ] `src/app/dom.ts:31-34` `isTextTarget` includes `select`, `.monaco-editor` (including its find widget). Good for `?`; make sure `Alt+H`, `F7` and `Alt+Up/Down` do **not** use this guard, or they will be dead while a pane has focus (the common case).
- [ ] Copy pane: `navigator.clipboard.writeText` needs a secure context and permission; localhost is fine, but a `file://` or plain-http LAN deploy fails. Add a fallback or a visible error, and verify copying 10 MB.
- [ ] A11y checklist for when the shell lands: every control has a visible label or `aria-label` (icon buttons, both number inputs, the file inputs), `btn-diff-only` uses `aria-pressed`, `progress` has `role="status"` or `aria-live="polite"`, dialogs trap focus and return it on close, visible `:focus-visible` ring in both themes, tab order follows toolbar then panes then stats, text contrast at least 4.5:1 (3:1 for large text and UI borders) in both themes, computed from the CSS custom properties.
- [ ] Not reviewable yet: `data-testid` coverage (list in INTERFACES.md), shortcut registration, drag-and-drop, theme persistence, `stat-*` `data-value` plain digits.

## Languages
Nothing to review yet (`src/languages/index.ts` throws, `languages/` is empty).
- [ ] `languages/manifest.json` must exist and be reachable at runtime (`public/` or import). The registry must make **zero** network calls in `list()`, `get()`, `detect()`, `ensureLoaded()`; only `install(id)` may fetch, only a manifest URL, and the URL host must be `cdn.jsdelivr.net` (matches CSP).
- [ ] Validator: size check on bytes **before** `JSON.parse` (and ideally via `Content-Length` plus a streamed cap, not after buffering an unbounded body); hash computed over the raw bytes, not the re-serialized JSON.
- [ ] Unit tests for oversized, malformed and hash-mismatched packs, each asserting the registry is unchanged.
- [ ] Fill in the "Adding a language pack" section: tell the Reviewer the final `format`, schema and the command to compute the hash so `docs/README.draft.md` can be finished.

## QA / Performance
- [ ] `tests/e2e/smoke.spec.ts` only listens for `pageerror`. The stub's startup failure is a caught error logged with `console.error` and rendered as text, so the test passes against a dead app. Also assert `#app` does not contain "failed to start" and that `[data-testid=editor]` exists once the shell lands, and fail on `console.error`.
- [ ] Add a network-audit test: record every request during paste, diff, theme toggle, reload, and assert all URLs are same-origin (the Reviewer will cross-check with the language-install flow).
- [ ] Byte-identical test for "diff only": `engine.getText()` for both sides before enabling, while on, and after disabling.
- [ ] Not reviewable yet: fixtures, bench, `*.changes.json` tolerance logic.

## Bundle audit
Pending: needs the engine to import `monaco-setup.ts`. Procedure for the next pass: `./node_modules/.bin/vite build --outDir <temp outside repo>`, list `assets/*` chunk names and sizes, grep them for other `languages/definitions/*` registrations, and gzip the initial JS.

## Contrast
Pending: no stylesheet yet. Next pass computes WCAG ratios for text/background, muted text, borders, focus ring, the diff add/remove highlights and the stats colors from the CSS custom properties, in both themes.
