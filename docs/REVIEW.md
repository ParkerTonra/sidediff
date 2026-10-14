# Review

Checklist of findings grouped by owner. `[ ]` open, `[x]` resolved. Reviewer: sections 3, 8, 9 of `GOAL-PROMPT.md` and `docs/INTERFACES.md`. Each pass says what was **run** and what was only **read**.

## Pass 1 (baseline `0f7bc1d` plus uncommitted `src/persist/`, `src/app/dom.ts`, `scripts/lib/`)

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
